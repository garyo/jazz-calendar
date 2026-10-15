import { describe, expect, test } from "bun:test";
import {
  extraArtists,
  filterEvents,
  filterRegulars,
  groupByDay,
  isOnNow,
  isUpcoming,
  normalize,
  presetRange,
  townsWithListings,
  venueLocation,
} from "./listings";
import type { CalendarEvent, EventsFile, Regular } from "./types";
import { DEFAULT_FILTERS, type Filters } from "./url-state";

const sample: EventsFile = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).json();
const venues = new Map(sample.venues.map((venue) => [venue.id, venue]));
const byId = (id: string) => {
  const event = sample.events.find((e) => e.id === id);
  if (!event) throw new Error(`no sample event ${id}`);
  return event;
};

const at = (iso: string) => new Date(iso);
const ids = (events: CalendarEvent[]) => events.map((e) => e.id);
const shown = (filters: Partial<Filters>, now: string) =>
  ids(
    filterEvents(
      sample.events,
      venues,
      { ...DEFAULT_FILTERS, ...filters },
      at(now),
    ),
  );

describe("isUpcoming", () => {
  const jam = byId("e1a2"); // 7–9 pm Oct 15
  const lateSet = byId("e1a4"); // 9 pm Oct 15, no end
  const festival = byId("e1ab"); // all day Oct 24

  test("keeps a show until its end", () => {
    expect(isUpcoming(jam, at("2026-10-15T20:59:00-04:00"))).toBe(true);
    expect(isUpcoming(jam, at("2026-10-15T21:00:00-04:00"))).toBe(false);
  });

  test("keeps a show with no end for a few hours after it starts", () => {
    expect(isUpcoming(lateSet, at("2026-10-15T23:59:00-04:00"))).toBe(true);
    expect(isUpcoming(lateSet, at("2026-10-16T00:01:00-04:00"))).toBe(false);
  });

  test("keeps all-day listings through their Boston-local day", () => {
    expect(isUpcoming(festival, at("2026-10-24T23:59:00-04:00"))).toBe(true);
    expect(isUpcoming(festival, at("2026-10-25T00:00:00-04:00"))).toBe(false);
  });

  test("isOnNow", () => {
    expect(isOnNow(jam, at("2026-10-15T19:30:00-04:00"))).toBe(true);
    expect(isOnNow(jam, at("2026-10-15T18:59:00-04:00"))).toBe(false);
    expect(isOnNow(festival, at("2026-10-24T12:00:00-04:00"))).toBe(false);
  });
});

describe("presetRange", () => {
  test("tonight and next 7 days", () => {
    expect(presetRange("tonight", "2026-10-15")).toEqual({
      from: "2026-10-15",
      to: "2026-10-15",
    });
    expect(presetRange("week", "2026-10-15")).toEqual({
      from: "2026-10-15",
      to: "2026-10-21",
    });
    expect(presetRange("all", "2026-10-15")).toBeNull();
  });

  test("this weekend is Friday through Sunday", () => {
    const weekend = (today: string) => presetRange("weekend", today);
    expect(weekend("2026-10-15")).toEqual({
      from: "2026-10-16",
      to: "2026-10-18",
    }); // Thu
    expect(weekend("2026-10-16")).toEqual({
      from: "2026-10-16",
      to: "2026-10-18",
    }); // Fri
    expect(weekend("2026-10-17")).toEqual({
      from: "2026-10-17",
      to: "2026-10-18",
    }); // Sat
    expect(weekend("2026-10-18")).toEqual({
      from: "2026-10-18",
      to: "2026-10-18",
    }); // Sun
    expect(weekend("2026-10-19")).toEqual({
      from: "2026-10-23",
      to: "2026-10-25",
    }); // Mon
  });
});

describe("filterEvents", () => {
  const evening = "2026-10-15T20:00:00-04:00";

  test("everything upcoming, including a show in progress", () => {
    expect(shown({}, evening)).toEqual(ids(sample.events));
    expect(shown({}, "2026-10-15T21:30:00-04:00")).not.toContain("e1a2");
  });

  test("date presets", () => {
    expect(shown({ when: "tonight" }, evening)).toEqual([
      "e1a2",
      "e1a3",
      "e1a4",
    ]);
    expect(shown({ when: "weekend" }, evening)).toEqual([
      "e1a5",
      "e1a6",
      "e1a7",
      "e1a8",
    ]);
    expect(shown({ when: "week" }, evening)).not.toContain("e1ab");
  });

  test("jazz-adjacent toggle", () => {
    expect(shown({}, evening)).toContain("e1a6");
    expect(shown({ adjacent: false }, evening)).not.toContain("e1a6");
  });

  test("town", () => {
    expect(shown({ town: "Belmont" }, evening)).toEqual(["e1a7"]);
  });

  test("search matches title, artists and venue, ignoring accents and apostrophes", () => {
    expect(shown({ query: "vance chen" }, evening)).toEqual(["e1a3"]);
    expect(shown({ query: "WALLYS" }, evening)).toEqual(["e1a2"]);
    expect(shown({ query: "cafe" }, evening)).toEqual(["e1a2"]);
    expect(shown({ query: "scullers" }, evening)).toEqual(["e1a5"]);
    expect(shown({ query: "nobody plays here" }, evening)).toEqual([]);
  });
});

