/** Front-end entry point: loads the feed, wires the controls, renders. */

import { startAnalytics } from "./analytics";
import { type Credits, creditsById, sourceList } from "./credits";
import { disclosure } from "./disclosure";
import {
  filterEvents,
  filterRegulars,
  groupByDay,
  matchingEvents,
  stripDays,
  venuesWithListings,
} from "./listings";
import { buildMonth } from "./month";
import { createPicker, type PickerOption } from "./picker";
import {
  h,
  type MonthLinks,
  renderDayStrip,
  renderDays,
  renderMonth,
  renderNotice,
  renderRegulars,
  renderSourceList,
  showCount,
} from "./render";
import { feedQuery, selectionLabel } from "./selection";
import { submitDialog } from "./submit";
import { themeSwitcher } from "./theme";
import {
  type DayKey,
  formatDayHeading,
  formatMonth,
  formatUpdated,
  monthOf,
  nightOf,
} from "./time";
import type { CalendarEvent, EventsFile, Regular, Venue } from "./types";
import {
  DATE_PRESETS,
  type DatePreset,
  DEFAULT_STATE,
  parseState,
  serializeState,
  VIEWS,
  type View,
  type ViewState,
} from "./url-state";

/** Feed older than this gets a "may be out of date" warning. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const GOOGLE_SUBSCRIBE = "https://calendar.google.com/calendar/render?cid=";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const form = byId<HTMLFormElement>("filters");
const queryInput = byId<HTMLInputElement>("q");
const adjacentInput = byId<HTMLInputElement>("adjacent");
const presets = byId<HTMLFieldSetElement>("presets");
const selectionBar = byId<HTMLElement>("selection");
const selectionChips = byId<HTMLUListElement>("selection-chips");
const viewToggle = byId<HTMLFieldSetElement>("view-toggle");
const results = byId<HTMLElement>("results");
const count = byId<HTMLElement>("count");
const updated = byId<HTMLElement>("updated");
const regularsSection = byId<HTMLElement>("regulars");
const regularsList = byId<HTMLUListElement>("regulars-list");
const listings = byId<HTMLElement>("listings");
const dayStrip = byId<HTMLElement>("day-strip");
const dayStripList = byId<HTMLOListElement>("day-strip-list");
const sourcesList = byId<HTMLElement>("sources-list");
const filterBar = document.querySelector<HTMLElement>("search.filter-bar");
const subscribe = {
  scope: byId<HTMLElement>("subscribe-scope"),
  note: byId<HTMLElement>("subscribe-note"),
  webcal: byId<HTMLAnchorElement>("subscribe-webcal"),
  google: byId<HTMLAnchorElement>("subscribe-google"),
  copy: byId<HTMLButtonElement>("subscribe-copy"),
  url: byId<HTMLInputElement>("subscribe-url"),
  status: byId<HTMLElement>("subscribe-status"),
  everything: byId<HTMLElement>("subscribe-everything"),
  everythingLink: byId<HTMLAnchorElement>("subscribe-everything-link"),
};

/** Matches the stylesheet's phone layout, where the month grid shows counts. */
const compact = matchMedia("(max-width: 39.99rem)");

let feed: {
  events: CalendarEvent[];
  regulars: Regular[];
  venues: Map<string, Venue>;
  credits: Credits;
} | null = null;
let state = parseState(location.search);
const submit = submitDialog();

const venuePicker = createPicker({
  id: "venue",
  label: "Venues",
  noun: ["venue", "venues"],
  filterable: true,
  onChange: () => applyState(readControls()),
});
const townPicker = createPicker({
  id: "town",
  label: "Towns",
  noun: ["town", "towns"],
  onChange: () => applyState(readControls()),
});
byId("q-field").after(venuePicker.element, townPicker.element);

function checkedValue<T extends string>(
  name: string,
  options: readonly T[],
  fallback: T,
): T {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  );
  return options.find((option) => option === input?.value) ?? fallback;
}

function setChecked(name: string, value: string): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    `input[name="${name}"]`,
  )) {
    radio.checked = radio.value === value;
  }
}

