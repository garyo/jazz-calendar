import { beforeEach, describe, expect, test } from "bun:test";
import { readFeed } from "./feed";
import { type SubscribePanel, subscribePanel } from "./subscribe";
import { loadPage, sample, useDom } from "./testing";
import { DEFAULT_STATE } from "./url-state";

useDom();

const feed = readFeed(sample);
const [venue] = feed.listed;
let panel: SubscribePanel;
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

beforeEach(() => {
  loadPage();
  panel = subscribePanel();
});

describe("the subscribe panel", () => {
  test("offers every listing by default", () => {
    panel.update(DEFAULT_STATE, feed.venues);
    expect(el("subscribe-scope").textContent).toBe("Every listing.");
    expect(el<HTMLAnchorElement>("subscribe-webcal").href).toBe(
      "webcal://bostonjazzcalendar.com/calendar.ics",
    );
    expect(el<HTMLInputElement>("subscribe-url").value).toBe(
      "https://bostonjazzcalendar.com/calendar.ics",
    );
    expect(el("subscribe-everything").hidden).toBe(true);
    expect(el("subscribe-note").hidden).toBe(true);
  });

  test("follows the selection, but not search or dates", () => {
    panel.update(
      {
        ...DEFAULT_STATE,
        venues: [venue.id],
        adjacent: false,
        query: "trio",
      },
      feed.venues,
    );
    const path = `/calendar.ics?venue=${venue.id}&adjacent=0`;
    expect(el("subscribe-scope").textContent).toBe(
      `Listings at ${venue.name}, jazz only.`,
    );
    expect(el<HTMLInputElement>("subscribe-url").value).toBe(
      `https://bostonjazzcalendar.com${path}`,
    );
    expect(el<HTMLAnchorElement>("subscribe-google").href).toBe(
      `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(
        `webcal://bostonjazzcalendar.com${path}`,
      )}`,
    );
    expect(el("subscribe-everything").hidden).toBe(false);
    expect(el("subscribe-note").hidden).toBe(false);
  });

  test("names venues only once the feed has loaded", () => {
    panel.update({ ...DEFAULT_STATE, venues: [venue.id] });
    expect(el("subscribe-scope").textContent).toBe("Every listing.");
  });
});
