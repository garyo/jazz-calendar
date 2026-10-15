import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Submission } from "./submission";
import { addDays, dayKey } from "./time";
import worker, { type Env } from "./worker";

const sample = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).text();
const schema = await Bun.file(
  new URL("../migrations/0001_submissions.sql", import.meta.url),
).text();

const ADMIN = "admin-token";
const PUBLISH = "publish-token";
const SECRET = "turnstile-secret";
const today = dayKey(new Date());

/** D1's statement API over an in-memory SQLite database. */
function fakeD1(db: Database): D1Database {
  type Value = string | number | null;
  const statement = (sql: string, args: Value[] = []) => ({
    bind: (...values: Value[]) => statement(sql, values),
    run: async () => {
      db.query(sql).run(...args);
      return { success: true, results: [] };
    },
    first: async () => db.query(sql).get(...args) ?? null,
    all: async () => ({ success: true, results: db.query(sql).all(...args) }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function fakeBucket(feed: string | null): R2Bucket {
  return {
    get: async (key: string) => {
      feedReads++;
      return key === "events.json" && feed
        ? { json: async () => JSON.parse(feed) }
        : null;
    },
  } as unknown as R2Bucket;
}

let db: Database;
let env: Env;
let verified: FormData[];
let human: boolean;
type Outcome = { action?: string; hostname?: string };
/** What siteverify says about a token from the live form. */
const FROM_FORM: Outcome = {
  action: "submit-gig",
  hostname: "bostonjazzcalendar.com",
};
let outcome: Outcome;
let feedReads: number;
let notices: { auth: string | null; body: Record<string, unknown> }[];
let waiting: Promise<unknown>[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(schema);
  env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DATA: fakeBucket(sample),
    DB: fakeD1(db),
    PUBLISH_TOKEN: PUBLISH,
    ADMIN_TOKEN: ADMIN,
    TURNSTILE_SECRET: SECRET,
  };
  verified = [];
  notices = [];
  waiting = [];
  human = true;
  outcome = FROM_FORM;
  feedReads = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "https://ntfy.example.com") {
      notices.push({
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(init?.body as string),
      });
      return new Response("{}");
    }
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    verified.push(init?.body as FormData);
    return Response.json({ success: human, ...outcome });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    waiting.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://bostonjazzcalendar.com${path}`, init),
    env,
    ctx,
  );
}

function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return call(path, { method: "POST", body: JSON.stringify(body), headers });
}

const gig = {
  title: "The Fictional Quartet",
  date: addDays(today, 10),
  start_time: "20:00",
  end_time: "23:00",
  venue: "lilypad",
  price: "$15",
  url: "https://example.com/gigs/fictional-quartet",
  submitter_name: "Pat Example",
  submitter_email: "pat@example.com",
  notes: "First time\nat this room.",
  turnstile: "XXXX.DUMMY.TOKEN.XXXX",
};

async function submitted(fields: object = {}): Promise<string> {
  const res = await post("/api/submissions", { ...gig, ...fields });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function row(id: string): Submission {
  return db
    .query("SELECT * FROM submissions WHERE id = ?")
    .get(id) as Submission;
}

async function errors(res: Response): Promise<string[]> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { fields: Record<string, string> };
  return Object.keys(body.fields).sort();
}

