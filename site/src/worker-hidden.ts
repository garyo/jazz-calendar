/**
 * Listings hidden on request, kept in D1 so the public repo never records
 * who asked. The scraper reads them through /api/registry, without the
 * private note, and drops every source's copy of a match:
 *
 *   GET  /api/admin/hidden       the hidden listings (ADMIN_TOKEN)
 *   POST /api/admin/hidden       hide one: {title?, venue?, night?, note?}
 *   POST /api/admin/hidden/:id   {action: "delete"}, to show it again
 */

import { validateHidden } from "./submission";
import { dayKey } from "./time";
import {
  invalid,
  jsonResponse,
  methodNotAllowed,
  readBody,
} from "./worker-http";
import { bumpRevision } from "./worker-revision";
import { listedVenues, type VenuesEnv } from "./worker-venues";

export const ADMIN_HIDDEN_PATH = "/api/admin/hidden";

/** The statement that lists what the scraper needs: never the note. */
export function selectHidden(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "SELECT title, venue, night, requested FROM hidden ORDER BY id",
  );
}

async function hide(
  env: VenuesEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  const checked = validateHidden(body, await listedVenues(env));
  if (!checked.ok) return invalid(checked.errors);
  const { title, venue, night, note } = checked.value;
  const [inserted] = await env.DB.batch<{ id: number }>([
    env.DB.prepare(
      `INSERT INTO hidden (title, venue, night, requested, note)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ).bind(title, venue, night, dayKey(new Date()), note),
    bumpRevision(env.DB),
  ]);
  return jsonResponse(201, { id: inserted.results[0].id });
}

async function unhide(
  env: VenuesEnv,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const exists =
    /^\d+$/.test(id) &&
    (await env.DB.prepare("SELECT id FROM hidden WHERE id = ?")
      .bind(Number(id))
      .first());
  if (!exists) return jsonResponse(404, { error: "No such entry." });
  if (body.action !== "delete") {
    return jsonResponse(400, { error: "action must be delete" });
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM hidden WHERE id = ?").bind(Number(id)),
    bumpRevision(env.DB),
  ]);
  return jsonResponse(200, { deleted: Number(id) });
}

/** An admin hidden-listings request, already authorized; `rest` follows the path. */
export async function adminHidden(
  request: Request,
  env: VenuesEnv,
  rest: string,
): Promise<Response> {
  const all = rest === "" || rest === "/";
  if (all && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM hidden ORDER BY id DESC",
    ).all();
    return jsonResponse(200, { hidden: results });
  }
  if (request.method !== "POST") {
    return methodNotAllowed(all ? "GET, POST" : "POST");
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  return all ? hide(env, body) : unhide(env, rest.slice(1), body);
}
