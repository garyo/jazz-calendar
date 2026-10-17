import { describe, expect, test } from "bun:test";
import { scheduleText, venueSlug } from "./submission";
import type { Weekday } from "./types";

describe("venueSlug", () => {
  test("drops a leading 'the', accents and apostrophes", () => {
    expect(venueSlug("The Example Room")).toBe("example-room");
    expect(venueSlug("Pat's Café & Bar!")).toBe("pats-cafe-bar");
    expect(venueSlug("Theater 12")).toBe("theater-12");
  });
});

describe("scheduleText", () => {
  const text = (
    days: Weekday[],
    nth: number[] = [],
    start_time: string | null = null,
    end_time: string | null = null,
  ) => scheduleText({ days, nth, start_time, end_time });

  test("says which days", () => {
    expect(text(["thu"])).toBe("Thursdays");
    expect(text(["sun", "sat"])).toBe("Saturdays and Sundays");
    expect(text(["sat", "tue", "wed", "thu", "fri"])).toBe("Tuesday–Saturday");
    expect(text(["mon", "wed", "fri"])).toBe(
      "Mondays, Wednesdays, and Fridays",
    );
  });

  test("says which weeks of the month", () => {
    expect(text(["fri"], [1, 3])).toBe("1st and 3rd Fridays");
    expect(text(["sun"], [-1])).toBe("Last Sundays");
    expect(text(["tue", "wed", "thu"], [2])).toBe(
      "2nd Tuesdays, Wednesdays, and Thursdays",
    );
  });

  test("adds the time, sharing am or pm across a range", () => {
    expect(text(["thu"], [], "18:00", "21:00")).toBe("Thursdays, 6–9 pm");
    expect(text(["sun"], [], "11:30", "14:00")).toBe("Sundays, 11:30 am–2 pm");
    expect(text(["sat"], [], "19:30")).toBe("Saturdays, 7:30 pm");
  });
});
