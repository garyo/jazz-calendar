/**
 * The listings area for a view state: the count, then either the list (day
 * strip, nights of shows, weekly regulars) or the month grid with the
 * chosen day's shows under it.
 */

import { byId, h, placeChildren, reuse } from "./dom";
import type { Feed } from "./feed";
import {
  filterEvents,
  filterRegulars,
  groupByDay,
  matchingEvents,
  regularsIntro,
  regularsNotice,
  showCount,
  stripDays,
} from "./listings";
import { buildMonth } from "./month";
import { type MonthLinks, renderMonth } from "./month-grid";
import {
  renderDayStrip,
  renderDays,
  renderNotice,
  renderRegulars,
} from "./render";
import {
  type DayKey,
  formatDayHeading,
  formatMonth,
  monthOf,
  nightOf,
} from "./time";
import type { Regular } from "./types";
import { serializeState, type ViewState } from "./url-state";

/** A same-page link to a state; never "", which would mean "reload". */
export function stateHref(state: ViewState): string {
  return serializeState(state) || location.pathname;
}

/** Whether anything but the view and month differs from the defaults. */
export function isFiltered(state: ViewState): boolean {
  return serializeState({ ...state, view: "list", month: "" }) !== "";
}

function byKey(elements: Iterable<Element>): Map<string | null, Element> {
  return new Map([...elements].map((el) => [el.getAttribute("data-key"), el]));
}

export interface ListingsView {
  render(state: ViewState, feed: Feed, now?: Date): void;
}

/** `clear` resets the filters, from the empty-result notices. */
export function listingsView(clear: () => void): ListingsView {
  const listings = byId("listings");
  const presets = byId("presets");
  const results = byId("results");
  const count = byId("count");
  const dayStrip = byId("day-strip");
  const dayStripList = byId("day-strip-list");
  const regularsSection = byId("regulars");
  const regularsIntroText = byId("regulars-intro");
  const regularsList = byId("regulars-list");
  const clearAction = { label: "Clear filters", onClick: clear };

  /**
   * The freshly rendered nights, with those already shown reused: a night
   * keeps its element and its unchanged shows, and takes the rest in
   * place. A re-render then moves only what changed; rebuilt nights would
   * lose their laid-out size and the browser's scroll anchor, and jump.
   */
  function reuseNights(fresh: DocumentFragment): Element[] {
    const shown = byKey(results.children);
    return [...fresh.children].map((night) => {
      const old = shown.get(night.getAttribute("data-key"));
      const [heading, events] = night.children;
      const [oldHeading, oldEvents] = old?.children ?? [];
      const oldShows = byKey(oldEvents?.children ?? []);
      const shows = [...events.children].map((show) =>
        reuse(oldShows.get(show.getAttribute("data-key")), show),
      );
      const kept = old ?? night;
      const list = oldEvents ?? events;
      kept.setAttribute("style", night.getAttribute("style") ?? "");
      placeChildren(kept, [reuse(oldHeading, heading), list]);
      placeChildren(list, shows);
      return kept;
    });
  }

  /** Why nothing is listed: only regulars match, the filters, or no shows. */
  function noShowsNotice(
    state: ViewState,
    regulars: readonly Regular[],
    feed: Feed,
    today: DayKey,
  ): HTMLElement {
    const onlyRegulars = regularsNotice(regulars, feed.venues, state, today);
    if (onlyRegulars) {
      return renderNotice(onlyRegulars.title, onlyRegulars.body, clearAction);
    }
    if (isFiltered(state)) {
      return renderNotice(
        "Nothing matches those filters.",
        "Try a wider date range or a different search.",
        clearAction,
      );
    }
    return renderNotice(
      "No upcoming shows listed.",
      "Check back soon; listings refresh every day.",
    );
  }

  function renderList(
    state: ViewState,
    feed: Feed,
    now: Date,
    today: DayKey,
  ): void {
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
          { href: stateHref({ ...state, day: "" }), "data-nav": "replace" },
          "Show all dates",
        ),
      );
    const groups = groupByDay(shown, today);
    const strip = state.day ? [] : stripDays(groups);
    dayStripList.replaceChildren(...renderDayStrip(strip, today));
    dayStrip.hidden = strip.length === 0;
    const regulars = filterRegulars(feed.regulars, feed.venues, state, today);
    const body =
      shown.length > 0
        ? reuseNights(renderDays(groups, feed.venues, feed.credits, now, today))
        : [noShowsNotice(state, regulars, feed, today)];
    placeChildren(results, banner ? [banner, ...body] : body);
    regularsIntroText.textContent = regularsIntro(state, today);
    regularsList.replaceChildren(...renderRegulars(regulars, feed.venues));
    regularsSection.hidden = regulars.length === 0;
  }

  function renderMonthView(
    state: ViewState,
    feed: Feed,
    now: Date,
    today: DayKey,
  ): void {
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
      day: (day) => stateHref({ ...state, view: "list", month: "", day }),
      month: (next) => stateHref({ ...state, month: next, day: "" }),
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

  return {
    render(state, feed, now = new Date()) {
      const today = nightOf(now);
      const month = state.view === "month";
      presets.hidden = month;
      listings.classList.toggle("is-month", month);
      if (month) renderMonthView(state, feed, now, today);
      else renderList(state, feed, now, today);
    },
  };
}
