import { beforeEach, describe, expect, test } from "bun:test";
import { readFeed } from "./feed";
import { MONTH_CELL_ENTRIES, renderMonth } from "./month-grid";
import { loadPage, sample, useDom } from "./testing";
import type { CalendarEvent } from "./types";
import { DEFAULT_STATE } from "./url-state";
import { isFiltered, type ListingsView, listingsView } from "./view";

useDom();

const feed = readFeed(sample);
const at = (iso: string) => new Date(iso);
const now = at("2026-10-15T12:00:00-04:00");
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
let view: ListingsView;
let cleared = 0;

beforeEach(() => {
  loadPage();
  cleared = 0;
  view = listingsView(() => cleared++);
});

describe("the list view", () => {
  test("shows every upcoming show by night, with the regulars", () => {
    view.render(DEFAULT_STATE, feed, now);
    const shows = document.querySelectorAll("#results li.event").length;
    expect(shows).toBeGreaterThan(0);
    expect($("#count")?.textContent).toBe(`${shows} shows · 2 weekly regulars`);
    expect($("#count a")?.getAttribute("href")).toBe("#regulars-heading");
    const nightsWithShows = [
      ...document.querySelectorAll("#results section.day"),
    ].filter((night) => night.querySelector("li.event"));
    expect(nightsWithShows.length).toBe(
      $("#day-strip-list")?.querySelectorAll("a").length ?? -1,
    );
    expect($("#regulars")?.hidden).toBe(false);
  });

  test("the coming week's nights list the regulars that usually run then", () => {
    view.render(DEFAULT_STATE, feed, now);
    const regularsOn = (day: string) =>
      [
        ...document.querySelectorAll(
          `#results .day[data-key="${day}"] .night-regulars li`,
        ),
      ].map(
        (li) =>
          li.querySelector(".night-regular-title")?.firstChild?.textContent,
      );
    // Thursday's dated "Wally's Jam Session" is the jam itself.
    expect(regularsOn("2026-10-15")).toEqual([]);
    expect(regularsOn("2026-10-16")).toEqual(["Jam session"]);
    expect(regularsOn("2026-10-17")).toEqual([
      "Jam session",
      "Saturday band sessions",
    ]);
    // Past the first week, nights list only their shows.
    expect(regularsOn("2026-10-23")).toEqual([]);
  });

  test("a view of some nights lists their regulars only with them", () => {
    view.render({ ...DEFAULT_STATE, when: "week" }, feed, now);
    expect($("#regulars")?.hidden).toBe(true);
    expect($("#count a")).toBeNull();
    expect($(".night-regulars")).not.toBeNull();
  });

  test("a search with no matches offers to clear the filters", () => {
    view.render({ ...DEFAULT_STATE, query: "zzzz" }, feed, now);
    expect($(".notice-title")?.textContent).toBe(
      "Nothing matches those filters.",
    );
    $(".notice button")?.click();
    expect(cleared).toBe(1);
  });

  test("a re-render keeps the nights and shows that didn't change", () => {
    const show = (id: string) =>
      document.querySelector(`#results li[data-key="${id}"]`);
    const night = (day: string) =>
      document.querySelector(`#results .day[data-key="${day}"]`);
    view.render(DEFAULT_STATE, feed, at("2026-10-15T20:00:00-04:00"));
    const tonight = night("2026-10-15");
    const later = [...document.querySelectorAll("#results li.event")].at(-1);
    const lateSet = show("e1a4");
    lateSet?.querySelector("details")?.setAttribute("open", "");

    // The jam ends and the late set starts.
    view.render(DEFAULT_STATE, feed, at("2026-10-15T21:00:00-04:00"));
    expect(show("e1a2")).toBeNull();
    expect(night("2026-10-15")).toBe(tonight);
    expect([...document.querySelectorAll("#results li.event")].at(-1)).toBe(
      later,
    );
    expect(show("e1a4")).not.toBe(lateSet);
    expect(show("e1a4")?.classList.contains("is-now")).toBe(true);

    // Nothing changes: every node stays, open menus included.
    const before = [...document.querySelectorAll("#results *")];
    show("e1a4")?.querySelector("details")?.setAttribute("open", "");
    view.render(DEFAULT_STATE, feed, at("2026-10-15T21:15:00-04:00"));
    const after = [...document.querySelectorAll("#results *")];
    expect(after.length).toBe(before.length);
    expect(after.every((node, i) => node === before[i])).toBe(true);
  });

  test("a chosen day gets a banner linking back to all dates", () => {
    view.render({ ...DEFAULT_STATE, day: "2026-10-16" }, feed, now);
    const back = $(".day-filter a") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/");
    expect($("#day-strip")?.hidden).toBe(true);
  });
});

describe("the month view", () => {
  test("draws the grid, with the regulars below it", () => {
    view.render({ ...DEFAULT_STATE, view: "month" }, feed, now);
    expect($(".month-heading")?.textContent).toBe("October 2026");
    expect($("#count")?.textContent).toEndWith(
      "in October 2026 · 2 weekly regulars",
    );
    expect($("#regulars")?.hidden).toBe(false);
    expect($("#presets")?.hidden).toBe(true);
    const day = $("a.month-day") as HTMLAnchorElement;
    expect(day.getAttribute("href")).toStartWith("?day=2026-10-");
  });

  test("lists a chosen day's shows under the grid", () => {
    view.render(
      { ...DEFAULT_STATE, view: "month", day: "2026-10-16" },
      feed,
      now,
    );
    expect($("#month-day-2026-10-16")?.closest("td")?.className).toContain(
      "is-selected",
    );
    expect($("#results > section.day")).not.toBeNull();
  });
});

test("a crowded cell lists a few shows, then a count of the rest", () => {
  const event = sample.events[0] as CalendarEvent;
  const crowd = Array.from({ length: MONTH_CELL_ENTRIES + 3 }, () => event);
  const day = "2026-10-16";
  const grid = renderMonth(
    "2026-10",
    [[{ day, inMonth: true, events: crowd }]],
    "2026-10-15",
    "",
    { day: () => "#day", month: () => "#month" },
  );
  expect(grid.querySelectorAll(".month-entry")).toHaveLength(
    MONTH_CELL_ENTRIES,
  );
  expect(grid.querySelector(".month-more")?.textContent).toBe("+3 more");
  expect(grid.querySelector(".month-day")?.getAttribute("aria-label")).toBe(
    `Friday, Oct 16: ${MONTH_CELL_ENTRIES + 3} shows`,
  );
});

test("isFiltered ignores the view and month", () => {
  expect(
    isFiltered({ ...DEFAULT_STATE, view: "month", month: "2026-11" }),
  ).toBe(false);
  expect(isFiltered({ ...DEFAULT_STATE, adjacent: false })).toBe(true);
});
