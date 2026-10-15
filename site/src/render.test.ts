import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { creditsById, sourceList } from "./credits";
import { renderDays, renderSourceList } from "./render";
import type { CalendarEvent, EventsFile } from "./types";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const sample: EventsFile = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).json();
const venues = new Map(sample.venues.map((venue) => [venue.id, venue]));
const credits = creditsById(sample.sources);
const byId = (id: string) =>
  sample.events.find((event) => event.id === id) as CalendarEvent;
const now = new Date("2026-10-15T12:00:00-04:00");

function row(event: CalendarEvent): HTMLElement {
  const fragment = renderDays(
    [{ day: "2026-10-16", events: [event] }],
    venues,
    credits,
    now,
    "2026-10-15",
  );
  const li = fragment.querySelector<HTMLElement>("li.event");
  if (!li) throw new Error("no event row");
  return li;
}

describe("a listing's credit", () => {
  test("a third party's listing says 'via' it, linked in a new tab", () => {
    const via = row(byId("e1a5")).querySelector(".event-extra .event-via");
    expect(via?.textContent).toBe("via Ticketmaster (opens in a new tab)");
    const link = via?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://www.ticketmaster.com/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  test("a venue's own listing has none", () => {
    expect(row(byId("e1a3")).querySelector(".event-via")).toBeNull();
  });

  test("the credit alone is enough for the small print", () => {
    const bare = { ...byId("e1a8"), price: null, ticket_url: null, tags: [] };
    const extra = row(bare).querySelector(".event-extra");
    expect(extra?.textContent).toStartWith("via gig submission");
  });

  test("an older feed without sources shows no credit", () => {
    const fragment = renderDays(
      [{ day: "2026-10-16", events: [byId("e1a5")] }],
      venues,
      creditsById(undefined),
      now,
      "2026-10-15",
    );
    expect(fragment.querySelector(".event-via")).toBeNull();
  });
});

describe("an after-midnight set", () => {
  test("shows its real time, marked late", () => {
    const time = row(byId("e1ac")).querySelector(".event-time");
    expect(time?.querySelector("time")?.textContent).toBe("12 am12a");
    expect(time?.querySelector(".event-late")?.textContent).toBe(
      "late (after midnight)",
    );
  });

  test("an evening set isn't marked", () => {
    expect(row(byId("e1a5")).querySelector(".event-late")).toBeNull();
  });
});

describe("renderSourceList", () => {
  const render = () =>
    renderSourceList(sourceList(sample.sources ?? [], sample.events, venues));
  const container = () => {
    const div = document.createElement("div");
    div.append(...render());
    return div;
  };

  test("two groups, each a heading and a list", () => {
    expect(render().map((node) => node.tagName)).toEqual([
      "H3",
      "UL",
      "H3",
      "UL",
    ]);
    expect(
      [...container().querySelectorAll("h3")].map((h) => h.textContent),
    ).toEqual([
      "Venues’ and presenters’ own calendars",
      "Through other services",
    ]);
  });

  test("third parties name the venues they supply", () => {
    const items = container().querySelectorAll("ul")[1]?.querySelectorAll("li");
    expect([...(items ?? [])].map((li) => li.textContent)).toEqual([
      "Ticketmaster (opens in a new tab), for Scullers Jazz Club",
    ]);
  });

  test("an empty group is left out", () => {
    expect(renderSourceList({ own: [], via: [] })).toEqual([]);
  });
});
