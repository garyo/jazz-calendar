/**
 * Submissions, gigs and regulars, stored in D1 (schema in ../migrations):
 *
 *   POST /api/submissions                the public form; Turnstile-checked
 *   GET  /api/admin/submissions?status=  the review queue (ADMIN_TOKEN)
 *   POST /api/admin/submissions/:id      {action: approve|reject|confirm, edits}
 *   GET  /api/submissions/approved       upcoming approved gigs for the
 *                                        scraper (PUBLISH_TOKEN)
 *   GET  /api/registry                   approved regulars and added venues,
 *                                        for the scraper (PUBLISH_TOKEN)
 *
 * The admin venue routes are in worker-venues.ts. Submitters' names, emails
 * and notes leave D1 only through the admin API. A new submission pings the
 * owner's ntfy topic with just the listing's title, time and venue.
 */

import {
  type ApprovedGig,
  type NewSubmission,
  STATUSES,
  type Submission,
  scheduleText,
  TURNSTILE_ACTION,
  validateApproval,
  validateRejection,
  validateSubmission,
} from "./submission";
import { dayKey } from "./time";
import type { Regular } from "./types";
import {
  hasBearer,
  invalid,
  jsonResponse,
  methodNotAllowed,
  readBody,
  unauthorized,
} from "./worker-http";
import { type NotifyEnv, notify } from "./worker-notify";
import {
  ADMIN_VENUES_PATH,
  adminVenues,
  insertVenue,
  listedVenues,
  storedVenues,
  type VenuesEnv,
} from "./worker-venues";

export interface SubmissionsEnv extends NotifyEnv, VenuesEnv {
  /** The scraper's token; also reads the approved feed. */
  PUBLISH_TOKEN?: string;
  /** The owner's token for the review page. */
  ADMIN_TOKEN?: string;
  /** Turnstile secret key for the submission form's widget. */
  TURNSTILE_SECRET?: string;
}

const SUBMIT_PATH = "/api/submissions";
const APPROVED_PATH = "/api/submissions/approved";
const REGISTRY_PATH = "/api/registry";
const ADMIN_PATH = "/api/admin/submissions";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Where the form is served; Turnstile reports the page's hostname. */
const SITE_HOSTS = [
  "bostonjazzcalendar.com",
  "www.bostonjazzcalendar.com",
  "jazz-calendar.garyo.workers.dev",
];
/** Cloudflare's always-pass, always-fail and spent-token test secrets. */
const TEST_SECRET = /^[123]x0+AA$/;
const MAX_TOKEN = 2048;
const LIST_LIMIT = 200;
const ID = /^[0-9a-f-]{36}$/;

/** Columns the scraper may see; never the submitter's details. */
const PUBLIC_COLUMNS =
  "id, title, date, start_time, end_time, venue, price, url, relevance";

type Row = Record<string, unknown>;

/** Column values, with lists stored as JSON text. */
function columns(values: object): Row {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      Array.isArray(value) ? JSON.stringify(value) : value,
    ]),
  );
}

/** A stored submission, its lists parsed. */
function fromRow(row: Row): Submission {
  const list = (value: unknown) =>
    typeof value === "string" ? JSON.parse(value) : null;
  return { ...row, days: list(row.days), nth: list(row.nth) } as Submission;
}

interface Siteverify {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
}

/**
 * Whether Turnstile vouches for the token: solved by the submission form's
 * widget on one of the site's own hosts. Cloudflare's test secrets answer
 * for "example.com" with no action, so with one of those only success counts.
 */
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
    const outcome = await response.json<Siteverify>();
    if (outcome.success !== true) return false;
    if (TEST_SECRET.test(secret)) return true;
    return (
      outcome.action === TURNSTILE_ACTION &&
      SITE_HOSTS.some((host) => host === outcome.hostname)
    );
  } catch {
    return false;
  }
}

async function submit(
  request: Request,
  env: SubmissionsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!env.TURNSTILE_SECRET) {
    return jsonResponse(503, { error: "Submissions aren’t open yet." });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  // Cheapest first: the fields, then Turnstile, and only then the reads
  // for the venue list, so junk never costs a read.
  const today = dayKey(new Date());
  const fields = validateSubmission(body, { today });
  if (!fields.ok) return invalid(fields.errors);
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
  const checked = validateSubmission(body, {
    today,
    venues: await listedVenues(env),
  });
  if (!checked.ok) return invalid(checked.errors);
  const row = columns({
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ...checked.value,
  });
  const names = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO submissions (${names.join(", ")})
     VALUES (${names.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(row))
    .run();
  notifyNewSubmission(env, ctx, checked.value, new URL("/admin", request.url));
  return jsonResponse(201, { id: row.id, status: "pending" });
}

/** Tells the owner a listing is waiting for review; never delays or fails the response. */
function notifyNewSubmission(
  env: SubmissionsEnv,
  ctx: ExecutionContext,
  gig: NewSubmission,
  adminUrl: URL,
): void {
  const when =
    gig.kind === "regular"
      ? scheduleText(gig)
      : `${gig.date}${gig.start_time ? ` ${gig.start_time}` : ", time TBA"}`;
  const where = gig.venue ?? `${gig.venue_name ?? "?"} (not listed)`;
  ctx.waitUntil(
    notify(env, {
      title: `Boston Jazz Calendar: new ${gig.kind} to review`,
      message: `${gig.title}\n${when} · ${where}`,
      tags: ["musical_note"],
      click: adminUrl.href,
    }),
  );
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
     WHERE status = 'approved' AND kind = 'gig' AND date >= ?
     ORDER BY date, start_time`,
  )
    .bind(dayKey(new Date()))
    .all<ApprovedGig>();
  return jsonResponse(200, { submissions: results });
}

/** An approved regular as the feed lists it. */
function regularOf(s: Submission): Regular {
  return {
    venue: s.venue ?? "",
    title: s.title,
    when: scheduleText(s),
    days: s.days ?? [],
    nth: s.nth ?? [],
    relevance: s.relevance ?? "jazz",
    url: s.url,
    checked: s.checked ?? (s.reviewed_at ?? s.created_at).slice(0, 10),
  };
}

/** The scraper's additions to data/: approved regulars and added venues. */
async function registry(
  request: Request,
  env: SubmissionsEnv,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!(await hasBearer(request, env.PUBLISH_TOKEN))) {
    return unauthorized("publish");
  }
  const [venues, { results }] = await Promise.all([
    storedVenues(env),
    env.DB.prepare(
      `SELECT * FROM submissions
       WHERE status = 'approved' AND kind = 'regular'
       ORDER BY title`,
    ).all<Row>(),
  ]);
  return jsonResponse(200, {
    venues,
    regulars: results.map((row) => regularOf(fromRow(row))),
  });
}

async function list(url: URL, env: SubmissionsEnv): Promise<Response> {
  const status = url.searchParams.get("status") ?? "pending";
  if (!STATUSES.some((known) => known === status)) {
    return jsonResponse(400, { error: `status must be ${STATUSES.join("|")}` });
  }
  // The queue in date order, regulars first; reviewed ones most recent first.
  const order =
    status === "pending" ? "date, start_time" : "reviewed_at DESC, date";
  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE status = ? ORDER BY ${order} LIMIT ?`,
  )
    .bind(status, LIST_LIMIT)
    .all<Row>();
  return jsonResponse(200, { submissions: results.map(fromRow) });
}

