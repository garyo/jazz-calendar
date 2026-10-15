/**
 * Gig submissions, stored in D1 (schema in ../migrations):
 *
 *   POST /api/submissions                the public form; Turnstile-checked
 *   GET  /api/admin/submissions?status=  the review queue (ADMIN_TOKEN)
 *   POST /api/admin/submissions/:id      {action: approve|reject, edits}
 *   GET  /api/submissions/approved       upcoming approved gigs for the
 *                                        scraper (PUBLISH_TOKEN)
 *
 * Submitters' names, emails and notes leave D1 only through the admin API.
 */

import {
  type ApprovedGig,
  type FieldErrors,
  STATUSES,
  type Submission,
  type ValidationContext,
  validateApproval,
  validateRejection,
  validateSubmission,
} from "./submission";
import { dayKey } from "./time";
import type { EventsFile } from "./types";
import {
  hasBearer,
  jsonResponse,
  methodNotAllowed,
  unauthorized,
} from "./worker-http";

export interface SubmissionsEnv {
  DATA: R2Bucket;
  DB: D1Database;
  /** The scraper's token; also reads the approved feed. */
  PUBLISH_TOKEN?: string;
  /** The owner's token for the review page. */
  ADMIN_TOKEN?: string;
  /** Turnstile secret key for the submission form's widget. */
  TURNSTILE_SECRET?: string;
}

const SUBMIT_PATH = "/api/submissions";
const APPROVED_PATH = "/api/submissions/approved";
const ADMIN_PATH = "/api/admin/submissions";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY = 16 * 1024;
const MAX_TOKEN = 2048;
const LIST_LIMIT = 200;
const ID = /^[0-9a-f-]{36}$/;

/** Columns the scraper may see; never the submitter's details. */
const PUBLIC_COLUMNS =
  "id, title, date, start_time, end_time, venue, price, url, relevance";

type Body = Record<string, unknown>;

/** A JSON object body of bounded size, or null. */
async function readBody(request: Request): Promise<Body | null> {
  const type = request.headers.get("content-type") ?? "";
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!type.startsWith("application/json") || length > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Body)
      : null;
  } catch {
    return null;
  }
}

function badBody(): Response {
  return jsonResponse(400, { error: "Expected a JSON object under 16 KB." });
}

function invalid(errors: FieldErrors): Response {
  return jsonResponse(400, {
    error: "Some fields need attention.",
    fields: errors,
  });
}

/** Today in Boston, and the venues listed in the published feed. */
async function validationContext(
  env: SubmissionsEnv,
): Promise<ValidationContext> {
  const object = await env.DATA.get("events.json");
  const feed = object ? await object.json<Partial<EventsFile>>() : {};
  return {
    today: dayKey(new Date()),
    venues: new Set((feed.venues ?? []).map((venue) => venue.id)),
  };
}

async function verifyTurnstile(
  token: unknown,
  secret: string,
  ip: string | null,
): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN) {
    return false;
  }
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const response = await fetch(SITEVERIFY, { method: "POST", body: form });
    const outcome = await response.json<{ success?: unknown }>();
    return outcome.success === true;
  } catch {
    return false;
  }
}

async function submit(
  request: Request,
  env: SubmissionsEnv,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!env.TURNSTILE_SECRET) {
    return jsonResponse(503, { error: "Submissions aren’t open yet." });
  }
  const body = await readBody(request);
  if (!body) return badBody();
  const checked = validateSubmission(body, await validationContext(env));
  if (!checked.ok) return invalid(checked.errors);
  const human = await verifyTurnstile(
    body.turnstile,
    env.TURNSTILE_SECRET,
    request.headers.get("cf-connecting-ip"),
  );
  if (!human) {
    return jsonResponse(403, {
      error: "The spam check didn’t go through. Please try again.",
    });
  }
  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ...checked.value,
  };
  const columns = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO submissions (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(row))
    .run();
  return jsonResponse(201, { id: row.id, status: "pending" });
}

