/**
 * /calendar.ics: the iCalendar feed, built from events.json. Without venue,
 * town or adjacent parameters it lists everything; with them, just that
 * selection, matched as the page matches it (src/selection.ts).
 *
 * A built feed is kept gzipped in the Cache API under the events.json ETag
 * and the selection's canonical query, so each data version is built at
 * most once per query per data center. The canonical query leaves out
 * venues and towns the data doesn't list, so stray values add no entries.
 * Responses are gzipped for clients that accept it and carry a strong ETag
 * derived from the same key; a matching If-None-Match gets 304.
 */

import { buildCalendar } from "./calendar-export";
import { type Credits, creditsById } from "./credits";
import {
  calendarName,
  feedQuery,
  knownSelection,
  matchesSelection,
  parseFeedSelection,
  type Selection,
} from "./selection";
import type { EventsFile, Venue } from "./types";
import { methodNotAllowed, textResponse } from "./worker-http";

export interface CalendarEnv {
  DATA: R2Bucket;
}

export const FEED_PATH = "/calendar.ics";
const CONTENT_TYPE = "text/calendar; charset=utf-8";
const FEED_CACHE_CONTROL = "public, max-age=3600";
/** Cache API lifetime of a built feed; a new upload changes its key anyway. */
const STORED_CACHE_CONTROL = "public, max-age=86400";
const REFRESH_HOURS = 12;
/** Longer queries are refused before any parsing. */
const MAX_QUERY_LENGTH = 2048;
/** The canonical query of a selection naming only venues and towns the data lacks. */
const NOTHING = "nothing";
/** Marks the gzip encoding's entity tag. */
const GZIP_SUFFIX = "-gzip";
const GZIP_TAG = /-gzip$/;

interface Feed {
  etag: string;
  data: EventsFile;
  venues: Map<string, Venue>;
  credits: Credits;
}

/** A built feed's identity: the events.json version and the canonical query. */
interface FeedKey {
  version: string;
  query: string;
}

/** The isolate's last-read events.json, reused while its ETag is current. */
let loaded: Feed | undefined;

async function loadFeed(env: CalendarEnv): Promise<Feed | undefined> {
  const object = await env.DATA.get(
    "events.json",
    loaded ? { onlyIf: { etagDoesNotMatch: loaded.etag } } : {},
  );
  if (!object) return undefined;
  // Without a body, the precondition failed: the copy at hand is current.
  if (!("body" in object)) return loaded;
  const data = await object.json<EventsFile>();
  loaded = {
    etag: object.etag,
    data,
    venues: new Map(data.venues.map((venue) => [venue.id, venue])),
    credits: creditsById(data.sources),
  };
  return loaded;
}

/** The selection as far as the data knows it, and its canonical query. */
function resolve(
  selection: Selection,
  feed: Feed,
): { known: Selection | null; query: string } {
  const known = knownSelection(selection, feed.data.venues);
  return { known, query: known ? feedQuery(known) : NOTHING };
}

function calendarText(
  { data, venues, credits }: Feed,
  known: Selection | null,
): string {
  const events = known
    ? data.events.filter((event) =>
        matchesSelection(event, venues.get(event.venue), known),
      )
    : [];
  const generated = new Date(data.generated_at);
  return buildCalendar(events, venues, {
    name: known ? calendarName(known, venues) : "Boston Jazz Calendar",
    stamp: Number.isNaN(generated.getTime()) ? new Date() : generated,
    refreshHours: REFRESH_HOURS,
    credits,
  });
}

function cacheRequest(url: URL, { version, query }: FeedKey): Request {
  const suffix = query ? `&${query}` : "";
  return new Request(`${url.origin}${FEED_PATH}?v=${version}${suffix}`);
}

