/**
 * Front-end entry point: keeps the view state in step with the URL, loads
 * the feed and re-renders on every change.
 */

import { startAnalytics } from "./analytics";
import { wireCalendarMenus } from "./calendar-menu";
import { checkedValue, filterControls } from "./controls";
import { byId } from "./dom";
import { type Feed, fetchFeed } from "./feed";
import { nextShowChange } from "./listings";
import { renderNotice, renderSourceList, renderUpdated } from "./render";
import { trackStickyTop } from "./sticky";
import { submitDialog } from "./submit";
import { subscribePanel } from "./subscribe";
import { themeSwitcher } from "./theme";
import { monthOf, nextTurnover } from "./time";
import {
  parseState,
  serializeState,
  VIEWS,
  type View,
  type ViewState,
} from "./url-state";
import { listingsView, stateHref } from "./view";

const listings = byId("listings");
const results = byId("results");
const count = byId("count");
const dayStrip = byId("day-strip");

/** Matches the stylesheet's phone layout, where the month grid shows counts. */
const compact = matchMedia("(max-width: 39.99rem)");

let feed: Feed | null = null;
let state = parseState(location.search);
/** When the clock next changes what the page shows. */
let changeAt = Number.POSITIVE_INFINITY;
let changeTimer: ReturnType<typeof setTimeout> | undefined;

const submit = submitDialog();
const subscribe = subscribePanel();
const controls = filterControls({ state: () => state, onChange: applyState });
const view = listingsView(() => controls.reset());

function applyState(next: ViewState, push = false): void {
  const search = serializeState(next);
  if (search === serializeState(state)) return;
  state = next;
  const url = `${location.pathname}${search}`;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  render();
}

function render(): void {
  if (!feed) return;
  const now = new Date();
  controls.renderChips();
  subscribe.update(state, feed.venues);
  view.render(state, feed, now);
  changeAt = Math.min(
    nextShowChange(feed.events, now),
    nextTurnover(now).getTime(),
  );
  followClock();
}

/**
 * Re-renders when a show starts or ends or a new day or night begins, and
 * not otherwise: a re-render rebuilds the listings, which moves the page.
 * A hidden tab waits until it's seen again.
 */
function followClock(): void {
  clearTimeout(changeTimer);
  if (document.hidden) return;
  const wait = changeAt - Date.now();
  if (wait <= 0) render();
  else changeTimer = setTimeout(followClock, wait);
}

/** Follows a same-page link (data-nav) without reloading. */
function followLink(link: HTMLAnchorElement): void {
  const next = parseState(new URL(link.href).search);
  const toDay = link.dataset.nav === "day";
  if (toDay && compact.matches) {
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
  controls.write(next);
  applyState(next, toDay);
  if (toDay) {
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

byId("view-toggle").addEventListener("change", () => {
  const next = checkedValue<View>("view", VIEWS, "list");
  const month = next === "month" && state.day ? monthOf(state.day) : "";
  applyState({ ...state, view: next, month, day: "" }, true);
});

window.addEventListener("popstate", () => {
  state = parseState(location.search);
  controls.write(state);
  render();
});

document.addEventListener("visibilitychange", followClock);

async function load(): Promise<void> {
  count.textContent = "";
  results.replaceChildren(
    renderNotice("Tuning up…", "Loading this week’s listings."),
  );
  results.setAttribute("aria-busy", "true");
  try {
    feed = await fetchFeed();
    submit.setVenues([...feed.venues.values()]);
    controls.setVenues(feed.listed, feed.venues);
    controls.write(state);
    renderUpdated(byId("updated"), feed.generatedAt, new Date());
    byId("sources-list").replaceChildren(...renderSourceList(feed.sources));
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

wireCalendarMenus(results);
const updateStickyTop = trackStickyTop(
  [dayStrip, document.querySelector<HTMLElement>("search.filter-bar")],
  compact,
);
themeSwitcher(byId("theme-switcher"), updateStickyTop);

// The pre-paint script has already applied and saved ?theme=; drop it.
if (new URLSearchParams(location.search).has("theme")) {
  history.replaceState(null, "", stateHref(state) + location.hash);
}
controls.write(state);
subscribe.update(state);
load();
void startAnalytics();
