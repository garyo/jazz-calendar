/**
 * Cloudflare Worker for bostonjazzcalendar.com.
 *
 * Serves the scraper's output from R2 (/data/events.json, /data/status.json,
 * /calendar.ics) and accepts fresh copies from the scraper via
 * PUT /api/publish/:key. Static assets never reach this code unless a
 * run_worker_first path falls through (see wrangler.toml).
 */

export interface Env {
  ASSETS: Fetcher;
  DATA: R2Bucket;
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

function isDataKey(key: string): key is DataKey {
  return Object.hasOwn(CONTENT_TYPES, key);
}

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

/** The first entity tag in an If-None-Match header, unquoted and strong. */
function requestedEtag(headers: Headers): string | undefined {
  const first = headers.get("if-none-match")?.split(",")[0]?.trim();
  return first?.replace(/^W\//, "").replaceAll('"', "") || undefined;
}

async function serveData(
  request: Request,
  env: Env,
  key: DataKey,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(405, "Method not allowed", { allow: "GET, HEAD" });
  }
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

/** Constant-time comparison: both sides are hashed to equal-length digests. */
async function tokensMatch(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map((token) =>
      crypto.subtle.digest("SHA-256", encoder.encode(token)),
    ),
  );
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.PUBLISH_TOKEN;
  const match = request.headers.get("authorization")?.match(/^Bearer (.+)$/);
  if (!expected || !match) return false;
  return tokensMatch(match[1], expected);
}

async function publish(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return textResponse(405, "Method not allowed", { allow: "PUT" });
  }
  if (!(await isAuthorized(request, env))) {
    return textResponse(401, "Unauthorized", {
      "www-authenticate": 'Bearer realm="publish"',
    });
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const key = PUBLIC_PATHS.get(pathname);
    if (key) return serveData(request, env, key);
    if (pathname.startsWith(PUBLISH_PREFIX)) {
      return publish(request, env, pathname.slice(PUBLISH_PREFIX.length));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
