/**
 * The listings area for a view state: the count, then either the list (day
 * strip, nights of shows, weekly regulars) or the month grid with the
 * chosen day's shows under it.
 */

import { byId, h } from "./dom";
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
import { serializeState, type ViewState } from "./url-state";

/** A same-page link to a state; never "", which would mean "reload". */
export function stateHref(state: ViewState): string {
  return serializeState(state) || location.pathname;
}

/** Whether anything but the view and month differs from the defaults. */
export function isFiltered(state: ViewState): boolean {
  return serializeState({ ...state, view: "list", month: "" }) !== "";
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
    const onlyRegulars =
      shown.length === 0 && regularsNotice(regulars, feed.venues, state, today);
    let body: Node;
    if (shown.length > 0) {
      body = renderDays(groups, feed.venues, feed.credits, now, today);
    } else if (onlyRegulars) {
      body = renderNotice(onlyRegulars.title, onlyRegulars.body, clearAction);
    } else if (isFiltered(state)) {
      body = renderNotice(
        "Nothing matches those filters.",
        "Try a wider date range or a different search.",
        clearAction,
      );
    } else {
      body = renderNotice(
        "No upcoming shows listed.",
        "Check back soon; listings refresh every day.",
      );
    }
    results.replaceChildren(...(banner ? [banner, body] : [body]));
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
