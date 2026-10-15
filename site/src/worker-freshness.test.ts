import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "./worker";
import { STALE_HOURS, staleAlertDue } from "./worker-freshness";

const HOUR = 3_600_000;
const UPLOADED = Date.parse("2026-10-14T09:31:12Z");

let uploaded: number | null;
let heads: number;
let notices: { auth: string | null; body: Record<string, unknown> }[];
let env: Env;
const realFetch = globalThis.fetch;

beforeEach(() => {
  uploaded = UPLOADED;
  heads = 0;
  notices = [];
  env = {
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
    DATA: {
      head: async (key: string) => {
        expect(key).toBe("events.json");
        heads++;
        return uploaded === null ? null : { uploaded: new Date(uploaded) };
      },
    } as unknown as R2Bucket,
    NTFY_URL: "https://ntfy.example.com",
    NTFY_TOPIC: "misc",
    NTFY_TOKEN: "dXNlcjpwYXNz",
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://ntfy.example.com");
    notices.push({
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(init?.body as string),
    });
    return new Response("{}");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs the cron handler as Cloudflare would at `scheduledTime`. */
async function tick(scheduledTime: number): Promise<void> {
  const waiting: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => waiting.push(promise),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const controller = {
    scheduledTime,
    cron: "0 * * * *",
    noRetry: () => {},
  } as ScheduledController;
  await worker.scheduled(controller, env, ctx);
  await Promise.all(waiting);
}

/** The hourly ticks from the hour after `from` through `hours` later. */
function hourlyTicks(from: number, hours: number): number[] {
  const first = Math.ceil(from / HOUR) * HOUR;
  return Array.from({ length: hours }, (_, i) => first + i * HOUR);
}

describe("staleAlertDue", () => {
  test("fires in the hour the data turns 30 hours old, then daily", () => {
    const due = (hours: number) => staleAlertDue(hours * HOUR);
    expect(due(0)).toBe(false);
    expect(due(29.99)).toBe(false);
    expect(due(STALE_HOURS)).toBe(true);
    expect(due(30.99)).toBe(true);
    expect(due(31)).toBe(false);
    expect(due(53.99)).toBe(false);
    expect(due(54)).toBe(true);
    expect(due(78.5)).toBe(true);
    expect(due(-5)).toBe(false);
  });
});

describe("the hourly freshness check", () => {
  test("one notice a day while the data is stale, none before", async () => {
    for (const time of hourlyTicks(UPLOADED, 100)) await tick(time);
    expect(heads).toBe(100);
    expect(notices.map((n) => n.body.message)).toEqual([
      expect.stringContaining("30 hours ago"),
      expect.stringContaining("54 hours ago"),
      expect.stringContaining("78 hours ago"),
    ]);
    const [{ auth, body }] = notices;
    expect(auth).toBe("Basic dXNlcjpwYXNz");
    expect(body).toMatchObject({
      topic: "misc",
      title: "Boston Jazz Calendar: no fresh data",
      priority: 4,
    });
    expect(body.message).toContain("5:31 AM");
    expect(body.message).toContain("~/Library/Logs/jazzcal.log");
  });

  test("a daily upload never alerts", async () => {
    for (const time of hourlyTicks(UPLOADED, 72)) {
      if (time - (uploaded ?? 0) > 24 * HOUR) uploaded = time;
      await tick(time);
    }
    expect(notices).toEqual([]);
  });

  test("a missing events.json alerts once a day", async () => {
    uploaded = null;
    for (const time of hourlyTicks(UPLOADED, 48)) await tick(time);
    expect(notices).toHaveLength(2);
    expect(notices[0].body.message).toContain("missing");
  });

  test("nothing is sent without ntfy settings", async () => {
    env.NTFY_TOKEN = undefined;
    await tick(UPLOADED + STALE_HOURS * HOUR);
    expect(heads).toBe(1);
    expect(notices).toEqual([]);
  });
});
