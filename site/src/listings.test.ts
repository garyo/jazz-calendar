import { describe, expect, test } from "bun:test";
import {
  byName,
  extraArtists,
  filterEvents,
  filterRegulars,
  groupByDay,
  isOnNow,
  isUpcoming,
  matchingEvents,
  normalize,
  presetRange,
  regularsIntro,
  regularsNotice,
  runsOn,
  sortName,
  stripDays,
  venueLocation,
  venuesWithListings,
} from "./listings";
import type { CalendarEvent, EventsFile, Regular } from "./types";
import { DEFAULT_STATE, type ViewState } from "./url-state";

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
const shown = (state: Partial<ViewState>, now: string) =>
  ids(
    filterEvents(
      sample.events,
      venues,
      { ...DEFAULT_STATE, ...state },
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
      "e1ac",
      "e1a7",
      "e1a8",
    ]);
    expect(shown({ when: "week" }, evening)).not.toContain("e1ab");
  });

  test("tonight includes its after-midnight sets", () => {
    const friday = "2026-10-16T19:00:00-04:00";
    expect(shown({ when: "tonight" }, friday)).toEqual([
      "e1a5",
      "e1a6",
      "e1ac",
    ]);
  });

  test("until 4 am, tonight is still the evening before", () => {
    const small = "2026-10-17T01:00:00-04:00"; // Saturday, 1 am
    expect(shown({ when: "tonight" }, small)).toEqual(["e1ac"]);
    expect(shown({ when: "weekend" }, small)).toEqual(["e1ac", "e1a7", "e1a8"]);
    const dawn = "2026-10-17T04:00:00-04:00";
    expect(shown({ when: "tonight" }, dawn)).toEqual(["e1a7"]);
  });

  test("a set crossing midnight stays on its night while it runs", () => {
    expect(shown({ when: "tonight" }, "2026-10-17T01:59:00-04:00")).toEqual([
      "e1ac",
    ]);
    expect(shown({ when: "tonight" }, "2026-10-17T02:00:00-04:00")).toEqual([]);
  });

  test("jazz-adjacent toggle", () => {
    expect(shown({}, evening)).toContain("e1a6");
    expect(shown({ adjacent: false }, evening)).not.toContain("e1a6");
  });

  test("towns", () => {
    expect(shown({ towns: ["Belmont"] }, evening)).toEqual(["e1a7"]);
    expect(shown({ towns: ["Belmont", "Cambridge"] }, evening)).toEqual([
      "e1a3",
      "e1a4",
      "e1a6",
      "e1a7",
      "e1ab",
    ]);
  });

  test("venues", () => {
    expect(shown({ venues: ["wallys"] }, evening)).toEqual(["e1a2"]);
    expect(shown({ venues: ["wallys", "scullers"] }, evening)).toEqual([
      "e1a2",
      "e1a5",
    ]);
  });

  test("venues and towns together: either one matches", () => {
    expect(shown({ venues: ["wallys"], towns: ["Belmont"] }, evening)).toEqual([
      "e1a2",
      "e1a7",
    ]);
  });

  test("a single day replaces the date preset", () => {
    expect(shown({ day: "2026-10-16", when: "tonight" }, evening)).toEqual([
      "e1a5",
      "e1a6",
      "e1ac",
    ]);
    expect(shown({ day: "2026-10-17" }, evening)).toEqual(["e1a7"]);
    expect(shown({ day: "2026-10-14" }, evening)).toEqual([]);
  });

  test("search matches title, artists and venue, ignoring accents and apostrophes", () => {
    expect(shown({ query: "vance chen" }, evening)).toEqual(["e1a3"]);
    expect(shown({ query: "WALLYS" }, evening)).toEqual(["e1a2"]);
    expect(shown({ query: "cafe" }, evening)).toEqual(["e1a2"]);
    expect(shown({ query: "scullers" }, evening)).toEqual(["e1a5"]);
    expect(shown({ query: "nobody plays here" }, evening)).toEqual([]);
  });
});

const regular = (fields: Partial<Regular>): Regular => ({
  venue: "wallys",
  title: "Jam",
  when: "in words",
  relevance: "jazz",
  url: "https://example.com/",
  checked: "2026-10-15",
  ...fields,
});

