import { beforeEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "./worker";
import { acceptsGzip } from "./worker-calendar";

const sample = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).text();

const TOKEN = "s3cret-token";
const STALE_ICS = "BEGIN:VCALENDAR\r\nX-STALE:1\r\nEND:VCALENDAR\r\n";

interface Stored {
  text: string;
  etag: string;
  contentType?: string;
}

/** An in-memory R2 bucket with just the get/put behavior the worker uses. */
function fakeBucket(store: Map<string, Stored>): R2Bucket {
  let version = 0;
  const meta = (key: string, stored: Stored) => ({
    key,
    size: new TextEncoder().encode(stored.text).length,
    etag: stored.etag,
    httpEtag: `"${stored.etag}"`,
    uploaded: new Date("2026-10-15T10:00:00Z"),
    httpMetadata: { contentType: stored.contentType },
  });
  const bucket = {
    async head(key: string) {
      const stored = store.get(key);
      return stored ? meta(key, stored) : null;
    },
    async get(key: string, options?: R2GetOptions) {
      const stored = store.get(key);
      if (!stored) return null;
      const onlyIf = options?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagDoesNotMatch === stored.etag) return meta(key, stored);
      return {
        ...meta(key, stored),
        body: new Response(stored.text).body,
        json: async () => JSON.parse(stored.text),
      };
    },
    async put(
      key: string,
      value: ReadableStream | string,
      options?: R2PutOptions,
    ) {
      const contentType = (options?.httpMetadata as R2HTTPMetadata | undefined)
        ?.contentType;
      const stored = {
        text: await new Response(value).text(),
        etag: `v${++version}`,
        contentType,
      };
      store.set(key, stored);
      return meta(key, stored);
    },
  };
  return bucket as unknown as R2Bucket;
}

/** A Cache API stand-in keyed on URL, recording what it stores. */
class FakeCache {
  entries = new Map<string, Response>();
  async match(request: Request) {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, response);
  }
}

let store: Map<string, Stored>;
let env: Env;
let cache: FakeCache;
let pending: Promise<unknown>[];

beforeEach(() => {
  store = new Map([
    ["events.json", { text: '{"events":[]}', etag: "abc" }],
    // What older scrapers uploaded; never served.
    ["calendar.ics", { text: STALE_ICS, etag: "ics" }],
  ]);
  env = {
    ASSETS: {
      fetch: async () => new Response("asset"),
    } as unknown as Fetcher,
    DATA: fakeBucket(store),
    DB: {} as D1Database,
    PUBLISH_TOKEN: TOKEN,
  };
  cache = new FakeCache();
  Object.assign(globalThis, { caches: { default: cache } });
  pending = [];
});

