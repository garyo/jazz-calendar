import { beforeEach, describe, expect, test } from "bun:test";
import { type Controls, filterControls } from "./controls";
import { readFeed } from "./feed";
import { loadPage, sample, useDom } from "./testing";
import { DEFAULT_STATE, type ViewState } from "./url-state";

useDom();

const feed = readFeed(sample);
let state: ViewState;
let changes: ViewState[];
let controls: Controls;

function setUp(start: Partial<ViewState> = {}): void {
  loadPage();
  state = { ...DEFAULT_STATE, ...start };
  changes = [];
  controls = filterControls({
    state: () => state,
    onChange: (next) => {
      state = next;
      changes.push(next);
    },
  });
  controls.setVenues(feed.listed, feed.venues);
  controls.write(state);
}

const search = () => document.getElementById("q") as HTMLInputElement;

describe("the other controls", () => {
  beforeEach(() => setUp());

  test("a date preset applies at once and drops a chosen day", () => {
    state = { ...state, day: "2026-10-16" };
    const weekend = document.querySelector<HTMLInputElement>(
      'input[name="when"][value="weekend"]',
    );
    weekend?.click();
    expect(changes.at(-1)).toMatchObject({ when: "weekend", day: "" });
  });

  test("write and read round-trip a state", () => {
    const [venue] = feed.listed;
    const next: ViewState = {
      ...DEFAULT_STATE,
      query: "quartet",
      venues: [venue.id],
      towns: [venue.town],
      adjacent: false,
      when: "week",
    };
    controls.write(next);
    expect(controls.read()).toEqual({ ...state, ...next });
  });

  test("selected venues and towns become removable chips", () => {
    const [venue] = feed.listed;
    controls.write({ ...state, venues: [venue.id], towns: [venue.town] });
    controls.renderChips();
    const chips = document.querySelectorAll<HTMLButtonElement>(
      "#selection-chips button",
    );
    expect([...chips].map((c) => c.getAttribute("aria-label"))).toEqual([
      `Remove ${venue.name}`,
      `Remove ${venue.town}`,
    ]);
    expect(document.getElementById("selection")?.hidden).toBe(false);
    chips[0].click();
    expect(changes.at(-1)).toMatchObject({ venues: [], towns: [venue.town] });
  });

  test("reset keeps only the view and month", () => {
    state = { ...state, view: "month", month: "2026-11", query: "x" };
    controls.reset();
    expect(changes.at(-1)).toEqual({
      ...DEFAULT_STATE,
      view: "month",
      month: "2026-11",
    });
    expect(search().value).toBe("");
  });
});

test("before the venues load, a selection from the URL is kept", () => {
  loadPage();
  const start = { ...DEFAULT_STATE, venues: ["lilypad"], towns: ["Boston"] };
  const early = filterControls({ state: () => start, onChange: () => {} });
  expect(early.read()).toMatchObject({
    venues: ["lilypad"],
    towns: ["Boston"],
  });
});