describe("runsOn", () => {
  test("weekly: any of its weekdays", () => {
    const jam = regular({ days: ["tue", "wed", "thu", "fri", "sat"] });
    expect(runsOn(jam, "2026-10-19")).toBe(false); // Mon
    expect(runsOn(jam, "2026-10-20")).toBe(true); // Tue
    expect(runsOn(jam, "2026-10-24")).toBe(true); // Sat
    expect(runsOn(jam, "2026-10-25")).toBe(false); // Sun
  });

  test("1st and 3rd Fridays", () => {
    const jam = regular({ days: ["fri"], nth: [1, 3] });
    const fridays = ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"];
    expect(fridays.map((day) => runsOn(jam, day))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(runsOn(jam, "2026-10-30")).toBe(false); // the 5th
    expect(runsOn(jam, "2026-10-01")).toBe(false); // 1st Thursday
  });

  test("the last of a month's weekdays", () => {
    const jam = regular({ days: ["sun"], nth: [-1] });
    expect(runsOn(jam, "2026-11-22")).toBe(false);
    expect(runsOn(jam, "2026-11-29")).toBe(true);
    expect(runsOn(jam, "2027-02-28")).toBe(true); // the 4th is the last
  });

  test("a regular from a feed without days runs on no particular day", () => {
    expect(runsOn(regular({}), "2026-10-15")).toBe(false);
  });
});

describe("filterRegulars", () => {
  const regulars = sample.regulars ?? [];
  const today = "2026-10-15"; // Thursday
  const titles = (state: Partial<ViewState>) =>
    filterRegulars(regulars, venues, { ...DEFAULT_STATE, ...state }, today).map(
      (r) => r.title,
    );
  const all = ["Jam session", "Saturday band sessions"];

  test("the sample has a jazz and a jazz-adjacent regular", () => {
    expect(titles({})).toEqual(all);
  });

  test("a view of some days shows the regulars that usually run on them", () => {
    expect(titles({ when: "tonight" })).toEqual(["Jam session"]);
    expect(titles({ when: "weekend" })).toEqual(all);
    expect(titles({ when: "week" })).toEqual(all);
    expect(titles({ day: "2026-10-17" })).toEqual(all);
    expect(titles({ day: "2026-10-18" })).toEqual([]);
  });

  test("a venue's regular shows tonight with the venue selected", () => {
    expect(titles({ when: "tonight", venues: ["wallys"] })).toEqual([
      "Jam session",
    ]);
  });

  test("jazz-adjacent toggle", () => {
    expect(titles({ adjacent: false })).toEqual(["Jam session"]);
  });

  test("towns and venues", () => {
    expect(titles({ towns: ["Belmont"] })).toEqual(["Saturday band sessions"]);
    expect(titles({ towns: ["Cambridge"] })).toEqual([]);
    expect(titles({ venues: ["wallys"] })).toEqual(["Jam session"]);
    expect(titles({ venues: ["wallys"], towns: ["Belmont"] })).toEqual(all);
  });

  test("search matches title and venue, not the schedule", () => {
    expect(titles({ query: "wallys jam" })).toEqual(["Jam session"]);
    expect(titles({ query: "band sessions" })).toEqual([
      "Saturday band sessions",
    ]);
    expect(titles({ query: "wellington" })).toEqual(["Saturday band sessions"]);
    expect(titles({ query: "tuesday" })).toEqual([]);
  });

  test("a regular at an unknown venue is dropped only by a selection", () => {
    const orphan = regular({ venue: "nowhere", days: ["mon"] });
    const filter = (state: Partial<ViewState>) =>
      filterRegulars([orphan], venues, { ...DEFAULT_STATE, ...state }, today);
    expect(filter({})).toHaveLength(1);
    expect(filter({ towns: ["Boston"] })).toEqual([]);
  });

  test("a regular without days shows only when dates don't apply", () => {
    const filter = (state: Partial<ViewState>) =>
      filterRegulars(
        [regular({})],
        venues,
        { ...DEFAULT_STATE, ...state },
        today,
      );
    expect(filter({})).toHaveLength(1);
    expect(filter({ when: "week" })).toEqual([]);
  });
});

describe("regulars' wording", () => {
  const today = "2026-10-15"; // Thursday
  const view = (state: Partial<ViewState>) => ({ ...DEFAULT_STATE, ...state });
  const regulars = sample.regulars ?? [];

  test("the introduction names the view's weekdays", () => {
    expect(regularsIntro(view({}), today)).toStartWith(
      "Standing series the venues list without specific dates.",
    );
    expect(regularsIntro(view({ when: "tonight" }), today)).toStartWith(
      "Standing series that usually run on Thursdays. ",
    );
    expect(regularsIntro(view({ when: "weekend" }), today)).toStartWith(
      "Standing series that usually run on Fridays, Saturdays, or Sundays. ",
    );
    expect(regularsIntro(view({ when: "week" }), today)).toStartWith(
      "Standing series that usually run in the next 7 days. ",
    );
  });

  test("with no dated shows, the notice points to the regulars", () => {
    const wallys = regulars.filter((r) => r.venue === "wallys");
    expect(
      regularsNotice(wallys, venues, view({ when: "tonight" }), today),
    ).toEqual({
      title: "No listed shows tonight.",
      body: "But this weekly series usually runs on Thursdays: Jam session at Wally's Café. Check with the venue before you go.",
    });
    expect(
      regularsNotice(regulars, venues, view({ day: "2026-10-17" }), today),
    ).toEqual({
      title: "No listed shows on Saturday, Oct 17.",
      body: "But these weekly series usually run on Saturdays: Jam session at Wally's Café and Saturday band sessions at The Wellington. Check with the venue before you go.",
    });
    expect(
      regularsNotice(regulars, venues, view({ day: today }), today)?.title,
    ).toBe("No listed shows tonight.");
  });

  test("no notice without regulars, or when dates don't apply", () => {
    expect(regularsNotice([], venues, view({ when: "tonight" }), today)).toBe(
      null,
    );
    expect(regularsNotice(regulars, venues, view({}), today)).toBeNull();
  });
});

describe("matchingEvents", () => {
  test("ignores dates, including past shows, but not filters", () => {
    const state = { ...DEFAULT_STATE, when: "tonight" as const };
    expect(ids(matchingEvents(sample.events, venues, state))).toEqual(
      ids(sample.events),
    );
    expect(
      ids(
        matchingEvents(sample.events, venues, { ...state, query: "scullers" }),
      ),
    ).toEqual(["e1a5"]);
  });
});

describe("groupByDay", () => {
  test("groups sorted events by night", () => {
    const groups = groupByDay(sample.events, "2026-10-15");
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([
      ["2026-10-15", 3],
      ["2026-10-16", 3],
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

  test("keeps a night together around an all-day listing at midnight", () => {
    const evening = { ...byId("e1a5"), id: "evening" };
    const allDay = { ...byId("e1ab"), id: "allday" };
    const late = { ...byId("e1ac"), id: "late" };
    const groups = groupByDay(
      [
        { ...evening, start: "2026-10-23T21:00:00-04:00" },
        { ...allDay, start: "2026-10-24T00:00:00-04:00" },
        { ...late, start: "2026-10-24T00:30:00-04:00" },
      ],
      "2026-10-15",
    );
    expect(groups.map((g) => [g.day, ids(g.events)])).toEqual([
      ["2026-10-23", ["evening", "late"]],
      ["2026-10-24", ["allday"]],
    ]);
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

  test("venuesWithListings sorts by town, then name without 'The'", () => {
    const listed = (listings: { venue: string }[]) =>
      venuesWithListings(listings, venues).map((v) => v.id);
    expect(listed(sample.regulars ?? [])).toEqual([
      "wellington-belmont",
      "wallys",
    ]);
    const cambridge = listed(sample.events).filter(
      (id) => venues.get(id)?.town === "Cambridge",
    );
    expect(cambridge).toEqual(["lilypad", "lizard-lounge", "mad-monkfish"]);
  });

  test("sortName", () => {
    expect(sortName("The Lilypad")).toBe("lilypad");
    expect(sortName("Theatre Bar")).toBe("theatre bar");
  });

  test("byName files a leading The under the next word", () => {
    expect(["The Lilypad", "Jazz Lab", "the Abbey"].sort(byName)).toEqual([
      "the Abbey",
      "Jazz Lab",
      "The Lilypad",
    ]);
  });
});

describe("stripDays", () => {
  const group = (day: string, count: number) => ({
    day,
    events: sample.events.slice(0, count),
  });

  test("covers every day from the first group to the last", () => {
    expect(stripDays([group("2026-10-30", 2), group("2026-11-02", 1)])).toEqual(
      [
        { day: "2026-10-30", count: 2 },
        { day: "2026-10-31", count: 0 },
        { day: "2026-11-01", count: 0 },
        { day: "2026-11-02", count: 1 },
      ],
    );
  });

  test("stops at the limit", () => {
    const days = stripDays([group("2026-10-15", 1), group("2026-12-01", 1)], 7);
    expect(days.map((d) => d.day)).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]);
  });

  test("makes no strip for a single day or none", () => {
    expect(stripDays([])).toEqual([]);
    expect(stripDays([group("2026-10-15", 3)])).toEqual([]);
  });
});