describe("POST /api/submissions", () => {
  test("stores a pending submission and never echoes the email", async () => {
    const res = await post("/api/submissions", gig);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("pat@example.com");
    const { id, status } = JSON.parse(text);
    expect(status).toBe("pending");
    expect(row(id)).toMatchObject({
      status: "pending",
      title: "The Fictional Quartet",
      start_time: "20:00",
      venue: "lilypad",
      venue_name: null,
      submitter_email: "pat@example.com",
      notes: "First time\nat this room.",
      relevance: null,
    });
    expect(verified[0].get("secret")).toBe(SECRET);
    expect(verified[0].get("response")).toBe(gig.turnstile);
  });

  test("pings ntfy without the submitter's details, when configured", async () => {
    await submitted();
    await Promise.all(waiting);
    expect(notices).toEqual([]);

    env.NTFY_URL = "https://ntfy.example.com";
    env.NTFY_TOPIC = "misc";
    env.NTFY_TOKEN = "dXNlcjpwYXNz";
    await submitted({ title: "Mehmet Ali Sanlıkol Quintet" });
    await Promise.all(waiting);
    expect(notices).toHaveLength(1);
    const [{ auth, body }] = notices;
    expect(auth).toBe("Basic dXNlcjpwYXNz");
    expect(body).toMatchObject({
      topic: "misc",
      click: "https://bostonjazzcalendar.com/admin",
    });
    expect(body.message).toContain("Mehmet Ali Sanlıkol Quintet");
    expect(body.message).toContain("lilypad");
    expect(JSON.stringify(body)).not.toContain("pat@example.com");
    expect(JSON.stringify(body)).not.toContain("Pat Example");
  });

  test("accepts a TBA time and an unlisted venue", async () => {
    const id = await submitted({
      time_tba: true,
      start_time: "19:00",
      end_time: "",
      venue: "other",
      venue_name: "  The   Example Room ",
      venue_town: "Somerville",
    });
    expect(row(id)).toMatchObject({
      start_time: null,
      end_time: null,
      venue: null,
      venue_name: "The Example Room",
      venue_town: "Somerville",
    });
  });

  test("rejects bad fields before checking Turnstile", async () => {
    const cases: [object, string[]][] = [
      [{ title: " ", submitter_name: undefined }, ["submitter_name", "title"]],
      [{ title: "x".repeat(151) }, ["title"]],
      [{ title: 42 }, ["title"]],
      [{ date: addDays(today, -1) }, ["date"]],
      [{ date: addDays(today, 367) }, ["date"]],
      [{ date: "2026-02-30" }, ["date"]],
      [{ start_time: "" }, ["start_time"]],
      [{ start_time: "8pm", end_time: "25:00" }, ["end_time", "start_time"]],
      [{ venue: "" }, ["venue"]],
      [{ venue: "other" }, ["venue_name", "venue_town"]],
      [{ url: "javascript:alert(1)" }, ["url"]],
      [{ url: "ftp://example.com/x" }, ["url"]],
      [{ url: "https://user:pw@example.com/" }, ["url"]],
      [{ submitter_email: "pat@" }, ["submitter_email"]],
      [{ time_tba: "yes" }, ["time_tba"]],
    ];
    for (const [fields, expected] of cases) {
      const res = await post("/api/submissions", { ...gig, ...fields });
      expect(await errors(res)).toEqual(expected);
    }
    expect(verified).toHaveLength(0);
    expect(feedReads).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM submissions").get()).toEqual({
      n: 0,
    });
  });

  test("rejects addresses that could rewrite a mailto: link", async () => {
    for (const address of [
      "pat@example.com?cc=x@example.org",
      "pat@example.com&bcc=x@example.org",
      "pat@example.com,x@example.org",
      "pat@example.com;x@example.org",
      "pat%40example.com@example.org",
      "<pat@example.com>",
      "pat @example.com",
    ]) {
      const res = await post("/api/submissions", {
        ...gig,
        submitter_email: address,
      });
      expect(await errors(res)).toEqual(["submitter_email"]);
    }
    await submitted({ submitter_email: "pat.o'example+gigs@example.co.uk" });
  });

  test("reads the venue list only after Turnstile passes", async () => {
    const unlisted = { ...gig, venue: "nowhere" };
    human = false;
    expect((await post("/api/submissions", unlisted)).status).toBe(403);
    expect(feedReads).toBe(0);
    human = true;
    expect(await errors(await post("/api/submissions", unlisted))).toEqual([
      "venue",
    ]);
    expect(feedReads).toBe(1);
  });

  test("today and a year ahead are allowed", async () => {
    await submitted({ date: today });
    await submitted({ date: addDays(today, 366) });
  });

  test("403 when Turnstile says no, or there's no token", async () => {
    human = false;
    expect((await post("/api/submissions", gig)).status).toBe(403);
    human = true;
    const res = await post("/api/submissions", { ...gig, turnstile: "" });
    expect(res.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM submissions").get()).toEqual({
      n: 0,
    });
  });

  test("403 for a token from another widget or site", async () => {
    for (const wrong of [
      { action: "login" },
      { action: undefined },
      { hostname: "evil.example.com" },
      { hostname: undefined },
    ]) {
      outcome = { ...FROM_FORM, ...wrong };
      expect((await post("/api/submissions", gig)).status).toBe(403);
    }
    outcome = { ...FROM_FORM, hostname: "jazz-calendar.garyo.workers.dev" };
    await submitted();
  });

  test("a test secret skips the action and hostname checks", async () => {
    env.TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
    outcome = { hostname: "example.com" };
    await submitted();
    human = false;
    expect((await post("/api/submissions", gig)).status).toBe(403);
  });

  test("503 until Turnstile is configured", async () => {
    env.TURNSTILE_SECRET = undefined;
    expect((await post("/api/submissions", gig)).status).toBe(503);
  });

  test("400 for a body that isn't a JSON object; 405 for GET", async () => {
    for (const body of ["not json", "[1]", ""]) {
      const res = await call("/api/submissions", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    }
    const form = await call("/api/submissions", {
      method: "POST",
      body: "title=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(400);
    expect((await call("/api/submissions")).status).toBe(405);
  });

  test("413 past 16 KB, whatever Content-Length says", async () => {
    const big = JSON.stringify({ ...gig, notes: "x".repeat(17000) });
    const json = { "content-type": "application/json" };
    /** A body that arrives in chunks, with no length up front. */
    const streamed = (text: string) =>
      new Blob([text]).stream() as ReadableStream<Uint8Array>;
    const sizes = [
      await call("/api/submissions", {
        method: "POST",
        body: big,
        headers: json,
      }),
      await call("/api/submissions", {
        method: "POST",
        body: streamed(big),
        headers: json,
      }),
      await call("/api/submissions", {
        method: "POST",
        body: "{}",
        headers: { ...json, "content-length": "999999" },
      }),
    ];
    expect(sizes.map((res) => res.status)).toEqual([413, 413, 413]);
    expect(verified).toHaveLength(0);

    const res = await call("/api/submissions", {
      method: "POST",
      body: streamed(JSON.stringify(gig)),
      headers: json,
    });
    expect(res.status).toBe(201);
  });
});

describe("admin API", () => {
  test("needs the admin token", async () => {
    for (const token of [undefined, "wrong", PUBLISH]) {
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : {};
      const res = await call("/api/admin/submissions", { headers });
      expect(res.status).toBe(401);
    }
    env.ADMIN_TOKEN = undefined;
    const res = await call("/api/admin/submissions", {
      headers: { authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  test("lists submissions by status, private fields included", async () => {
    await submitted({ title: "Later", date: addDays(today, 20) });
    await submitted({ title: "Sooner", date: addDays(today, 2) });
    const res = await call("/api/admin/submissions?status=pending", {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    const { submissions } = (await res.json()) as { submissions: Submission[] };
    expect(submissions.map((s) => s.title)).toEqual(["Sooner", "Later"]);
    expect(submissions[0].submitter_email).toBe("pat@example.com");
    const bad = await call("/api/admin/submissions?status=all", {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(bad.status).toBe(400);
  });

  test("approve needs a listed venue and a relevance", async () => {
    const id = await submitted({
      venue: "other",
      venue_name: "The Example Room",
      venue_town: "Somerville",
    });
    const path = `/api/admin/submissions/${id}`;
    const res = await post(path, { action: "approve" }, ADMIN);
    expect(await errors(res)).toEqual(["relevance", "venue"]);
    const bogus = await post(
      path,
      { action: "approve", edits: { venue: "nowhere", relevance: "jazz" } },
      ADMIN,
    );
    expect(await errors(bogus)).toEqual(["venue"]);
    expect(row(id).status).toBe("pending");
  });

  test("approve saves edits; reject unpublishes; approve again", async () => {
    const id = await submitted({
      venue: "other",
      venue_name: "The Example Room",
      venue_town: "Somerville",
    });
    const path = `/api/admin/submissions/${id}`;
    const edits = {
      title: "Fictional Quartet",
      venue: "wallys",
      time_tba: false,
      start_time: "21:00",
      end_time: "01:00",
      price: "Free",
      relevance: "adjacent",
      editor_note: "Checked their site.",
      // Ignored: not editable.
      status: "rejected",
      submitter_email: "x@example.com",
    };
    const res = await post(path, { action: "approve", edits }, ADMIN);
    expect(res.status).toBe(200);
    const { submission } = (await res.json()) as { submission: Submission };
    expect(submission).toMatchObject({
      status: "approved",
      title: "Fictional Quartet",
      venue: "wallys",
      venue_name: "The Example Room",
      start_time: "21:00",
      end_time: "01:00",
      price: "Free",
      relevance: "adjacent",
      editor_note: "Checked their site.",
      submitter_email: "pat@example.com",
    });
    expect(submission.reviewed_at).toBeTruthy();

    const rejected = await post(
      path,
      { action: "reject", edits: { editor_note: "Cancelled." } },
      ADMIN,
    );
    expect(rejected.status).toBe(200);
    expect(row(id)).toMatchObject({
      status: "rejected",
      editor_note: "Cancelled.",
      title: "Fictional Quartet",
    });

    const again = await post(path, { action: "approve" }, ADMIN);
    expect(again.status).toBe(200);
    expect(row(id)).toMatchObject({
      status: "approved",
      relevance: "adjacent",
    });
  });

  test("404 for an unknown id, 400 for an unknown action", async () => {
    const id = await submitted();
    const missing = await post(
      "/api/admin/submissions/00000000-0000-0000-0000-000000000000",
      { action: "reject" },
      ADMIN,
    );
    expect(missing.status).toBe(404);
    expect(
      (await post("/api/admin/submissions/x'--", { action: "reject" }, ADMIN))
        .status,
    ).toBe(404);
    const res = await post(
      `/api/admin/submissions/${id}`,
      { action: "publish" },
      ADMIN,
    );
    expect(res.status).toBe(400);
    expect(row(id).status).toBe("pending");
  });
});

describe("GET /api/submissions/approved", () => {
  async function approve(id: string, edits: object = {}): Promise<void> {
    const res = await post(
      `/api/admin/submissions/${id}`,
      { action: "approve", edits: { relevance: "jazz", ...edits } },
      ADMIN,
    );
    expect(res.status).toBe(200);
  }

  test("needs the publish token", async () => {
    for (const token of [undefined, ADMIN]) {
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : {};
      const res = await call("/api/submissions/approved", { headers });
      expect(res.status).toBe(401);
    }
  });

  test("lists upcoming approved gigs with publishable fields only", async () => {
    const shown = await submitted({ date: addDays(today, 3) });
    await approve(shown);
    const past = await submitted({ title: "Past", date: addDays(today, 1) });
    await approve(past);
    db.query("UPDATE submissions SET date = ? WHERE id = ?").run(
      addDays(today, -1),
      past,
    );
    await submitted({ title: "Still pending" });
    const rejected = await submitted({ title: "Rejected" });
    await post(
      `/api/admin/submissions/${rejected}`,
      { action: "reject" },
      ADMIN,
    );

    const res = await call("/api/submissions/approved", {
      headers: { authorization: `Bearer ${PUBLISH}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of ["pat@example.com", "Pat Example", "First time"]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text)).toEqual({
      submissions: [
        {
          id: shown,
          title: "The Fictional Quartet",
          date: addDays(today, 3),
          start_time: "20:00",
          end_time: "23:00",
          venue: "lilypad",
          price: "$15",
          url: "https://example.com/gigs/fictional-quartet",
          relevance: "jazz",
        },
      ],
    });
  });
});
