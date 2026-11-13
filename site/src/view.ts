/**
 * The listings area for a view state: the count, then either the list (day
 * strip, nights of shows) or the month grid with the chosen day's shows
 * under it. The weekly regulars appear under each night they usually run,
 * for the view's nights or, in a view of every date, the coming week; such a
 * view, and the month grid, list them all in their own section too.
 */

import { byId, h, placeChildren, reuse } from "./dom";
import type { Feed } from "./feed";
import {
  filterEvents,
  filterRegulars,
  groupByDay,
  listRange,
  matchingEvents,
  regularsNotice,
  showCount,
  stripDays,
  withRegulars,
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
  addDays,
  type DayKey,
  formatDayHeading,
  formatMonth,
  monthOf,
  nightOf,
} from "./time";
import type { Regular, Venue } from "./types";
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
      const [heading, events, ...rest] = night.children;
      const [oldHeading, oldEvents, ...oldRest] = old?.children ?? [];
      const oldShows = byKey(oldEvents?.children ?? []);
      const shows = [...events.children].map((show) =>
        reuse(oldShows.get(show.getAttribute("data-key")), show),
      );
      const kept = old ?? night;
      const list = oldEvents ?? events;
      kept.setAttribute("style", night.getAttribute("style") ?? "");
      placeChildren(kept, [
        reuse(oldHeading, heading),
        list,
        ...rest.map((el, i) => reuse(oldRest[i], el)),
      ]);
      placeChildren(list, shows);
      return kept;
    });
  }

  /** Why nothing is listed: only regulars match, the filters, or no shows. */
  function noShowsNotice(
    state: ViewState,
    regulars: readonly Regular[],
    today: DayKey,
  ): HTMLElement {
    const pointer = regularsNotice(
      regulars.length,
      state,
      today,
      isFiltered(state),
    );
    if (pointer) return h("p", { class: "regulars-pointer" }, pointer);
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

  /** The section listing every weekly regular, shown when `regulars` has any. */
  function showRegulars(
    regulars: readonly Regular[],
    venues: ReadonlyMap<string, Venue>,
  ): void {
    regularsList.replaceChildren(...renderRegulars(regulars, venues));
    regularsSection.hidden = regulars.length === 0;
  }

  /** "313 shows", and when the regulars section is shown, a link down to it. */
  function showTotals(text: string, regulars: number): void {
    const link =
      regulars > 0 &&
      h(
        "a",
        { href: "#regulars-heading", class: "count-regulars" },
        `${regulars} weekly ${regulars === 1 ? "regular" : "regulars"}`,
      );
    count.replaceChildren(text, ...(link ? [" · ", link] : []));
  }

  function renderList(
    state: ViewState,
    feed: Feed,
    now: Date,
    today: DayKey,
  ): void {
    const shown = filterEvents(feed.events, feed.venues, state, now);
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
    const range = listRange(state, today);
    const nights = withRegulars(
      groups,
      regulars,
      range ?? { from: today, to: addDays(today, 6) },
    );
    // A view of some nights lists their regulars with them; one of every
    // date also lists them all below.
    const listed = range ? [] : regulars;
    const body =
      nights.length > 0
        ? reuseNights(renderDays(nights, feed.venues, feed.credits, now, today))
        : [noShowsNotice(state, listed, today)];
    placeChildren(results, banner ? [banner, ...body] : body);
    showTotals(showCount(shown.length), listed.length);
    showRegulars(listed, feed.venues);
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
    const regulars = filterRegulars(
      feed.regulars,
      feed.venues,
      { ...state, when: "all", day: "" },
      today,
    );
    showTotals(`${showCount(total)} in ${formatMonth(month)}`, regulars.length);
    const links: MonthLinks = {
      day: (day) => stateHref({ ...state, view: "list", month: "", day }),
      month: (next) => stateHref({ ...state, month: next, day: "" }),
    };
    const grid = renderMonth(month, weeks, today, state.day, links);
    const selected = days.find((day) => day.day === state.day);
    const nights = selected
      ? withRegulars(selected.events.length > 0 ? [selected] : [], regulars, {
          from: selected.day,
          to: selected.day,
        })
      : [];
    const agenda =
      nights.length > 0
        ? renderDays(nights, feed.venues, feed.credits, now, today)
        : null;
    results.replaceChildren(grid, ...(agenda ? [agenda] : []));
    showRegulars(regulars, feed.venues);
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
