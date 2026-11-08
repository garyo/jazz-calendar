/**
 * The owner's rulings on acts the scraper's classifier was unsure of. Each
 * run uploads those acts as review.json, which the site never serves
 * publicly; the review page shows the ones not yet ruled on. A ruling goes
 * back to the scraper through /api/registry and settles that act at that
 * venue, over its rules and its classifier:
 *
 *   GET  /api/admin/review    acts awaiting a ruling, and rulings made (ADMIN_TOKEN)
 *   POST /api/admin/rulings   {venue, title, relevance: jazz|adjacent|other},
 *                             or {venue, title, action: "delete"} to undo one
 */

import { type ReviewAct, RULED, type Ruling, titleKey } from "./submission";
import { dayKey } from "./time";
import { jsonResponse, methodNotAllowed, readBody } from "./worker-http";
import { bumpRevision } from "./worker-revision";
import { listedVenues, type VenuesEnv } from "./worker-venues";

export const ADMIN_REVIEW_PATH = "/api/admin/review";
export const ADMIN_RULINGS_PATH = "/api/admin/rulings";
/** The R2 key of the acts awaiting review: ReviewFile in the scraper's models.py. */
export const REVIEW_KEY = "review.json";

const TITLE_LIMIT = 300;

/** The statement that lists the rulings for the scraper, newest first. */
export function selectRulings(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "SELECT venue, title, relevance, decided FROM rulings ORDER BY decided DESC, title",
  );
}

async function pending(env: VenuesEnv): Promise<Response> {
  const [object, rulings] = await Promise.all([
    env.DATA.get(REVIEW_KEY),
    selectRulings(env.DB).all<Ruling>(),
  ]);
  const file = object
    ? await object.json<{ generated_at: string; acts: ReviewAct[] }>()
    : null;
  const ruled = new Set(
    rulings.results.map((r) => `${r.venue}\n${titleKey(r.title)}`),
  );
  return jsonResponse(200, {
    generated_at: file?.generated_at ?? null,
    acts: (file?.acts ?? []).filter(
      (act) => !ruled.has(`${act.venue}\n${titleKey(act.title)}`),
    ),
    rulings: rulings.results,
  });
}

async function rule(
  env: VenuesEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  const { venue, title, relevance, action } = body;
  const errors: Record<string, string> = {};
  if (typeof venue !== "string" || !(await listedVenues(env)).has(venue)) {
    errors.venue = "That venue isn’t listed.";
  }
  const key = typeof title === "string" ? titleKey(title) : "";
  if (!key || key.length > TITLE_LIMIT) errors.title = "Give the act’s title.";
  const deleting = action === "delete";
  if (!deleting && !RULED.some((known) => known === relevance)) {
    errors.relevance = `relevance must be ${RULED.join("|")}`;
  }
  // A ruling's card has no fields to mark, so the reasons are the message.
  if (Object.keys(errors).length) {
    return jsonResponse(400, {
      error: Object.values(errors).join(" "),
      fields: errors,
    });
  }
  if (deleting) {
    const found = await env.DB.prepare(
      "SELECT 1 FROM rulings WHERE venue = ? AND title_key = ?",
    )
      .bind(venue, key)
      .first();
    if (!found) return jsonResponse(404, { error: "No such ruling." });
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM rulings WHERE venue = ? AND title_key = ?",
      ).bind(venue, key),
      bumpRevision(env.DB),
    ]);
    return jsonResponse(200, { deleted: { venue, title } });
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rulings (venue, title, title_key, relevance, decided)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (venue, title_key) DO UPDATE
       SET title = excluded.title, relevance = excluded.relevance,
           decided = excluded.decided`,
    ).bind(venue, (title as string).trim(), key, relevance, dayKey(new Date())),
    bumpRevision(env.DB),
  ]);
  return jsonResponse(200, { ruling: { venue, title, relevance } });
}

/** An admin review or rulings request, already authorized. */
export async function adminRulings(
  request: Request,
  env: VenuesEnv,
  pathname: string,
): Promise<Response> {
  if (pathname === ADMIN_REVIEW_PATH) {
    return request.method === "GET" ? pending(env) : methodNotAllowed("GET");
  }
  if (pathname !== ADMIN_RULINGS_PATH) {
    return jsonResponse(404, { error: "Not found." });
  }
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readBody(request);
  if (body instanceof Response) return body;
  return rule(env, body);
}
