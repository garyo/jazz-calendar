/**
 * Scraper runs asked for on the review page, kept in D1. The scraper's
 * one-minute refresh finds the oldest queued one in /api/registry, pulls the
 * latest code, carries it out, and reports how it goes:
 *
 *   GET  /api/admin/runs      the latest runs (ADMIN_TOKEN)
 *   POST /api/admin/runs      ask for one: {kind, source?}
 *   POST /api/runs/:id        {status: running|done|failed, error?}, from the
 *                             scraper (PUBLISH_TOKEN)
 *
 * Scraping fetches the venues' pages afresh, so a full run may be asked for
 * only every half hour, and one source every ten minutes. Asking again for a
 * run still queued returns that one.
 */

import { type Run, type RunKind, type RunStatus, validateRun } from "./runs";
import {
  invalid,
  jsonResponse,
  methodNotAllowed,
  readBody,
} from "./worker-http";

export const ADMIN_RUNS_PATH = "/api/admin/runs";
export const RUNS_PATH = "/api/runs";

const SHOWN = 10;
const MINUTE = 60_000;
/** How long after a run is asked for until another of its kind may be. */
const SPACING: Record<RunKind, number> = {
  full: 30 * MINUTE,
  source: 10 * MINUTE,
  rebuild: 0,
};
/** The status each report moves a run on from. */
const REPORTS: Partial<Record<RunStatus, RunStatus>> = {
  running: "queued",
  done: "running",
  failed: "running",
};
const MAX_ERROR = 500;

interface RunsEnv {
  DB: D1Database;
}

/** The statement for the run the scraper should carry out next, if any. */
export function selectQueuedRun(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "SELECT id, kind, source FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1",
  );
}

async function ask(
  env: RunsEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  const checked = validateRun(body);
  if (!checked.ok) return invalid(checked.errors);
  const { kind, source } = checked.value;
  const last = await env.DB.prepare(
    `SELECT * FROM runs WHERE kind = ? AND source IS ? AND status != 'failed'
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(kind, source)
    .first<Run>();
  if (last?.status === "queued") return jsonResponse(200, { run: last });
  const wait = last
    ? Date.parse(last.requested) + SPACING[kind] - Date.now()
    : 0;
  if (wait > 0) {
    const what = source ? `${source} run` : `${kind} run`;
    const minutes = Math.ceil(wait / MINUTE);
    return jsonResponse(429, {
      error: `A ${what} was asked for recently; another can be in ${minutes} min.`,
    });
  }
  const run = await env.DB.prepare(
    "INSERT INTO runs (kind, source, requested) VALUES (?, ?, ?) RETURNING *",
  )
    .bind(kind, source, new Date().toISOString())
    .first<Run>();
  return jsonResponse(201, { run });
}

async function report(
  env: RunsEnv,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const status = Object.keys(REPORTS).find((s) => s === body.status) as
    | RunStatus
    | undefined;
  if (!status || !/^\d+$/.test(id)) {
    return jsonResponse(400, {
      error: "status must be running, done or failed",
    });
  }
  const from = REPORTS[status];
  const error =
    status === "failed" && typeof body.error === "string"
      ? body.error.slice(0, MAX_ERROR)
      : null;
  const column = status === "running" ? "started" : "finished";
  const run = await env.DB.prepare(
    `UPDATE runs SET status = ?, ${column} = ?, error = ?
     WHERE id = ? AND status = ? RETURNING *`,
  )
    .bind(status, new Date().toISOString(), error, Number(id), from)
    .first<Run>();
  if (!run) return jsonResponse(409, { error: `No ${from} run ${id}.` });
  return jsonResponse(200, { run });
}

/** An admin runs request, already authorized; `rest` follows the path. */
export async function adminRuns(
  request: Request,
  env: RunsEnv,
  rest: string,
): Promise<Response> {
  if (rest !== "" && rest !== "/")
    return jsonResponse(404, { error: "Not found." });
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM runs ORDER BY id DESC LIMIT ${SHOWN}`,
    ).all<Run>();
    return jsonResponse(200, { runs: results });
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  const body = await readBody(request);
  if (body instanceof Response) return body;
  return ask(env, body);
}

/** The scraper's report on a run, already authorized; `rest` follows the path. */
export async function scraperRuns(
  request: Request,
  env: RunsEnv,
  rest: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readBody(request);
  if (body instanceof Response) return body;
  return report(env, rest.replace(/^\//, ""), body);
}