const ctx = {
  waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function call(path: string, init?: RequestInit): Promise<Response> {
  const response = await worker.fetch(
    new Request(`https://bostonjazzcalendar.com${path}`, init),
    env,
    ctx,
  );
  await Promise.all(pending);
  return response;
}

function put(path: string, body: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-length": String(new TextEncoder().encode(body).length),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return call(path, { method: "PUT", body, headers });
}

describe("data endpoints", () => {
  test("serve the R2 object with caching headers", async () => {
    const res = await call("/data/events.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(await res.text()).toBe('{"events":[]}');
  });

  test("answer 304 for a current ETag, strong or weak", async () => {
    for (const etag of ['"abc"', 'W/"abc"']) {
      const res = await call("/data/events.json", {
        headers: { "if-none-match": etag },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe('"abc"');
      expect(await res.text()).toBe("");
    }
    const stale = await call("/data/events.json", {
      headers: { "if-none-match": '"old"' },
    });
    expect(stale.status).toBe(200);
  });

  test("404 when the object is missing", async () => {
    expect((await call("/data/status.json")).status).toBe(404);
  });

  test("405 for other methods", async () => {
    const res = await call("/data/events.json", { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("publish", () => {
  test("stores the body and serves it back", async () => {
    const body = '{"sources":[]}';
    const res = await put("/api/publish/status.json", body, TOKEN);
    expect(res.status).toBe(204);
    expect(store.get("status.json")?.contentType).toBe(
      "application/json; charset=utf-8",
    );
    expect(await (await call("/data/status.json")).text()).toBe(body);
  });

  test("401 without or with a wrong token", async () => {
    expect((await put("/api/publish/events.json", "{}")).status).toBe(401);
    expect((await put("/api/publish/events.json", "{}", "nope")).status).toBe(
      401,
    );
    expect(store.get("events.json")?.text).toBe('{"events":[]}');
  });

  test("401 when no token is configured", async () => {
    env.PUBLISH_TOKEN = undefined;
    expect((await put("/api/publish/events.json", "{}", "")).status).toBe(401);
  });

  test("400 for an unknown key", async () => {
    expect((await put("/api/publish/other.json", "{}", TOKEN)).status).toBe(
      400,
    );
    expect((await put("/api/publish/toString", "{}", TOKEN)).status).toBe(400);
  });

  test("accepts and drops calendar.ics from older scrapers", async () => {
    expect((await put("/api/publish/calendar.ics", "x")).status).toBe(401);
    const res = await put("/api/publish/calendar.ics", "BEGIN:X", TOKEN);
    expect(res.status).toBe(204);
    expect(store.get("calendar.ics")?.text).toBe(STALE_ICS);
  });

  test("405 for other methods", async () => {
    const res = await call("/api/publish/events.json", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});

test("everything else goes to static assets", async () => {
  expect(await (await call("/")).text()).toBe("asset");
  expect(await (await call("/data/other.json")).text()).toBe("asset");
});

test("acceptsGzip", () => {
  const accepts = (value: string) =>
    acceptsGzip(new Headers({ "accept-encoding": value }));
  expect(accepts("gzip, deflate, br")).toBe(true);
  expect(accepts("GZIP;Q=0.5")).toBe(true);
  expect(accepts("gzip;q=0")).toBe(false);
  expect(accepts("gzip;q=0.0, br")).toBe(false);
  expect(accepts("br")).toBe(false);
  expect(accepts("")).toBe(false);
});

describe("calendar feeds", () => {
  beforeEach(() => {
    store.set("events.json", { text: sample, etag: "feed1" });
  });

  const uids = (ics: string) =>
    [...ics.matchAll(/^UID:(\S+)@/gm)].map((match) => match[1]);

  test("a venue's events as iCalendar", async () => {
    const res = await call("/calendar.ics?venue=lilypad");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const ics = await res.text();
    expect(ics).toStartWith("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("X-WR-CALNAME:Boston Jazz Calendar: The Lilypad\r\n");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H\r\n");
    expect(uids(ics)).toEqual(["e1a3", "e1ab"]);
    expect(ics).toContain("STATUS:CANCELLED");
  });

  test("credits listings that came through a third party", async () => {
    const ics = await (await call("/calendar.ics?venue=scullers")).text();
    expect(uids(ics)).toEqual(["e1a5"]);
    expect(ics.replace(/\r\n /g, "")).toContain(
      String.raw`\nListing via Ticketmaster: https://www.ticketmaster.com`,
    );
  });

  test("venues or towns, minus jazz-adjacent", async () => {
    const both = await call("/calendar.ics?venue=wallys&town=Cambridge");
    expect(uids(await both.text())).toEqual([
      "e1a2",
      "e1a3",
      "e1a4",
      "e1a6",
      "e1ab",
    ]);
    const jazz = await call("/calendar.ics?town=Cambridge&adjacent=0");
    const ics = await jazz.text();
    expect(uids(ics)).toEqual(["e1a3", "e1a4", "e1ab"]);
    expect(ics).toContain("(jazz only)");
  });

  test("no selection: every listing, built from events.json", async () => {
    const bodies = new Set<string>();
    for (const query of ["", "?adjacent=1", "?venue=", "?utm_source=x"]) {
      const res = await call(`/calendar.ics${query}`);
      expect(res.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    const [ics = ""] = bodies;
    expect(ics).not.toContain("X-STALE");
    expect(ics).toContain("X-WR-CALNAME:Boston Jazz Calendar\r\n");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H\r\n");
    expect(uids(ics)).toHaveLength(JSON.parse(sample).events.length);
    expect(ics).toContain("UID:e1ab@bostonjazzcalendar.com\r\n");
    expect(ics).toContain("DTSTART;VALUE=DATE:");
    expect([...cache.entries.keys()]).toEqual([
      "https://bostonjazzcalendar.com/calendar.ics?v=feed1",
    ]);
  });

  test("unknown venues and towns are dropped from the cache key", async () => {
    const res = await call("/calendar.ics?venue=nowhere,wallys&town=Atlantis");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("nowhere");
    expect(await (await call("/calendar.ics?venue=wallys")).text()).toBe(body);
    for (const query of ["venue=nowhere", "town=Atlantis&adjacent=0"]) {
      const none = await (await call(`/calendar.ics?${query}`)).text();
      expect(none).not.toContain("BEGIN:VEVENT");
      expect(none).toContain("X-WR-CALNAME:Boston Jazz Calendar\r\n");
    }
    expect([...cache.entries.keys()]).toEqual([
      "https://bostonjazzcalendar.com/calendar.ics?v=feed1&venue=wallys",
      "https://bostonjazzcalendar.com/calendar.ics?v=feed1&nothing",
    ]);
  });

  test("400 for malformed or too many values", async () => {
    const many = Array.from({ length: 65 }, (_, i) => `v${i}`).join(",");
    for (const query of [
      "venue=Bad_ID",
      "adjacent=yes",
      `venue=${many}`,
      `venue=lilypad&town=${"x".repeat(3000)}`,
    ]) {
      const res = await call(`/calendar.ics?${query}`);
      expect(res.status).toBe(400);
    }
    expect(cache.entries.size).toBe(0);
  });

  test("cached per normalized query and events.json version", async () => {
    await call("/calendar.ics?venue=wallys,lilypad");
    await call("/calendar.ics?venue=lilypad&venue=wallys");
    expect([...cache.entries.keys()]).toEqual([
      "https://bostonjazzcalendar.com/calendar.ics?v=feed1&venue=lilypad,wallys",
    ]);
    // A new feed version misses the cache.
    store.set("events.json", { text: sample, etag: "feed2" });
    await call("/calendar.ics?venue=lilypad,wallys");
    expect(cache.entries.size).toBe(2);
    // A cached copy is served without reading the feed again, even when the
    // isolate last read another version.
    store.set("events.json", { text: "not json", etag: "feed1" });
    const res = await call("/calendar.ics?venue=lilypad,wallys");
    expect(res.status).toBe(200);
    expect(uids(await res.text())).toEqual(["e1a2", "e1a3", "e1ab"]);
  });

  test("gzipped for clients that accept it", async () => {
    const plain = await (await call("/calendar.ics?venue=lilypad")).text();
    // The second request is answered from the cache.
    for (const _ of [1, 2]) {
      const res = await call("/calendar.ics?venue=lilypad", {
        headers: { "accept-encoding": "br, gzip;q=0.8" },
      });
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(res.headers.get("vary")).toBe("Accept-Encoding");
      expect(res.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
      const body = new Uint8Array(await res.arrayBuffer());
      expect(res.headers.get("content-length")).toBe(String(body.length));
      expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(plain);
    }
    // From the cache, decompressed for a client without gzip.
    const res = await call("/calendar.ics?venue=lilypad", {
      headers: { "accept-encoding": "gzip;q=0" },
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe(plain);
  });

  test("a strong ETag per version and query; 304 when it matches", async () => {
    const first = await call("/calendar.ics?venue=lilypad");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{24}"$/);
    const gzipped = await call("/calendar.ics?venue=lilypad", {
      headers: { "accept-encoding": "gzip" },
    });
    const gzipEtag = gzipped.headers.get("etag");
    expect(gzipEtag).toBe(`${etag.slice(0, -1)}-gzip"`);

    for (const tag of [etag, `W/${etag}`, gzipEtag, `"other", ${etag}`]) {
      const res = await call("/calendar.ics?venue=lilypad", {
        headers: { "if-none-match": tag ?? "" },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(await res.text()).toBe("");
    }
    const other = await call("/calendar.ics?venue=wallys", {
      headers: { "if-none-match": etag },
    });
    expect(other.status).toBe(200);
    expect(other.headers.get("etag")).not.toBe(etag);

    // The same URL with an unknown venue added has the same feed and tag.
    const stray = await call("/calendar.ics?venue=lilypad,nowhere", {
      headers: { "if-none-match": etag },
    });
    expect(stray.status).toBe(304);

    store.set("events.json", { text: sample, etag: "feed2" });
    const updated = await call("/calendar.ics?venue=lilypad", {
      headers: { "if-none-match": etag },
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).not.toBe(etag);
  });

  test("HEAD, other methods, and a missing feed", async () => {
    for (const encoding of ["", "gzip"]) {
      const head = await call("/calendar.ics?venue=lilypad", {
        method: "HEAD",
        headers: { "accept-encoding": encoding },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
      expect(await head.text()).toBe("");
    }
    const post = await call("/calendar.ics?venue=lilypad", {
      method: "POST",
      body: "x",
    });
    expect(post.status).toBe(405);
    store.delete("events.json");
    expect((await call("/calendar.ics?venue=lilypad")).status).toBe(404);
  });
});