function readControls(): ViewState {
  return {
    ...state,
    query: queryInput.value,
    // Until the feed loads the pickers have no options to hold a selection.
    venues: feed ? venuePicker.selected() : state.venues,
    towns: feed ? townPicker.selected() : state.towns,
    adjacent: adjacentInput.checked,
    when: checkedValue<DatePreset>("when", DATE_PRESETS, "all"),
  };
}

function writeControls(values: ViewState): void {
  queryInput.value = values.query;
  venuePicker.setSelected(values.venues);
  townPicker.setSelected(values.towns);
  adjacentInput.checked = values.adjacent;
  // A single day replaces the presets, so none of them is checked.
  setChecked("when", values.day ? "" : values.when);
  setChecked("view", values.view);
}

/** A same-page link to a state; never "", which would mean "reload". */
function hrefFor(next: ViewState): string {
  return serializeState(next) || location.pathname;
}

function applyState(next: ViewState, push = false): void {
  const search = serializeState(next);
  if (search === serializeState(state)) return;
  state = next;
  const url = `${location.pathname}${search}`;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  render();
}

function isFiltered(): boolean {
  return serializeState({ ...state, view: "list", month: "" }) !== "";
}

function resetFilters(): void {
  const next = { ...DEFAULT_STATE, view: state.view, month: state.month };
  writeControls(next);
  applyState(next);
}

/** Picker options for the listed venues and towns, plus any already selected. */
function populatePickers(listed: Venue[], venues: Map<string, Venue>): void {
  const venueOptions: PickerOption[] = listed.map((venue) => ({
    value: venue.id,
    label: venue.name,
    group: venue.town,
  }));
  for (const id of state.venues) {
    if (venueOptions.some((option) => option.value === id)) continue;
    const venue = venues.get(id);
    venueOptions.push({
      value: id,
      label: venue?.name ?? id,
      group: venue?.town ?? "Other",
    });
  }
  const towns = new Set([...listed.map((venue) => venue.town), ...state.towns]);
  venuePicker.setOptions(venueOptions);
  townPicker.setOptions(
    [...towns]
      .sort((a, b) => a.localeCompare(b))
      .map((town) => ({ value: town, label: town })),
  );
}

function renderChip(
  label: string,
  kind: string,
  remove: () => void,
): HTMLLIElement {
  const button = h(
    "button",
    {
      type: "button",
      class: "selection-chip",
      "aria-label": `Remove ${label}`,
    },
    h("span", { class: "selection-chip-kind" }, kind),
    label,
    h("span", { class: "selection-chip-x", "aria-hidden": "true" }, "×"),
  );
  button.addEventListener("click", () => {
    const index = [...selectionChips.querySelectorAll("button")].indexOf(
      button,
    );
    remove();
    applyState(readControls());
    const rest = selectionChips.querySelectorAll("button");
    (rest[Math.min(index, rest.length - 1)] ?? queryInput).focus();
  });
  return h("li", {}, button);
}

function renderChips(): void {
  const without = (values: string[], value: string) =>
    values.filter((v) => v !== value);
  const chips = [
    ...venuePicker
      .selected()
      .map((id) =>
        renderChip(venuePicker.labelOf(id), "Venue", () =>
          venuePicker.setSelected(without(venuePicker.selected(), id)),
        ),
      ),
    ...townPicker
      .selected()
      .map((town) =>
        renderChip(town, "Town", () =>
          townPicker.setSelected(without(townPicker.selected(), town)),
        ),
      ),
  ];
  selectionChips.replaceChildren(...chips);
  selectionBar.hidden = chips.length === 0;
}

function updateSubscribe(): void {
  const query = feedQuery(state);
  const path = query ? `/calendar.ics?${query}` : "/calendar.ics";
  const webcal = `webcal://${location.host}${path}`;
  const label = feed ? selectionLabel(state, feed.venues) : "";
  const scope = label ? `Listings at ${label}` : "Every listing";
  subscribe.scope.textContent = state.adjacent
    ? `${scope}.`
    : `${scope}, jazz only.`;
  subscribe.note.hidden = !state.query && state.when === "all" && !state.day;
  subscribe.webcal.href = webcal;
  subscribe.google.href = `${GOOGLE_SUBSCRIBE}${encodeURIComponent(webcal)}`;
  subscribe.url.value = `${location.origin}${path}`;
  subscribe.everything.hidden = !query;
  subscribe.everythingLink.href = `webcal://${location.host}/calendar.ics`;
  subscribe.status.textContent = "";
}

