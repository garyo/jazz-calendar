/** Front-end entry point: loads the feed, wires the filters, renders. */

import {
  filterEvents,
  filterRegulars,
  groupByDay,
  townsWithListings,
} from "./listings";
import { renderDays, renderNotice, renderRegulars } from "./render";
import { dayKey, formatUpdated } from "./time";
import type { EventsFile, Regular, Venue } from "./types";
import {
  DATE_PRESETS,
  type DatePreset,
  DEFAULT_FILTERS,
  type Filters,
  parseFilters,
  serializeFilters,
} from "./url-state";

/** Feed older than this gets a "may be out of date" warning. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const form = byId<HTMLFormElement>("filters");
const queryInput = byId<HTMLInputElement>("q");
const townSelect = byId<HTMLSelectElement>("town");
const adjacentInput = byId<HTMLInputElement>("adjacent");
const results = byId<HTMLElement>("results");
const count = byId<HTMLElement>("count");
const updated = byId<HTMLElement>("updated");
const regularsSection = byId<HTMLElement>("regulars");
const regularsList = byId<HTMLUListElement>("regulars-list");

let feed: {
  events: EventsFile["events"];
  regulars: Regular[];
  venues: Map<string, Venue>;
} | null = null;
let filters = parseFilters(location.search);

function selectedPreset(): DatePreset {
  const value = new FormData(form).get("when");
  return DATE_PRESETS.find((preset) => preset === value) ?? "all";
}

function readControls(): Filters {
  return {
    query: queryInput.value,
    town: townSelect.value,
    adjacent: adjacentInput.checked,
    when: selectedPreset(),
  };
}

function writeControls(values: Filters): void {
  queryInput.value = values.query;
  townSelect.value = values.town;
  adjacentInput.checked = values.adjacent;
  for (const radio of form.querySelectorAll<HTMLInputElement>(
    'input[name="when"]',
  )) {
    radio.checked = radio.value === values.when;
  }
}

function populateTowns(towns: string[]): void {
  // Keep a town from a shared link selectable even if it has no shows now.
  if (filters.town && !towns.includes(filters.town)) towns.push(filters.town);
  townSelect.replaceChildren(
    new Option("All towns", ""),
    ...towns.map((town) => new Option(town, town)),
  );
}

function isFiltered(): boolean {
  return serializeFilters(filters) !== "";
}

function resetFilters(): void {
  writeControls(DEFAULT_FILTERS);
  applyFilters({ ...DEFAULT_FILTERS });
}

function render(): void {
  if (!feed) return;
  const now = new Date();
  const today = dayKey(now);
  const shown = filterEvents(feed.events, feed.venues, filters, now);
  count.textContent = `${shown.length} ${shown.length === 1 ? "show" : "shows"}`;
  if (shown.length > 0) {
    results.replaceChildren(
      renderDays(groupByDay(shown, today), feed.venues, now, today),
    );
  } else if (isFiltered()) {
    results.replaceChildren(
      renderNotice(
        "Nothing matches those filters.",
        "Try a wider date range or a different search.",
        { label: "Clear filters", onClick: resetFilters },
      ),
    );
  } else {
    results.replaceChildren(
      renderNotice(
        "No upcoming shows listed.",
        "Check back soon; listings refresh every day.",
      ),
    );
  }
  const regulars = filterRegulars(feed.regulars, feed.venues, filters);
  regularsList.replaceChildren(...renderRegulars(regulars, feed.venues));
  regularsSection.hidden = regulars.length === 0;
}

function applyFilters(next: Filters): void {
  const unchanged = (Object.keys(next) as (keyof Filters)[]).every(
    (key) => next[key] === filters[key],
  );
  if (unchanged) return;
  filters = next;
  history.replaceState(
    null,
    "",
    `${location.pathname}${serializeFilters(next)}`,
  );
  render();
}

function showUpdated(generatedAt: string): void {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return;
  const now = new Date();
  const time = document.createElement("time");
  time.dateTime = generatedAt;
  time.textContent = formatUpdated(date, now);
  const stale = now.getTime() - date.getTime() > STALE_AFTER_MS;
  updated.replaceChildren("Updated ", time);
  if (stale) updated.append(". Listings may be out of date.");
  updated.classList.toggle("stale", stale);
}

function setSubscribeLinks(): void {
  const path = "/calendar.ics";
  byId<HTMLAnchorElement>("subscribe-webcal").href =
    `webcal://${location.host}${path}`;
  const https = byId<HTMLAnchorElement>("subscribe-https");
  https.href = `${location.origin}${path}`;
  https.textContent = `${location.host}${path}`;
}

async function load(): Promise<void> {
  count.textContent = "";
  results.replaceChildren(
    renderNotice("Tuning up…", "Loading this week’s listings."),
  );
  results.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/data/events.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file: EventsFile = await response.json();
    const venues = new Map(file.venues.map((venue) => [venue.id, venue]));
    const regulars = file.regulars ?? [];
    feed = { events: file.events, regulars, venues };
    populateTowns(townsWithListings([...file.events, ...regulars], venues));
    writeControls(filters);
    showUpdated(file.generated_at);
    render();
  } catch (error) {
    console.error("Failed to load listings:", error);
    results.replaceChildren(
      renderNotice(
        "The listings didn’t load.",
        "That’s on our end. Please try again in a moment.",
        { label: "Try again", onClick: load },
      ),
    );
  } finally {
    results.removeAttribute("aria-busy");
  }
}

form.addEventListener("submit", (event) => event.preventDefault());
// Browsers fire both events for most controls; applyFilters skips repeats.
for (const type of ["input", "change"]) {
  form.addEventListener(type, () => applyFilters(readControls()));
}
// Re-render when a tab is revisited so finished shows drop off.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});

setSubscribeLinks();
writeControls(filters);
load();