/** The statement that sets columns on one submission and returns it. */
function update(
  env: SubmissionsEnv,
  id: string,
  values: Partial<Submission>,
): D1PreparedStatement {
  const row = columns(values);
  return env.DB.prepare(
    `UPDATE submissions SET ${Object.keys(row)
      .map((c) => `${c} = ?`)
      .join(", ")}
     WHERE id = ? RETURNING *`,
  ).bind(...Object.values(row), id);
}

async function saved(statement: D1PreparedStatement): Promise<Response> {
  const row = await statement.first<Row>();
  return jsonResponse(200, { submission: row && fromRow(row) });
}

/** Approve (saving the reviewer's edits), reject, or confirm a regular. */
async function review(
  request: Request,
  env: SubmissionsEnv,
  id: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const row = ID.test(id)
    ? await env.DB.prepare("SELECT * FROM submissions WHERE id = ?")
        .bind(id)
        .first<Row>()
    : null;
  if (!row) return jsonResponse(404, { error: "No such submission." });
  const current = fromRow(row);
  const today = dayKey(new Date());
  const reviewed_at = new Date().toISOString();

  if (body.action === "approve") {
    const checked = validateApproval(current, body.edits, {
      today,
      venues: await listedVenues(env),
    });
    if (!checked.ok) return invalid(checked.errors);
    const { gig, relevance, editor_note, venue } = checked.value;
    // The unlisted venue's details stay as submitted.
    const approve = update(env, id, {
      kind: gig.kind,
      title: gig.title,
      date: gig.date,
      days: gig.days,
      nth: gig.nth,
      start_time: gig.start_time,
      end_time: gig.end_time,
      venue: gig.venue,
      price: gig.price,
      url: gig.url,
      relevance,
      editor_note,
      status: "approved",
      reviewed_at,
      // Approving a regular confirms it's running.
      checked: gig.kind === "regular" ? today : null,
    });
    if (!venue) return saved(approve);
    const [, approved] = await env.DB.batch<Row>([
      insertVenue(env, venue),
      approve,
    ]);
    return jsonResponse(200, { submission: fromRow(approved.results[0]) });
  }
  if (body.action === "reject") {
    const checked = validateRejection(body.edits);
    if (!checked.ok) return invalid(checked.errors);
    return saved(
      update(env, id, {
        editor_note: checked.value,
        status: "rejected",
        reviewed_at,
      }),
    );
  }
  if (body.action === "confirm") {
    if (current.kind !== "regular" || current.status !== "approved") {
      return jsonResponse(400, {
        error: "Only listed regulars are confirmed.",
      });
    }
    return saved(update(env, id, { checked: today }));
  }
  return jsonResponse(400, {
    error: "action must be approve, reject or confirm",
  });
}

async function admin(
  request: Request,
  env: SubmissionsEnv,
  url: URL,
): Promise<Response> {
  if (!(await hasBearer(request, env.ADMIN_TOKEN)))
    return unauthorized("admin");
  const { pathname } = url;
  if (pathname.startsWith(ADMIN_VENUES_PATH)) {
    return adminVenues(request, env, pathname.slice(ADMIN_VENUES_PATH.length));
  }
  const rest = pathname.slice(ADMIN_PATH.length);
  if (rest === "" || rest === "/") {
    return request.method === "GET" ? list(url, env) : methodNotAllowed("GET");
  }
  return review(request, env, rest.slice(1));
}

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The response for a submissions route, or null for any other path. */
export function routeSubmissions(
  request: Request,
  env: SubmissionsEnv,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const { pathname } = url;
  if (pathname === SUBMIT_PATH) return submit(request, env, ctx);
  if (pathname === APPROVED_PATH) return approvedFeed(request, env);
  if (pathname === REGISTRY_PATH) return registry(request, env);
  if (under(pathname, ADMIN_PATH) || under(pathname, ADMIN_VENUES_PATH)) {
    return admin(request, env, url);
  }
  return null;
}
