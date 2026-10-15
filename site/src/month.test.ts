import { describe, expect, test } from "bun:test";
import { buildMonth } from "./month";
import type { CalendarEvent } from "./types";

// Placement must not depend on the viewer's zone.
process.env.TZ = "Asia/Tokyo";

const event = (id: string, start: string): CalendarEvent => ({
  id,
  title: id,
  start,
  venue: "lilypad",
  url: "https://example.com/",
  relevance: "jazz",
  sources: ["test"],
});

const days = (weeks: ReturnType<typeof buildMonth>) => weeks.flat();

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

  test("events go on their Boston-local start day, after-midnight sets included", () => {
    const weeks = buildMonth("2026-10", [
      event("evening", "2026-10-16T21:00:00-04:00"), // 01:00Z on the 17th
      event("utc", "2026-10-17T03:30:00Z"), // 11:30 pm on the 16th
      event("late", "2026-10-17T00:30:00-04:00"), // after midnight: the 17th
      event("neighbor", "2026-09-28T20:00:00-04:00"),
      event("outside", "2026-11-12T20:00:00-05:00"),
    ]);
    const on = (day: string) =>
      days(weeks)
        .find((d) => d.day === day)
        ?.events.map((e) => e.id);
    expect(on("2026-10-16")).toEqual(["evening", "utc"]);
    expect(on("2026-10-17")).toEqual(["late"]);
    expect(on("2026-09-28")).toEqual(["neighbor"]);
    expect(days(weeks).flatMap((d) => d.events.map((e) => e.id))).not.toContain(
      "outside",
    );
  });

  test("across the end of DST", () => {
    const weeks = buildMonth("2026-11", [
      event("edt", "2026-11-01T01:30:00-04:00"),
      event("est", "2026-11-01T23:30:00-05:00"), // 04:30Z on the 2nd
      event("allday", "2026-11-22T00:00:00-05:00"),
    ]);
    expect(weeks[0][0].events.map((e) => e.id)).toEqual(["edt", "est"]);
    expect(
      days(weeks)
        .find((d) => d.day === "2026-11-22")
        ?.events.map((e) => e.id),
    ).toEqual(["allday"]);
  });

  test("across the start of DST", () => {
    const weeks = buildMonth("2027-03", [
      event("before", "2027-03-14T01:30:00-05:00"),
      event("after", "2027-03-14T23:30:00-04:00"), // 03:30Z on the 15th
    ]);
    expect(
      days(weeks)
        .find((d) => d.day === "2027-03-14")
        ?.events.map((e) => e.id),
    ).toEqual(["before", "after"]);
  });
});