async function approvedFeed(
  request: Request,
  env: SubmissionsEnv,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!(await hasBearer(request, env.PUBLISH_TOKEN))) {
    return unauthorized("publish");
  }
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM submissions
     WHERE status = 'approved' AND date >= ?
     ORDER BY date, start_time`,
  )
    .bind(dayKey(new Date()))
    .all<ApprovedGig>();
  return jsonResponse(200, { submissions: results });
}

async function list(url: URL, env: SubmissionsEnv): Promise<Response> {
  const status = url.searchParams.get("status") ?? "pending";
  if (!STATUSES.some((known) => known === status)) {
    return jsonResponse(400, { error: `status must be ${STATUSES.join("|")}` });
  }
  // The queue in date order; reviewed ones most recent first.
  const order =
    status === "pending" ? "date, start_time" : "reviewed_at DESC, date";
  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE status = ? ORDER BY ${order} LIMIT ?`,
  )
    .bind(status, LIST_LIMIT)
    .all<Submission>();
  return jsonResponse(200, { submissions: results });
}

/** Sets columns on one submission and returns it as stored. */
function update(
  env: SubmissionsEnv,
  id: string,
  values: Partial<Submission>,
): Promise<Submission | null> {
  const columns = Object.keys(values);
  return env.DB.prepare(
    `UPDATE submissions SET ${columns.map((c) => `${c} = ?`).join(", ")}
     WHERE id = ? RETURNING *`,
  )
    .bind(...Object.values(values), id)
    .first<Submission>();
}

/** Approve (saving the reviewer's edits) or reject one submission. */
async function review(
  request: Request,
  env: SubmissionsEnv,
  id: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readBody(request);
  if (!body) return badBody();
  const current = ID.test(id)
    ? await env.DB.prepare("SELECT * FROM submissions WHERE id = ?")
        .bind(id)
        .first<Submission>()
    : null;
  if (!current) return jsonResponse(404, { error: "No such submission." });
  const reviewed_at = new Date().toISOString();

  if (body.action === "approve") {
    const checked = validateApproval(
      current,
      body.edits,
      await validationContext(env),
    );
    if (!checked.ok) return invalid(checked.errors);
    const { gig, relevance, editor_note } = checked.value;
    // venue_name and venue_town stay as submitted.
    const submission = await update(env, id, {
      title: gig.title,
      date: gig.date,
      start_time: gig.start_time,
      end_time: gig.end_time,
      venue: gig.venue,
      price: gig.price,
      url: gig.url,
      relevance,
      editor_note,
      status: "approved",
      reviewed_at,
    });
    return jsonResponse(200, { submission });
  }
  if (body.action === "reject") {
    const checked = validateRejection(body.edits);
    if (!checked.ok) return invalid(checked.errors);
    const submission = await update(env, id, {
      editor_note: checked.value,
      status: "rejected",
      reviewed_at,
    });
    return jsonResponse(200, { submission });
  }
  return jsonResponse(400, { error: "action must be approve or reject" });
}

async function admin(
  request: Request,
  env: SubmissionsEnv,
  url: URL,
): Promise<Response> {
  if (!(await hasBearer(request, env.ADMIN_TOKEN)))
    return unauthorized("admin");
  const rest = url.pathname.slice(ADMIN_PATH.length);
  if (rest === "" || rest === "/") {
    return request.method === "GET" ? list(url, env) : methodNotAllowed("GET");
  }
  return review(request, env, rest.slice(1));
}

/** The response for a submissions route, or null for any other path. */
export function routeSubmissions(
  request: Request,
  env: SubmissionsEnv,
  url: URL,
): Promise<Response> | null {
  const { pathname } = url;
  if (pathname === SUBMIT_PATH) return submit(request, env);
  if (pathname === APPROVED_PATH) return approvedFeed(request, env);
  if (pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)) {
    return admin(request, env, url);
  }
  return null;
}
