import { beforeEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "./worker";

const TOKEN = "s3cret-token";

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
    async get(key: string, options?: R2GetOptions) {
      const stored = store.get(key);
      if (!stored) return null;
      const onlyIf = options?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagDoesNotMatch === stored.etag) return meta(key, stored);
      return { ...meta(key, stored), body: new Response(stored.text).body };
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

let store: Map<string, Stored>;
let env: Env;

beforeEach(() => {
  store = new Map([
    ["events.json", { text: '{"events":[]}', etag: "abc" }],
    [
      "calendar.ics",
      { text: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", etag: "ics" },
    ],
  ]);
  env = {
    ASSETS: {
      fetch: async () => new Response("asset"),
    } as unknown as Fetcher,
    DATA: fakeBucket(store),
    PUBLISH_TOKEN: TOKEN,
  };
});

function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://bostonjazzcalendar.com${path}`, init),
    env,
  );
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

  test("serve the calendar as text/calendar", async () => {
    const res = await call("/calendar.ics");
    expect(res.headers.get("content-type")).toBe(
      "text/calendar; charset=utf-8",
    );
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
