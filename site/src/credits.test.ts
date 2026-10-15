import { describe, expect, test } from "bun:test";
import { creditsById, sourceList, viaCredits, viaLine } from "./credits";
import type { CalendarEvent, EventsFile, SourceCredit } from "./types";

const sample: EventsFile = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).json();
const venues = new Map(sample.venues.map((venue) => [venue.id, venue]));
const credits = creditsById(sample.sources);
const byId = (id: string) =>
  sample.events.find((event) => event.id === id) as CalendarEvent;

const ticketmaster: SourceCredit = {
  id: "tm-club",
  name: "Ticketmaster",
  url: "https://www.ticketmaster.com",
  via: true,
};

describe("the sample feed's types", () => {
  test("every source an event lists is credited", () => {
    for (const event of sample.events) {
      for (const id of event.sources) expect(credits.has(id)).toBe(true);
    }
  });

  test("credits link to https pages", () => {
    for (const credit of sample.sources ?? []) {
      expect(credit.name).not.toBe("");
      expect(credit.url).toStartWith("https://");
      expect(typeof credit.via).toBe("boolean");
    }
  });

  test("an older feed without sources credits nothing", () => {
    expect(creditsById(undefined).size).toBe(0);
    expect(viaCredits(byId("e1a5"), creditsById(undefined))).toEqual([]);
  });
});

describe("viaCredits", () => {
  test("a listing from the venue's own calendar has none", () => {
    expect(viaCredits(byId("e1a3"), credits)).toEqual([]);
  });

  test("a listing through a third party credits it", () => {
    expect(viaCredits(byId("e1a5"), credits).map((c) => c.name)).toEqual([
      "Ticketmaster",
    ]);
  });

  test("any third party among merged sources counts, once per name", () => {
    const merged = {
      ...byId("e1a5"),
      sources: ["lilypad", "scullers-tm", "tm-club", "submissions"],
    };
    const all = new Map([...credits, [ticketmaster.id, ticketmaster]]);
    expect(viaCredits(merged, all).map((c) => c.name)).toEqual([
      "Ticketmaster",
      "gig submission",
    ]);
  });

  test("the calendar line", () => {
    expect(viaLine(ticketmaster)).toBe(
      "Listing via Ticketmaster: https://www.ticketmaster.com",
    );
  });
});

describe("sourceList", () => {
  const list = sourceList(sample.sources ?? [], sample.events, venues);

  test("own calendars sorted by name, ignoring a leading 'The'", () => {
    expect(list.own.map((entry) => entry.name)).toEqual([
      "The Lilypad’s calendar",
      "Lizard Lounge’s calendar",
      "The Mad Monkfish’s jazz schedule",
      "New England Conservatory’s calendar",
      "Vivo Performing Arts",
      "Wally’s Café’s calendar",
      "The Wellington’s calendar",
    ]);
  });

  test("third parties with the venues they supply, submissions left out", () => {
    expect(list.via).toEqual([
      {
        name: "Ticketmaster",
        url: "https://www.ticketmaster.com",
        venues: ["Scullers Jazz Club"],
      },
    ]);
  });

  test("sources sharing a name are listed once, with all their venues", () => {
    const events = [
      { ...byId("e1a5"), sources: ["scullers-tm"] },
      { ...byId("e1a3"), sources: [ticketmaster.id] },
    ];
    const { via } = sourceList(
      [...(sample.sources ?? []), ticketmaster],
      events,
      venues,
    );
    expect(via).toHaveLength(1);
    expect(via[0]?.venues).toEqual(["The Lilypad", "Scullers Jazz Club"]);
  });
});
