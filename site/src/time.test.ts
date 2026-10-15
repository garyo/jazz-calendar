import { describe, expect, test } from "bun:test";
import {
  addDays,
  dayKey,
  eventEndLabel,
  eventTimeLabel,
  formatClock,
  formatDate,
  formatDayHeading,
  formatUpdated,
  weekday,
} from "./time";
import type { CalendarEvent } from "./types";

// Display must not depend on the viewer's zone; run as if far from Boston.
process.env.TZ = "Asia/Tokyo";

const at = (iso: string) => new Date(iso);

describe("dayKey", () => {
  test("uses the Boston-local date, not UTC or the host's zone", () => {
    expect(dayKey(at("2026-10-15T23:30:00-04:00"))).toBe("2026-10-15");
    expect(dayKey(at("2026-10-16T03:30:00Z"))).toBe("2026-10-15");
    expect(dayKey(at("2026-10-16T04:00:00Z"))).toBe("2026-10-16");
  });

  test("tracks the offset change when DST ends", () => {
    // 04:30Z is 00:30 EDT on Nov 1; 04:30Z a day later is 23:30 EST on Nov 1.
    expect(dayKey(at("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
    expect(dayKey(at("2026-11-02T04:30:00Z"))).toBe("2026-11-01");
  });
});

describe("day arithmetic", () => {
  test("addDays crosses month and DST boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-03-08", -1)).toBe("2026-03-07");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("weekday and heading", () => {
    expect(weekday("2026-10-15")).toBe(4);
    expect(weekday("2026-10-18")).toBe(0);
    expect(formatDayHeading("2026-10-15")).toBe("Thursday, Oct 15");
    expect(formatDayHeading("2026-11-01")).toBe("Sunday, Nov 1");
  });
});

describe("clock formatting", () => {
  test("drops :00 and lowercases the period", () => {
    expect(formatClock(at("2026-10-15T20:00:00-04:00"))).toBe("8 pm");
    expect(formatClock(at("2026-10-15T20:15:00-04:00"))).toBe("8:15 pm");
    expect(formatClock(at("2026-10-17T11:00:00-04:00"))).toBe("11 am");
    expect(formatClock(at("2026-10-17T00:00:00-04:00"))).toBe("12 am");
  });

  test("converts UTC instants with the right offset on each side of DST", () => {
    expect(formatClock(at("2026-10-31T01:00:00Z"))).toBe("9 pm"); // EDT
    expect(formatClock(at("2026-11-02T01:00:00Z"))).toBe("8 pm"); // EST
    // Both 1:30s on the night clocks fall back.
    expect(formatClock(at("2026-11-01T05:30:00Z"))).toBe("1:30 am");
    expect(formatClock(at("2026-11-01T06:30:00Z"))).toBe("1:30 am");
    // Spring forward skips 2–3 am.
    expect(formatClock(at("2026-03-08T07:30:00Z"))).toBe("3:30 am");
  });
});

describe("eventTimeLabel", () => {
  const base: CalendarEvent = {
    id: "x",
    title: "Show",
    start: "2026-10-24T00:00:00-04:00",
    venue: "v",
    url: "https://example.com",
    relevance: "jazz",
    sources: [],
  };

  test("all-day listings", () => {
    expect(eventTimeLabel({ ...base, all_day: true })).toBe("Time TBA");
    expect(
      eventTimeLabel({
        ...base,
        all_day: true,
        end: "2026-10-25T00:00:00-04:00",
      }),
    ).toBe("All day");
  });

  test("timed listings show the start, with the end separately", () => {
    const timed = {
      ...base,
      start: "2026-10-15T19:30:00-04:00",
      end: "2026-10-15T21:00:00-04:00",
    };
    expect(eventTimeLabel(timed)).toBe("7:30 pm");
    expect(eventEndLabel(timed)).toBe("to 9 pm");
    expect(eventEndLabel({ ...timed, end: null })).toBeNull();
    expect(eventEndLabel({ ...timed, end: timed.start })).toBeNull();
    expect(eventEndLabel({ ...timed, end: "2026-10-16T01:00:00-04:00" })).toBe(
      "to 1 am",
    );
  });
});

test("formatUpdated", () => {
  const now = at("2026-10-15T12:00:00-04:00");
  expect(formatUpdated(at("2026-10-15T06:00:00-04:00"), now)).toBe(
    "today at 6 am",
  );
  expect(formatUpdated(at("2026-10-14T23:30:00-04:00"), now)).toBe(
    "yesterday at 11:30 pm",
  );
  expect(formatUpdated(at("2026-10-12T06:00:00-04:00"), now)).toBe(
    "Oct 12 at 6 am",
  );
});

test("formatDate", () => {
  expect(formatDate("2026-10-15")).toBe("Oct 15, 2026");
  expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
  expect(formatDate("Oct 15")).toBeNull();
});