function renderList(now: Date, today: DayKey): void {
  if (!feed) return;
  const shown = filterEvents(feed.events, feed.venues, state, now);
  count.textContent = showCount(shown.length);
  const banner =
    state.day &&
    h(
      "p",
      { class: "day-filter" },
      "Showing only ",
      h("strong", {}, formatDayHeading(state.day)),
      ". ",
      h(
        "a",
        { href: hrefFor({ ...state, day: "" }), "data-nav": "replace" },
        "Show all dates",
      ),
    );
  const groups = groupByDay(shown, today);
  const strip = state.day ? [] : stripDays(groups);
  dayStripList.replaceChildren(...renderDayStrip(strip, today));
  dayStrip.hidden = strip.length === 0;
  let body: Node;
  if (shown.length > 0) {
    body = renderDays(groups, feed.venues, feed.credits, now, today);
  } else if (isFiltered()) {
    body = renderNotice(
      "Nothing matches those filters.",
      "Try a wider date range or a different search.",
      { label: "Clear filters", onClick: resetFilters },
    );
  } else {
    body = renderNotice(
      "No upcoming shows listed.",
      "Check back soon; listings refresh every day.",
    );
  }
  results.replaceChildren(
    ...[banner, body].filter((node) => node instanceof Node),
  );
  const regulars = filterRegulars(feed.regulars, feed.venues, state);
  regularsList.replaceChildren(...renderRegulars(regulars, feed.venues));
  regularsSection.hidden = regulars.length === 0;
}

function renderMonthView(now: Date, today: DayKey): void {
  if (!feed) return;
  const month = state.month || monthOf(today);
  const weeks = buildMonth(
    month,
    matchingEvents(feed.events, feed.venues, state),
  );
  const days = weeks.flat();
  const total = days
    .filter((day) => day.inMonth)
    .reduce((sum, day) => sum + day.events.length, 0);
  count.textContent = `${showCount(total)} in ${formatMonth(month)}`;
  const links: MonthLinks = {
    day: (day) => hrefFor({ ...state, view: "list", month: "", day }),
    month: (next) => hrefFor({ ...state, month: next, day: "" }),
  };
  const grid = renderMonth(month, weeks, today, state.day, links);
  const selected = days.find((day) => day.day === state.day);
  const agenda =
    selected && selected.events.length > 0
      ? renderDays([selected], feed.venues, feed.credits, now, today)
      : null;
  results.replaceChildren(grid, ...(agenda ? [agenda] : []));
  regularsSection.hidden = true;
  dayStrip.hidden = true;
}

function render(): void {
  if (!feed) return;
  const now = new Date();
  const today = nightOf(now);
  const month = state.view === "month";
  presets.hidden = month;
  listings.classList.toggle("is-month", month);
  renderChips();
  updateSubscribe();
  if (month) renderMonthView(now, today);
  else renderList(now, today);
}

/** Follows a same-page link (data-nav) without reloading. */
function followLink(link: HTMLAnchorElement): void {
  const next = parseState(new URL(link.href).search);
  if (link.dataset.nav === "day" && compact.matches) {
    // On a phone the day's shows open under the grid instead.
    applyState({ ...state, day: next.day });
    const heading = document.getElementById(`day-${next.day}`);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: "nearest" });
    }
    return;
  }
  writeControls(next);
  applyState(next, link.dataset.nav === "day");
  if (link.dataset.nav === "day") {
    listings.focus({ preventScroll: true });
    window.scrollTo({ top: listings.offsetTop });
  } else if (link.id) {
    document.getElementById(link.id)?.focus();
  }
}

results.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>(
    "a[data-nav]",
  );
  const modified =
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey;
  if (!link || modified) return;
  event.preventDefault();
  followLink(link);
});

