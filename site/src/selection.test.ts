import { describe, expect, test } from "bun:test";
import {
  calendarName,
  EVERYTHING,
  feedQuery,
  isEverything,
  knownSelection,
  matchesSelection,
  parseFeedSelection,
  parseSelection,
  type Selection,
} from "./selection";
import type { Venue } from "./types";

const venue = (id: string, name: string, town: string): Venue => ({
  id,
  name,
  town,
  jazz_level: "dedicated",
});
const list = [
  venue("lilypad", "The Lilypad", "Cambridge"),
  venue("wallys", "Wally's Café", "Boston"),
  venue("toad", "Toad", "Cambridge"),
  venue("pub", "Corner Pub", "Somerville"),
];
const venues = new Map(list.map((v) => [v.id, v]));
const select = (selection: Partial<Selection>) => ({
  ...EVERYTHING,
  ...selection,
});
const params = (search: string) => new URLSearchParams(search);

describe("matchesSelection", () => {
  const at = (id: string, relevance: "jazz" | "adjacent" = "jazz") =>
    [{ venue: id, relevance }, venues.get(id)] as const;
  const matches = (id: string, selection: Partial<Selection>) =>
    matchesSelection(...at(id), select(selection));

  test("nothing selected matches everything", () => {
    expect(matches("lilypad", {})).toBe(true);
  });

  test("venues only, or towns only", () => {
    expect(matches("lilypad", { venues: ["lilypad"] })).toBe(true);
    expect(matches("toad", { venues: ["lilypad"] })).toBe(false);
    expect(matches("toad", { towns: ["Cambridge"] })).toBe(true);
    expect(matches("wallys", { towns: ["Cambridge"] })).toBe(false);
  });

  test("venues and towns: any selected venue or any selected town", () => {
    const both = { venues: ["wallys"], towns: ["Somerville"] };
    expect(matches("wallys", both)).toBe(true);
    expect(matches("pub", both)).toBe(true);
    expect(matches("lilypad", both)).toBe(false);
  });

  test("excluding jazz-adjacent applies on top", () => {
    const listing = { venue: "lilypad", relevance: "adjacent" as const };
    const lilypad = venues.get("lilypad");
    expect(matchesSelection(listing, lilypad, select({}))).toBe(true);
    expect(
      matchesSelection(listing, lilypad, select({ adjacent: false })),
    ).toBe(false);
  });

  test("an unknown venue matches only by id", () => {
    const listing = { venue: "gone", relevance: "jazz" as const };
    expect(matchesSelection(listing, undefined, select({}))).toBe(true);
    expect(
      matchesSelection(listing, undefined, select({ towns: ["Boston"] })),
    ).toBe(false);
    expect(
      matchesSelection(listing, undefined, select({ venues: ["gone"] })),
    ).toBe(true);
  });
});

describe("parsing", () => {
  test("page URLs are lenient", () => {
    expect(
      parseSelection(params("?venue=Bad_ID,lilypad&adjacent=maybe")),
    ).toEqual(select({ venues: ["Bad_ID", "lilypad"] }));
  });

  test("feed URLs are strict", () => {
    expect(
      parseFeedSelection(params("venue=wallys,lilypad&adjacent=0")),
    ).toEqual(select({ venues: ["lilypad", "wallys"], adjacent: false }));
    expect(parseFeedSelection(params("adjacent=1"))).toEqual(EVERYTHING);
    expect(parseFeedSelection(params("adjacent=yes"))).toBeNull();
    expect(parseFeedSelection(params("venue=Bad_ID"))).toBeNull();
    expect(parseFeedSelection(params("venue=%3Cscript%3E"))).toBeNull();
    expect(parseFeedSelection(params("town=Line%0Abreak"))).toBeNull();
    const many = Array.from({ length: 65 }, (_, i) => `v${i}`).join(",");
    expect(parseFeedSelection(params(`venue=${many}`))).toBeNull();
  });
});

test("knownSelection drops unknown values but never widens to everything", () => {
  const selection = select({
    venues: ["lilypad", "nope"],
    towns: ["Cambridge", "Atlantis"],
  });
  expect(knownSelection(selection, list)).toEqual(
    select({ venues: ["lilypad"], towns: ["Cambridge"] }),
  );
  expect(knownSelection(select({ venues: ["nope"] }), list)).toBeNull();
  expect(knownSelection(EVERYTHING, list)).toEqual(EVERYTHING);
});

describe("feedQuery and names", () => {
  test("canonical query", () => {
    expect(feedQuery(EVERYTHING)).toBe("");
    expect(isEverything(EVERYTHING)).toBe(true);
    expect(
      feedQuery(
        select({
          venues: ["wallys", "lilypad"],
          towns: ["Somerville"],
          adjacent: false,
        }),
      ),
    ).toBe("venue=lilypad,wallys&town=Somerville&adjacent=0");
  });

  test("calendarName", () => {
    expect(calendarName(EVERYTHING, venues)).toBe("Boston Jazz Calendar");
    expect(
      calendarName(select({ venues: ["lilypad", "wallys"] }), venues),
    ).toBe("Boston Jazz Calendar: The Lilypad, Wally's Café");
    expect(
      calendarName(select({ towns: ["Cambridge"], adjacent: false }), venues),
    ).toBe("Boston Jazz Calendar: Cambridge (jazz only)");
    expect(
      calendarName(
        select({
          venues: ["lilypad", "wallys", "toad", "pub"],
          towns: ["Boston"],
        }),
        venues,
      ),
    ).toBe("Boston Jazz Calendar: The Lilypad, Wally's Café, Toad + 2 more");
  });
});
