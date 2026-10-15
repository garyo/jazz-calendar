/** The month view's grid: one cell per night, linked to that day's listings. */

import { h, srOnly } from "./dom";
import { showCount } from "./listings";
import type { MonthDay } from "./month";
import {
  addMonths,
  type DayKey,
  formatDayHeading,
  formatMonth,
  formatShortClock,
  monthOf,
} from "./time";
import type { CalendarEvent } from "./types";

/** Entries listed in a cell before "+N more". */
export const MONTH_CELL_ENTRIES = 8;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface MonthLinks {
  /** Where a day's cell leads: that day's listings. */
  day(day: DayKey): string;
  /** The month view for another month. */
  month(month: string): string;
}

function monthEntry(event: CalendarEvent): HTMLSpanElement {
  const classes = ["month-entry", event.relevance];
  if (event.cancelled) classes.push("cancelled");
  const time = event.all_day ? "" : formatShortClock(new Date(event.start));
  return h(
    "span",
    { class: classes.join(" "), title: event.title },
    time && h("span", { class: "month-entry-time" }, time),
    h("span", { class: "month-entry-title" }, event.title),
  );
}

function renderCell(
  { day, inMonth, events }: MonthDay,
  today: DayKey,
  selected: DayKey | "",
  links: MonthLinks,
): HTMLTableCellElement {
  const classes = ["month-cell"];
  if (!inMonth) classes.push("is-outside");
  if (day < today) classes.push("is-past");
  if (day === today) classes.push("is-today");
  if (day === selected) classes.push("is-selected");
  const current = day === today ? "date" : null;
  const date = h("span", { class: "month-date" }, String(Number(day.slice(8))));
  if (events.length === 0) {
    return h(
      "td",
      { class: classes.join(" ") },
      h("span", { class: "month-day", "aria-current": current }, date),
    );
  }
  const shown = events.slice(0, MONTH_CELL_ENTRIES);
  const more = events.length - shown.length;
  return h(
    "td",
    { class: classes.join(" ") },
    h(
      "a",
      {
        class: "month-day",
        id: `month-day-${day}`,
        href: links.day(day),
        "data-nav": "day",
        "aria-label": `${formatDayHeading(day)}: ${showCount(events.length)}`,
        "aria-current": current,
      },
      date,
      h(
        "span",
        { class: "month-count", "aria-hidden": "true" },
        String(events.length),
      ),
      h(
        "span",
        { class: "month-entries", "aria-hidden": "true" },
        ...shown.map(monthEntry),
        more > 0 && h("span", { class: "month-more" }, `+${more} more`),
      ),
    ),
  );
}

function stepLink(
  id: string,
  href: string,
  label: string,
  text: string,
): HTMLAnchorElement {
  return h(
    "a",
    { id, class: "button month-step", href, "data-nav": "replace" },
    h("span", { "aria-hidden": "true" }, text),
    srOnly(label),
  );
}

/** The month grid, with previous/next/today navigation. */
export function renderMonth(
  month: string,
  weeks: readonly MonthDay[][],
  today: DayKey,
  selected: DayKey | "",
  links: MonthLinks,
): HTMLElement {
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const current = monthOf(today);
  return h(
    "section",
    { class: "month", "aria-labelledby": "month-heading" },
    h(
      "div",
      { class: "month-nav" },
      h(
        "h2",
        { class: "month-heading", id: "month-heading" },
        formatMonth(month),
      ),
      h(
        "p",
        { class: "month-steps" },
        stepLink(
          "month-prev",
          links.month(prev),
          `Previous month, ${formatMonth(prev)}`,
          "‹",
        ),
        h(
          "a",
          {
            id: "month-today",
            class: "button",
            href: links.month(current),
            "data-nav": "replace",
            "aria-disabled": month === current ? "true" : null,
          },
          "Today",
        ),
        stepLink(
          "month-next",
          links.month(next),
          `Next month, ${formatMonth(next)}`,
          "›",
        ),
      ),
    ),
    h(
      "table",
      { class: "month-grid" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...WEEKDAYS.map((name) =>
            h(
              "th",
              { scope: "col" },
              h("abbr", { title: name }, name.slice(0, 3)),
            ),
          ),
        ),
      ),
      h(
        "tbody",
        {},
        ...weeks.map((week) =>
          h(
            "tr",
            {},
            ...week.map((day) => renderCell(day, today, selected, links)),
          ),
        ),
      ),
    ),
  );
}