/** The identity encoding's entity tag, unquoted; gzip's adds GZIP_SUFFIX. */
async function entityTag({ version, query }: FeedKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${version}?${query}`),
  );
  return [...new Uint8Array(digest, 0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Whether If-None-Match lists the tag, in either encoding, or is "*". */
function clientHas(headers: Headers, tag: string): boolean {
  const header = headers.get("if-none-match");
  if (!header) return false;
  return header.split(",").some((item) => {
    const value = item.trim().replace(/^W\//, "").replaceAll('"', "");
    return value === "*" || value.replace(GZIP_TAG, "") === tag;
  });
}

/** Whether Accept-Encoding allows gzip (q above 0). */
export function acceptsGzip(headers: Headers): boolean {
  const header = headers.get("accept-encoding") ?? "";
  return header.split(",").some((item) => {
    const [coding, ...params] = item.split(";").map((part) => part.trim());
    if (coding?.toLowerCase() !== "gzip") return false;
    const q = params.find((param) => /^q=/i.test(param));
    return !q || Number(q.slice(2)) > 0;
  });
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function gunzip(data: ArrayBuffer): ReadableStream {
  return new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
}

function feedHeaders(request: Request, tag: string): Record<string, string> {
  const gzipped = acceptsGzip(request.headers);
  return {
    etag: `"${gzipped ? tag + GZIP_SUFFIX : tag}"`,
    "cache-control": FEED_CACHE_CONTROL,
    vary: "Accept-Encoding",
    "access-control-allow-origin": "*",
  };
}

function notModified(request: Request, tag: string): Response | undefined {
  if (!clientHas(request.headers, tag)) return undefined;
  return new Response(null, {
    status: 304,
    headers: feedHeaders(request, tag),
  });
}

/**
 * The feed in the encoding the client takes. `text` is the uncompressed
 * feed when it's at hand, to skip decompressing.
 */
function feedResponse(
  request: Request,
  tag: string,
  compressed: ArrayBuffer,
  text?: string,
): Response {
  const headers = {
    ...feedHeaders(request, tag),
    "content-type": CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  };
  const head = request.method === "HEAD";
  if (!acceptsGzip(request.headers)) {
    return new Response(head ? null : (text ?? gunzip(compressed)), {
      headers,
    });
  }
  // "manual": the body is gzipped already, so the runtime mustn't encode it.
  return new Response(head ? null : compressed, {
    headers: {
      ...headers,
      "content-encoding": "gzip",
      "content-length": String(compressed.byteLength),
    },
    encodeBody: "manual",
  });
}

/** 304, or the cached feed for a key, if there is one. */
async function fromCache(
  request: Request,
  url: URL,
  key: FeedKey,
): Promise<Response | undefined> {
  const tag = await entityTag(key);
  const unchanged = notModified(request, tag);
  if (unchanged) return unchanged;
  const cached = await caches.default.match(cacheRequest(url, key));
  return cached && feedResponse(request, tag, await cached.arrayBuffer());
}

export async function serveCalendar(
  request: Request,
  env: CalendarEnv,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  const selection =
    url.search.length <= MAX_QUERY_LENGTH
      ? parseFeedSelection(url.searchParams)
      : null;
  if (!selection) return textResponse(400, "Bad venue, town or adjacent");

  const head = await env.DATA.head("events.json");
  if (!head) return textResponse(404, "Not found");
  // Until this version's venue list is at hand, try the query as given:
  // only canonical queries are stored, so a hit is still the right feed.
  const current = loaded?.etag === head.etag ? loaded : undefined;
  const first: FeedKey = {
    version: head.etag,
    query: current ? resolve(selection, current).query : feedQuery(selection),
  };
  const hit = await fromCache(request, url, first);
  if (hit) return hit;

  const feed = await loadFeed(env);
  if (!feed) return textResponse(404, "Not found");
  const { known, query } = resolve(selection, feed);
  const key: FeedKey = { version: feed.etag, query };
  if (key.version !== first.version || key.query !== first.query) {
    const canonicalHit = await fromCache(request, url, key);
    if (canonicalHit) return canonicalHit;
  }

  const text = calendarText(feed, known);
  const compressed = await gzip(text);
  const stored = new Response(compressed, {
    headers: {
      "content-type": "application/gzip",
      "cache-control": STORED_CACHE_CONTROL,
    },
  });
  ctx.waitUntil(caches.default.put(cacheRequest(url, key), stored));
  return feedResponse(request, await entityTag(key), compressed, text);
}
