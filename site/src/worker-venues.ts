/**
 * Venues added on the review page, stored in D1 beside the submissions.
 * The scraper lists them with data/venues.yaml, so a gig at a new room can
 * be approved without a commit:
 *
 *   GET  /api/admin/venues       the added venues (ADMIN_TOKEN)
 *   POST /api/admin/venues       add one
 *   POST /api/admin/venues/:id   {action: save|delete, ...fields}
 */

import { validateVenue } from "./submission";
import type { EventsFile, Venue } from "./types";
import {
  invalid,
  jsonResponse,
  methodNotAllowed,
  readBody,
} from "./worker-http";
import { bumpRevision } from "./worker-revision";

export interface VenuesEnv {
  DATA: R2Bucket;
  DB: D1Database;
}

export const ADMIN_VENUES_PATH = "/api/admin/venues";

const COLUMNS = "id, name, address, town, neighborhood, url, jazz_level";

/** The statement that lists the venues added here, by name. */
export function selectVenues(env: VenuesEnv): D1PreparedStatement {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM venues ORDER BY name`);
}

async function storedVenues(env: VenuesEnv): Promise<Venue[]> {
  const { results } = await selectVenues(env).all<Venue>();
  return results;
}

/** Runs a change to the venues, counting it as a change to the feed. */
async function changeFeed(
  env: VenuesEnv,
  statement: D1PreparedStatement,
): Promise<void> {
  await env.DB.batch([statement, bumpRevision(env.DB)]);
}

/** Every listed venue id: the published feed's and those added here. */
export async function listedVenues(env: VenuesEnv): Promise<Set<string>> {
  const [object, stored] = await Promise.all([
    env.DATA.get("events.json"),
    storedVenues(env),
  ]);
  const feed = object ? await object.json<Partial<EventsFile>>() : {};
  return new Set([...(feed.venues ?? []), ...stored].map((venue) => venue.id));
}

/** The statement that adds a venue, to run alone or in a batch. */
export function insertVenue(env: VenuesEnv, venue: Venue): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO venues (${COLUMNS}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    venue.id,
    venue.name,
    venue.address ?? null,
    venue.town,
    venue.neighborhood ?? null,
    venue.url ?? null,
    venue.jazz_level,
    new Date().toISOString(),
  );
}

async function add(
  env: VenuesEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  const checked = validateVenue(body, await listedVenues(env));
  if (!checked.ok) return invalid(checked.errors);
  await changeFeed(env, insertVenue(env, checked.value));
  return jsonResponse(201, { venue: checked.value });
}

async function change(
  env: VenuesEnv,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const exists = await env.DB.prepare("SELECT id FROM venues WHERE id = ?")
    .bind(id)
    .first();
  if (!exists) return jsonResponse(404, { error: "No such venue." });

  if (body.action === "delete") {
    const using = await env.DB.prepare(
      "SELECT title FROM submissions WHERE venue = ? AND status = 'approved'",
    )
      .bind(id)
      .first<{ title: string }>();
    if (using) {
      return jsonResponse(409, {
        error: `“${using.title}” is listed there. Unpublish it or move it first.`,
      });
    }
    await changeFeed(
      env,
      env.DB.prepare("DELETE FROM venues WHERE id = ?").bind(id),
    );
    return jsonResponse(200, { deleted: id });
  }
  if (body.action === "save") {
    const taken = await listedVenues(env);
    taken.delete(id);
    // The id stays: approved listings refer to it.
    const checked = validateVenue({ ...body, venue_id: id }, taken);
    if (!checked.ok) return invalid(checked.errors);
    const v = checked.value;
    await changeFeed(
      env,
      env.DB.prepare(
        `UPDATE venues SET name = ?, address = ?, town = ?, neighborhood = ?,
         url = ?, jazz_level = ? WHERE id = ?`,
      ).bind(
        v.name,
        v.address ?? null,
        v.town,
        v.neighborhood ?? null,
        v.url ?? null,
        v.jazz_level,
        id,
      ),
    );
    return jsonResponse(200, { venue: v });
  }
  return jsonResponse(400, { error: "action must be save or delete" });
}

/** An admin venues request, already authorized; `rest` follows the path. */
export async function adminVenues(
  request: Request,
  env: VenuesEnv,
  rest: string,
): Promise<Response> {
  const all = rest === "" || rest === "/";
  if (all && request.method === "GET") {
    return jsonResponse(200, { venues: await storedVenues(env) });
  }
  if (request.method !== "POST") {
    return methodNotAllowed(all ? "GET, POST" : "POST");
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  return all ? add(env, body) : change(env, rest.slice(1), body);
}
