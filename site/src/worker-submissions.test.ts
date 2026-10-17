import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Submission } from "./submission";
import { addDays, dayKey } from "./time";
import worker, { type Env } from "./worker";

const sample = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).text();
const migrations = new URL("../migrations/", import.meta.url).pathname;
const schema = (
  await Promise.all(
    [...new Bun.Glob("*.sql").scanSync(migrations)]
      .sort()
      .map((name) => Bun.file(migrations + name).text()),
  )
).join("\n");

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
  type Statement = ReturnType<typeof statement>;
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Statement[]) => {
      const results = [];
      db.run("BEGIN");
      try {
        for (const s of statements) results.push(await s.all());
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
      return results;
    },
  } as unknown as D1Database;
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
      venue_address: "12 Example St",
      venue_url: "https://example.com/room",
    });
    expect(row(id)).toMatchObject({
      start_time: null,
      end_time: null,
      venue: null,
      venue_name: "The Example Room",
      venue_town: "Somerville",
      venue_address: "12 Example St",
      venue_url: "https://example.com/room",
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
      [{ venue: "other" }, ["venue_address", "venue_name", "venue_town"]],
      [
        {
          venue: "other",
          venue_name: "The Example Room",
          venue_town: "Somerville",
          venue_address: "12 Example St",
          venue_url: "example.com",
        },
        ["venue_url"],
      ],
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

  test("approve needs a venue and a relevance", async () => {
    const id = await submitted({
      venue: "other",
      venue_name: "The Example Room",
      venue_town: "Somerville",
      venue_address: "12 Example St",
    });
    const path = `/api/admin/submissions/${id}`;
    const res = await post(path, { action: "approve" }, ADMIN);
    expect(await errors(res)).toEqual([
      "relevance",
      "venue_id",
      "venue_jazz_level",
    ]);
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
      venue_address: "12 Example St",
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

const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN}` };

async function approve(id: string, edits: object = {}): Promise<Response> {
  return post(
    `/api/admin/submissions/${id}`,
    { action: "approve", edits: { relevance: "jazz", ...edits } },
    ADMIN,
  );
}

const unlisted = {
  venue: "other",
  venue_name: "The Example Room",
  venue_town: "Somerville",
  venue_address: "12 Example St",
  venue_url: "https://example.com/room",
};

/** What approving a gig at an unlisted venue adds, besides the submitted details. */
const newVenue = {
  venue_id: "example-room",
  venue_neighborhood: "Union Square",
  venue_jazz_level: "regular",
};

const thursdays = {
  repeats: "weekly",
  days: ["thu"],
  start_time: "18:00",
  end_time: "21:00",
  url: "https://example.com/schedule",
};

describe("regulars", () => {
  test("stores the weekdays and weeks, and no date or price", async () => {
    const weekly = await submitted({ ...thursdays, days: ["thu", "mon"] });
    expect(row(weekly)).toMatchObject({
      kind: "regular",
      date: null,
      days: '["mon","thu"]',
      nth: "[]",
      price: null,
    });
    const monthly = await submitted({
      ...thursdays,
      repeats: "monthly",
      nth: [-1, 1],
    });
    expect(row(monthly)).toMatchObject({ days: '["thu"]', nth: "[1,-1]" });
  });

  test("needs days, and weeks when monthly", async () => {
    const cases: [object, string[]][] = [
      [{ days: [] }, ["days"]],
      [{ days: ["thursday"] }, ["days"]],
      [{ days: "thu" }, ["days"]],
      [{ repeats: "monthly" }, ["nth"]],
      [{ repeats: "monthly", nth: [6] }, ["nth"]],
      [{ repeats: "daily" }, ["repeats"]],
    ];
    for (const [fields, expected] of cases) {
      const res = await post("/api/submissions", {
        ...gig,
        ...thursdays,
        ...fields,
      });
      expect(await errors(res)).toEqual(expected);
    }
  });

  test("approving confirms it; confirm keeps it current", async () => {
    const id = await submitted(thursdays);
    db.query("UPDATE submissions SET checked = '2026-01-01' WHERE id = ?").run(
      id,
    );
    expect((await approve(id)).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "approved", checked: today });

    db.query("UPDATE submissions SET checked = '2026-01-01' WHERE id = ?").run(
      id,
    );
    const path = `/api/admin/submissions/${id}`;
    const res = await post(path, { action: "confirm" }, ADMIN);
    expect(res.status).toBe(200);
    expect(row(id).checked).toBe(today);

    const one = await submitted();
    await approve(one);
    const notRegular = await post(
      `/api/admin/submissions/${one}`,
      { action: "confirm" },
      ADMIN,
    );
    expect(notRegular.status).toBe(400);
  });

  test("approving can turn a regular into a gig", async () => {
    const id = await submitted(thursdays);
    const res = await approve(id, {
      repeats: "once",
      date: addDays(today, 4),
      price: "$10",
    });
    expect(res.status).toBe(200);
    expect(row(id)).toMatchObject({
      kind: "gig",
      date: addDays(today, 4),
      days: null,
      nth: null,
      price: "$10",
      checked: null,
    });
  });
});

describe("new venues", () => {
  test("approving at an unlisted venue adds it", async () => {
    const id = await submitted(unlisted);
    const res = await approve(id, newVenue);
    expect(res.status).toBe(200);
    const { submission } = (await res.json()) as { submission: Submission };
    expect(submission).toMatchObject({
      status: "approved",
      venue: "example-room",
      venue_name: "The Example Room",
    });
    expect(db.query("SELECT * FROM venues").all()).toEqual([
      expect.objectContaining({
        id: "example-room",
        name: "The Example Room",
        address: "12 Example St",
        town: "Somerville",
        neighborhood: "Union Square",
        url: "https://example.com/room",
        jazz_level: "regular",
      }),
    ]);

    // Listed from now on, before the feed has it.
    await submitted({ venue: "example-room" });
  });

  test("a new venue needs a fresh, well-formed id", async () => {
    const id = await submitted(unlisted);
    for (const venue_id of ["lilypad", "Example Room", "-room"]) {
      const res = await approve(id, { ...newVenue, venue_id });
      expect(await errors(res)).toEqual(["venue_id"]);
    }
    expect(row(id).status).toBe("pending");
    expect(db.query("SELECT COUNT(*) AS n FROM venues").get()).toEqual({
      n: 0,
    });
  });

  test("the reviewer may choose a listed venue instead", async () => {
    const id = await submitted(unlisted);
    expect((await approve(id, { venue: "lilypad" })).status).toBe(200);
    expect(row(id).venue).toBe("lilypad");
    expect(db.query("SELECT COUNT(*) AS n FROM venues").get()).toEqual({
      n: 0,
    });
  });
});

describe("admin venues API", () => {
  const venue = {
    venue_id: "example-room",
    venue_name: "The Example Room",
    venue_town: "Somerville",
    venue_address: "12 Example St",
    venue_jazz_level: "occasional",
  };

  test("needs the admin token", async () => {
    expect((await call("/api/admin/venues")).status).toBe(401);
    expect((await post("/api/admin/venues", venue, PUBLISH)).status).toBe(401);
  });

  test("adds, lists, saves and deletes a venue", async () => {
    expect((await post("/api/admin/venues", venue, ADMIN)).status).toBe(201);
    const again = await post("/api/admin/venues", venue, ADMIN);
    expect(await errors(again)).toEqual(["venue_id"]);

    const path = "/api/admin/venues/example-room";
    const saved = await post(
      path,
      { ...venue, action: "save", venue_id: "renamed", venue_town: "Medford" },
      ADMIN,
    );
    expect(saved.status).toBe(200);
    const res = await call("/api/admin/venues", { headers: ADMIN_HEADERS });
    expect(await res.json()).toEqual({
      venues: [
        {
          id: "example-room",
          name: "The Example Room",
          address: "12 Example St",
          town: "Medford",
          neighborhood: null,
          url: null,
          jazz_level: "occasional",
        },
      ],
    });

    const deleted = await post(path, { action: "delete" }, ADMIN);
    expect(deleted.status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM venues").get()).toEqual({
      n: 0,
    });
    expect((await post(path, { action: "delete" }, ADMIN)).status).toBe(404);
  });

  test("won't delete a venue an approved listing uses", async () => {
    await post("/api/admin/venues", venue, ADMIN);
    const id = await submitted({ venue: "example-room" });
    await approve(id);
    const path = "/api/admin/venues/example-room";
    expect((await post(path, { action: "delete" }, ADMIN)).status).toBe(409);
    await post(`/api/admin/submissions/${id}`, { action: "reject" }, ADMIN);
    expect((await post(path, { action: "delete" }, ADMIN)).status).toBe(200);
  });
});

describe("GET /api/registry", () => {
  test("needs the publish token", async () => {
    for (const token of [undefined, ADMIN]) {
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : {};
      expect((await call("/api/registry", { headers })).status).toBe(401);
    }
  });

  test("lists approved regulars and added venues", async () => {
    const id = await submitted({ ...thursdays, ...unlisted });
    await approve(id, newVenue);
    await submitted({ ...thursdays, title: "Still pending" });
    const gigId = await submitted();
    await approve(gigId);

    const res = await call("/api/registry", {
      headers: { authorization: `Bearer ${PUBLISH}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("pat@example.com");
    expect(JSON.parse(text)).toEqual({
      revision: 2,
      venues: [
        {
          id: "example-room",
          name: "The Example Room",
          address: "12 Example St",
          town: "Somerville",
          neighborhood: "Union Square",
          url: "https://example.com/room",
          jazz_level: "regular",
        },
      ],
      regulars: [
        {
          venue: "example-room",
          title: "The Fictional Quartet",
          when: "Thursdays, 6–9 pm",
          days: ["thu"],
          nth: [],
          relevance: "jazz",
          url: "https://example.com/schedule",
          checked: today,
        },
      ],
      hidden: [],
    });

    // Regulars stay out of the dated gigs.
    const gigs = await call("/api/submissions/approved", {
      headers: { authorization: `Bearer ${PUBLISH}` },
    });
    const { submissions } = (await gigs.json()) as {
      submissions: { id: string }[];
    };
    expect(submissions.map((s) => s.id)).toEqual([gigId]);
  });
});

