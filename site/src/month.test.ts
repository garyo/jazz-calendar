import { describe, expect, test } from "bun:test";
import { buildMonth } from "./month";
import type { CalendarEvent } from "./types";

// Placement must not depend on the viewer's zone.
process.env.TZ = "Asia/Tokyo";

const event = (id: string, start: string, all_day = false): CalendarEvent => ({
  id,
  title: id,
  start,
  all_day,
  venue: "lilypad",
  url: "https://example.com/",
  relevance: "jazz",
  sources: ["test"],
});

type Weeks = ReturnType<typeof buildMonth>;
const days = (weeks: Weeks) => weeks.flat();
const on = (weeks: Weeks, day: string) =>
  days(weeks)
    .find((d) => d.day === day)
    ?.events.map((e) => e.id);

describe("buildMonth", () => {
  test("Sunday-first weeks covering the month, neighbors marked", () => {
    const weeks = buildMonth("2026-10", []); // Oct 1 is a Thursday
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0][0]).toMatchObject({ day: "2026-09-27", inMonth: false });
    expect(weeks[0][4]).toMatchObject({ day: "2026-10-01", inMonth: true });
    expect(weeks[4][6]).toMatchObject({ day: "2026-10-31", inMonth: true });
  });

  test("a month starting on Sunday has no leading days", () => {
    const weeks = buildMonth("2026-11", []);
    expect(weeks[0][0].day).toBe("2026-11-01");
    expect(weeks.at(-1)?.at(-1)?.day).toBe("2026-12-05");
  });

  test("February 2026 fits exactly four weeks; six-week months work too", () => {
    expect(buildMonth("2026-02", [])).toHaveLength(4);
    expect(buildMonth("2026-08", [])).toHaveLength(6); // Aug 1 is a Saturday
  });

  test("year boundaries", () => {
    const weeks = buildMonth("2026-12", []);
    expect(weeks.at(-1)?.at(-1)).toMatchObject({
      day: "2027-01-02",
      inMonth: false,
    });
  });

  test("events go on their night, after-midnight sets with the evening before", () => {
    const weeks = buildMonth("2026-10", [
      event("evening", "2026-10-16T21:00:00-04:00"), // 01:00Z on the 17th
      event("utc", "2026-10-17T03:30:00Z"), // 11:30 pm on the 16th
      event("late", "2026-10-17T00:30:00-04:00"), // Friday's late set
      event("dawn", "2026-10-17T04:00:00-04:00"), // the cutoff: Saturday
      event("neighbor", "2026-09-28T20:00:00-04:00"),
      event("outside", "2026-11-12T20:00:00-05:00"),
    ]);
    expect(on(weeks, "2026-10-16")).toEqual(["evening", "utc", "late"]);
    expect(on(weeks, "2026-10-17")).toEqual(["dawn"]);
    expect(on(weeks, "2026-09-28")).toEqual(["neighbor"]);
    expect(days(weeks).flatMap((d) => d.events.map((e) => e.id))).not.toContain(
      "outside",
    );
  });

  test("across the end of DST", () => {
    const events = [
      event("edt", "2026-11-01T01:30:00-04:00"),
      event("est", "2026-11-01T01:30:00-05:00"), // the second 1:30 am
      event("cutoff", "2026-11-01T04:00:00-05:00"),
      event("night", "2026-11-01T23:30:00-05:00"), // 04:30Z on the 2nd
      event("allday", "2026-11-22T00:00:00-05:00", true),
    ];
    expect(on(buildMonth("2026-10", events), "2026-10-31")).toEqual([
      "edt",
      "est",
    ]);
    const weeks = buildMonth("2026-11", events);
    expect(on(weeks, "2026-11-01")).toEqual(["cutoff", "night"]);
    expect(on(weeks, "2026-11-22")).toEqual(["allday"]);
  });

  test("across the start of DST", () => {
    const weeks = buildMonth("2027-03", [
      event("small", "2027-03-14T01:30:00-05:00"),
      event("skipped", "2027-03-14T03:30:00-04:00"), // just after 2 am became 3
      event("cutoff", "2027-03-14T04:00:00-04:00"),
      event("night", "2027-03-14T23:30:00-04:00"), // 03:30Z on the 15th
    ]);
    expect(on(weeks, "2027-03-13")).toEqual(["small", "skipped"]);
    expect(on(weeks, "2027-03-14")).toEqual(["cutoff", "night"]);
  });
});