/** Scrolls to a day picked from the day strip and moves focus to its heading. */
dayStrip.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a");
  const heading = link && document.getElementById(link.hash.slice(1));
  if (!heading) return;
  event.preventDefault();
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  heading.closest(".day")?.scrollIntoView({ block: "start" });
});

/**
 * Day headings stick just below whichever bar the theme pins (the filters or
 * the day strip), so the stylesheet needs that bar's height.
 */
function updateStickyTop(): void {
  const pinned = [dayStrip, filterBar].find(
    (bar) => bar && getComputedStyle(bar).position === "sticky",
  );
  document.documentElement.style.setProperty(
    "--sticky-top",
    `${pinned?.offsetHeight ?? 0}px`,
  );
}
const stickyObserver = new ResizeObserver(updateStickyTop);
for (const bar of [dayStrip, filterBar]) if (bar) stickyObserver.observe(bar);
compact.addEventListener("change", updateStickyTop);
themeSwitcher(byId("theme-switcher"), updateStickyTop);

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
    const sources = file.sources ?? [];
    feed = {
      events: file.events,
      regulars,
      venues,
      credits: creditsById(sources),
    };
    submit.setVenues(file.venues);
    populatePickers(
      venuesWithListings([...file.events, ...regulars], venues),
      venues,
    );
    writeControls(state);
    showUpdated(file.generated_at);
    sourcesList.replaceChildren(
      ...renderSourceList(sourceList(sources, file.events, venues)),
    );
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
// Browsers fire both events for most controls; applyState skips repeats.
for (const type of ["input", "change"]) {
  form.addEventListener(type, (event) => {
    const next = readControls();
    if ((event.target as HTMLInputElement).name === "when") next.day = "";
    applyState(next);
  });
}

viewToggle.addEventListener("change", () => {
  const view = checkedValue<View>("view", VIEWS, "list");
  const month = view === "month" && state.day ? monthOf(state.day) : "";
  applyState({ ...state, view, month, day: "" }, true);
});

byId<HTMLButtonElement>("clear-selection").addEventListener("click", () => {
  venuePicker.setSelected([]);
  townPicker.setSelected([]);
  applyState(readControls());
  venuePicker.focus();
});

window.addEventListener("popstate", () => {
  state = parseState(location.search);
  writeControls(state);
  render();
});

disclosure(
  byId<HTMLButtonElement>("subscribe-toggle"),
  byId<HTMLElement>("subscribe-panel"),
);
subscribe.url.addEventListener("focus", () => subscribe.url.select());
subscribe.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(subscribe.url.value);
    subscribe.status.textContent = "Link copied.";
  } catch {
    subscribe.url.focus();
    subscribe.status.textContent = "Press Ctrl+C (⌘C on a Mac) to copy.";
  }
});

// "Add to calendar" menus: one open at a time, closed by Escape, an
// outside click, or picking an item.
const openMenus = () =>
  document.querySelectorAll<HTMLDetailsElement>(
    "details.add-to-calendar[open]",
  );
document.addEventListener("pointerdown", (event) => {
  for (const menu of openMenus()) {
    if (!menu.contains(event.target as Node)) menu.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = (event.target as Element).closest?.<HTMLDetailsElement>(
    "details.add-to-calendar[open]",
  );
  if (!menu) return;
  menu.open = false;
  menu.querySelector("summary")?.focus();
});
results.addEventListener("click", (event) => {
  const item = (event.target as Element).closest(".add-to-calendar .menu-item");
  const menu = item?.closest("details");
  if (menu) menu.open = false;
});
results.addEventListener(
  "toggle",
  (event) => {
    const menu = event.target as HTMLDetailsElement;
    if (!menu.open) return;
    for (const other of openMenus()) if (other !== menu) other.open = false;
  },
  true,
);
// Re-render when a tab is revisited so finished shows drop off.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});

// The pre-paint script has already applied and saved ?theme=; drop it.
if (new URLSearchParams(location.search).has("theme")) {
  history.replaceState(null, "", hrefFor(state) + location.hash);
}
writeControls(state);
updateSubscribe();
load();
void startAnalytics();