describe("the feed's revision", () => {
  const revision = () =>
    (db.query("SELECT n FROM revision").get() as { n: number }).n;
  const venue = {
    venue_id: "example-room",
    venue_name: "The Example Room",
    venue_town: "Somerville",
    venue_address: "12 Example St",
    venue_jazz_level: "occasional",
  };

  test("counts each change to what the feed shows, and only those", async () => {
    const id = await submitted();
    const pending = await submitted({ title: "Turned down" });
    await post(
      `/api/admin/submissions/${pending}`,
      { action: "reject" },
      ADMIN,
    );
    expect(revision()).toBe(0);

    await approve(id);
    expect(revision()).toBe(1);
    await post(`/api/admin/submissions/${id}`, { action: "reject" }, ADMIN);
    expect(revision()).toBe(2);

    const regular = await submitted(thursdays);
    await approve(regular);
    await post(
      `/api/admin/submissions/${regular}`,
      { action: "confirm" },
      ADMIN,
    );
    expect(revision()).toBe(4);

    const path = "/api/admin/venues/example-room";
    await post("/api/admin/venues", venue, ADMIN);
    await post(path, { ...venue, action: "save" }, ADMIN);
    await post(path, { action: "delete" }, ADMIN);
    expect(revision()).toBe(7);
  });

  test("a change that fails counts nothing", async () => {
    const id = await submitted(unlisted);
    const taken = await approve(id, { ...newVenue, venue_id: "lilypad" });
    expect(taken.status).toBe(400);
    await post("/api/admin/venues", { ...venue, venue_id: "Bad Id" }, ADMIN);
    expect(revision()).toBe(0);
  });
});