describe("filterRegulars", () => {
  const regulars = sample.regulars ?? [];
  const titles = (filters: Partial<Filters>) =>
    filterRegulars(regulars, venues, { ...DEFAULT_FILTERS, ...filters }).map(
      (r) => r.title,
    );
  const all = ["Jam session", "Saturday band sessions"];

  test("the sample has a jazz and a jazz-adjacent regular", () => {
    expect(titles({})).toEqual(all);
  });

  test("date presets don't apply", () => {
    expect(titles({ when: "tonight" })).toEqual(all);
    expect(titles({ when: "weekend" })).toEqual(all);
  });

  test("jazz-adjacent toggle", () => {
    expect(titles({ adjacent: false })).toEqual(["Jam session"]);
  });

  test("town", () => {
    expect(titles({ town: "Belmont" })).toEqual(["Saturday band sessions"]);
    expect(titles({ town: "Cambridge" })).toEqual([]);
  });

  test("search matches title and venue, not the schedule", () => {
    expect(titles({ query: "wallys jam" })).toEqual(["Jam session"]);
    expect(titles({ query: "band sessions" })).toEqual([
      "Saturday band sessions",
    ]);
    expect(titles({ query: "wellington" })).toEqual(["Saturday band sessions"]);
    expect(titles({ query: "tuesday" })).toEqual([]);
  });

  test("a regular at an unknown venue is dropped only by the town filter", () => {
    const orphan: Regular = {
      venue: "nowhere",
      title: "Mystery jam",
      when: "Mondays",
      relevance: "jazz",
      url: "https://example.com/",
      checked: "2026-10-15",
    };
    expect(filterRegulars([orphan], venues, DEFAULT_FILTERS)).toHaveLength(1);
    expect(
      filterRegulars([orphan], venues, { ...DEFAULT_FILTERS, town: "Boston" }),
    ).toEqual([]);
  });
});

describe("groupByDay", () => {
  test("groups sorted events by Boston-local day", () => {
    const groups = groupByDay(sample.events, "2026-10-15");
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([
      ["2026-10-15", 3],
      ["2026-10-16", 2],
      ["2026-10-17", 1],
      ["2026-10-18", 1],
      ["2026-10-20", 1],
      ["2026-10-21", 1],
      ["2026-10-24", 1],
    ]);
  });

  test("uses Boston days for UTC timestamps near midnight", () => {
    const late = { ...byId("e1a4"), start: "2026-10-16T03:30:00Z" };
    expect(groupByDay([late], "2026-10-15")[0]?.day).toBe("2026-10-15");
  });

  test("lists a still-running show under today", () => {
    const ongoing = { ...byId("e1a2"), start: "2026-10-14T23:00:00-04:00" };
    expect(groupByDay([ongoing], "2026-10-15")[0]?.day).toBe("2026-10-15");
  });
});

describe("display helpers", () => {
  test("extraArtists drops names already in the title", () => {
    expect(extraArtists(byId("e1a3"))).toEqual(["Theo Marsh", "Ida Chen"]);
    expect(extraArtists(byId("e1a5"))).toEqual([]);
    expect(extraArtists(byId("e1a2"))).toEqual([]);
  });

  test("venueLocation", () => {
    const lilypad = venues.get("lilypad");
    expect(lilypad && venueLocation(lilypad)).toBe("Inman Square, Cambridge");
    const plain = {
      id: "x",
      name: "X",
      town: "Salem",
      jazz_level: "regular" as const,
    };
    expect(venueLocation(plain)).toBe("Salem");
  });

  test("normalize", () => {
    expect(normalize("Wally’s Café")).toBe("wallys cafe");
  });

  test("townsWithListings", () => {
    expect(townsWithListings(sample.events, venues)).toEqual([
      "Belmont",
      "Boston",
      "Cambridge",
    ]);
    expect(townsWithListings(sample.regulars ?? [], venues)).toEqual([
      "Belmont",
      "Boston",
    ]);
  });
});
