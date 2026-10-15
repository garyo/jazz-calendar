/**
 * Cloudflare Worker for bostonjazzcalendar.com.
 *
 * Serves the scraper's output from R2 (/data/events.json, /data/status.json)
 * and accepts fresh copies from the scraper via PUT /api/publish/:key. The
 * /calendar.ics feeds are built from events.json in worker-calendar.ts, gig
 * submissions and their review live in worker-submissions.ts, and the
 * hourly cron's stale-data check in worker-freshness.ts.
 * Static assets never reach this code unless a run_worker_first path falls
 * through (see wrangler.toml).
 */

import { FEED_PATH, serveCalendar } from "./worker-calendar";
import { checkFreshness } from "./worker-freshness";
import {
  hasBearer,
  methodNotAllowed,
  textResponse,
  unauthorized,
} from "./worker-http";
import { routeSubmissions, type SubmissionsEnv } from "./worker-submissions";

export interface Env extends SubmissionsEnv {
  ASSETS: Fetcher;
  /** Bearer token for the publish API (`wrangler secret put PUBLISH_TOKEN`). */
  PUBLISH_TOKEN?: string;
}

/** The R2 keys the site serves and accepts, with their content types. */
const CONTENT_TYPES = {
  "events.json": "application/json; charset=utf-8",
  "status.json": "application/json; charset=utf-8",
} as const;

type DataKey = keyof typeof CONTENT_TYPES;

const PUBLIC_PATHS = new Map<string, DataKey>([
  ["/data/events.json", "events.json"],
  ["/data/status.json", "status.json"],
]);

/**
 * Scrapers from before the Worker built /calendar.ics upload it first and
 * fail the whole publish if that upload fails, so it's accepted and
 * dropped. Remove once every publisher is updated.
 */
const LEGACY_KEY = "calendar.ics";

const PUBLISH_PREFIX = "/api/publish/";
const CACHE_CONTROL = "public, max-age=300";
const READ_METHODS = "GET, HEAD";

function isDataKey(key: string): key is DataKey {
  return Object.hasOwn(CONTENT_TYPES, key);
}

/** The first entity tag in an If-None-Match header, unquoted and strong. */
function requestedEtag(headers: Headers): string | undefined {
  const first = headers.get("if-none-match")?.split(",")[0]?.trim();
  return first?.replace(/^W\//, "").replaceAll('"', "") || undefined;
}

function isReadMethod(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

async function serveData(
  request: Request,
  env: Env,
  key: DataKey,
): Promise<Response> {
  if (!isReadMethod(request)) return methodNotAllowed(READ_METHODS);
  const etag = requestedEtag(request.headers);
  const object = await env.DATA.get(
    key,
    etag ? { onlyIf: { etagDoesNotMatch: etag } } : {},
  );
  if (!object) return textResponse(404, "Not found");

  const headers = {
    etag: object.httpEtag,
    "last-modified": object.uploaded.toUTCString(),
    "cache-control": CACHE_CONTROL,
    "access-control-allow-origin": "*",
  };
  // R2 returns the object without a body when the precondition fails, i.e.
  // the client's copy is current.
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, {
    headers: {
      ...headers,
      "content-type": CONTENT_TYPES[key],
      "content-length": String(object.size),
      "x-content-type-options": "nosniff",
    },
  });
}

async function publish(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed("PUT");
  if (!(await hasBearer(request, env.PUBLISH_TOKEN))) {
    return unauthorized("publish");
  }
  if (key === LEGACY_KEY) return new Response(null, { status: 204 });
  if (!isDataKey(key)) {
    const keys = Object.keys(CONTENT_TYPES).join(", ");
    return textResponse(400, `Unknown key; expected one of: ${keys}`);
  }
  // R2 can only stream a body of known length.
  if (!request.body || !request.headers.has("content-length")) {
    return textResponse(411, "A body with Content-Length is required");
  }
  const object = await env.DATA.put(key, request.body, {
    httpMetadata: { contentType: CONTENT_TYPES[key] },
  });
  return new Response(null, {
    status: 204,
    headers: object ? { etag: object.httpEtag } : {},
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === FEED_PATH) return serveCalendar(request, env, ctx, url);
    const key = PUBLIC_PATHS.get(pathname);
    if (key) return serveData(request, env, key);
    if (pathname.startsWith(PUBLISH_PREFIX)) {
      return publish(request, env, pathname.slice(PUBLISH_PREFIX.length));
    }
    const submissions = routeSubmissions(request, env, url, ctx);
    if (submissions) return submissions;
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(checkFreshness(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