describe("hidden listings", () => {
  const revision = () =>
    (db.query("SELECT n FROM revision").get() as { n: number }).n;

  test("hides by title, or venue and night; the note stays private", async () => {
    const add = (body: object) => post("/api/admin/hidden", body, ADMIN);
    const performer = await add({
      title: "Pat Example",
      note: "Asked by email, Oct 17.",
    });
    expect(performer.status).toBe(201);
    const night = await add({ venue: "lilypad", night: "2026-11-07" });
    expect(night.status).toBe(201);
    expect(revision()).toBe(2);

    for (const [body, expected] of [
      [{ venue: "lilypad" }, ["title"]],
      [{ night: "2026-11-07" }, ["title"]],
      [{ title: "x", venue: "nowhere" }, ["venue"]],
      [{ title: "x", night: "Nov 7" }, ["night"]],
    ] as const) {
      expect(await errors(await add(body))).toEqual([...expected]);
    }
    expect(revision()).toBe(2);

    const listed = await call("/api/admin/hidden", { headers: ADMIN_HEADERS });
    const { hidden } = (await listed.json()) as { hidden: { id: number }[] };
    expect(hidden).toEqual([
      expect.objectContaining({ venue: "lilypad", night: "2026-11-07" }),
      expect.objectContaining({
        title: "Pat Example",
        note: "Asked by email, Oct 17.",
        requested: today,
      }),
    ]);

    const res = await call("/api/registry", {
      headers: { authorization: `Bearer ${PUBLISH}` },
    });
    const text = await res.text();
    expect(text).not.toContain("Asked by email");
    expect(JSON.parse(text).hidden).toEqual([
      { title: "Pat Example", venue: null, night: null, requested: today },
      { title: null, venue: "lilypad", night: "2026-11-07", requested: today },
    ]);

    const path = `/api/admin/hidden/${hidden[1].id}`;
    expect((await post(path, { action: "delete" }, ADMIN)).status).toBe(200);
    expect(revision()).toBe(3);
    expect((await post(path, { action: "delete" }, ADMIN)).status).toBe(404);
    expect((await post("/api/admin/hidden/x", {}, ADMIN)).status).toBe(404);
    expect(revision()).toBe(3);
  });

  test("needs the admin token", async () => {
    expect((await call("/api/admin/hidden")).status).toBe(401);
    const res = await post("/api/admin/hidden", { title: "x" }, PUBLISH);
    expect(res.status).toBe(401);
  });
});
