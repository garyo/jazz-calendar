/**
 * Cloudflare Worker for bostonjazzcalendar.com.
 *
 * Serves the scraper's output from R2 (/data/events.json, /data/status.json,
 * /calendar.ics) and accepts fresh copies from the scraper via
 * PUT /api/publish/:key. /calendar.ics with venue, town or adjacent
 * parameters is a feed of just that selection, built from events.json.
 * Gig submissions and their review live in worker-submissions.ts.
 * Static assets never reach this code unless a run_worker_first path falls
 * through (see wrangler.toml).
 */

import { buildCalendar } from "./calendar-export";
import {
  calendarName,
  feedQuery,
  knownSelection,
  matchesSelection,
  parseFeedSelection,
  type Selection,
} from "./selection";
import type { EventsFile } from "./types";
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
  "calendar.ics": "text/calendar; charset=utf-8",
} as const;

type DataKey = keyof typeof CONTENT_TYPES;

const PUBLIC_PATHS = new Map<string, DataKey>([
  ["/data/events.json", "events.json"],
  ["/data/status.json", "status.json"],
  ["/calendar.ics", "calendar.ics"],
]);

const PUBLISH_PREFIX = "/api/publish/";
const CACHE_CONTROL = "public, max-age=300";
const FEED_PATH = "/calendar.ics";
const FEED_PARAMS = ["venue", "town", "adjacent"];
const FEED_CACHE_CONTROL = "public, max-age=3600";
const FEED_REFRESH_HOURS = 12;
/** Longer queries are refused before any parsing. */
const MAX_QUERY_LENGTH = 2048;
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

function withoutBody(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, response);
}

function filteredCalendar(feed: EventsFile, selection: Selection): string {
  const venues = new Map(feed.venues.map((venue) => [venue.id, venue]));
  const known = knownSelection(selection, feed.venues);
  const events = known
    ? feed.events.filter((event) =>
        matchesSelection(event, venues.get(event.venue), known),
      )
    : [];
  const generated = new Date(feed.generated_at);
  return buildCalendar(events, venues, {
    name: known ? calendarName(known, venues) : "Boston Jazz Calendar",
    stamp: Number.isNaN(generated.getTime()) ? new Date() : generated,
    refreshHours: FEED_REFRESH_HOURS,
  });
}

/**
 * /calendar.ics?venue=…&town=…&adjacent=0: the events.json listings that
 * match, as iCalendar. Cached per normalized query and events.json version,
 * so a feed is rebuilt at most once an hour per data center.
 */
async function serveFilteredCalendar(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (!isReadMethod(request)) return methodNotAllowed(READ_METHODS);
  const selection =
    url.search.length <= MAX_QUERY_LENGTH
      ? parseFeedSelection(url.searchParams)
      : null;
  if (!selection) return textResponse(400, "Bad venue, town or adjacent");
  const query = feedQuery(selection);
  if (!query) return serveData(request, env, "calendar.ics");

  const head = await env.DATA.head("events.json");
  if (!head) return textResponse(404, "Not found");
  const cache = caches.default;
  const cacheKey = (etag: string) =>
    new Request(`${url.origin}${FEED_PATH}?${query}&v=${etag}`);
  const cached = await cache.match(cacheKey(head.etag));
  if (cached) return withoutBody(request, cached);

  const object = await env.DATA.get("events.json");
  if (!object) return textResponse(404, "Not found");
  const feed = await object.json<EventsFile>();
  const response = new Response(filteredCalendar(feed, selection), {
    headers: {
      "content-type": CONTENT_TYPES["calendar.ics"],
      "cache-control": FEED_CACHE_CONTROL,
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
  ctx.waitUntil(cache.put(cacheKey(object.etag), response.clone()));
  return withoutBody(request, response);
}

function isFeedQuery(url: URL): boolean {
  return (
    url.pathname === FEED_PATH &&
    FEED_PARAMS.some((name) => url.searchParams.has(name))
  );
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
    if (isFeedQuery(url)) return serveFilteredCalendar(request, env, ctx, url);
    const { pathname } = url;
    const key = PUBLIC_PATHS.get(pathname);
    if (key) return serveData(request, env, key);
    if (pathname.startsWith(PUBLISH_PREFIX)) {
      return publish(request, env, pathname.slice(PUBLISH_PREFIX.length));
    }
    const submissions = routeSubmissions(request, env, url);
    if (submissions) return submissions;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
