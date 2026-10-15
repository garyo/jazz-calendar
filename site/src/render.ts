/** DOM construction for the listings. All data is inserted as text, never HTML. */

import { buildCalendar, googleEventUrl } from "./calendar-export";
import {
  ASSUMED_DURATION_MS,
  type DayGroup,
  extraArtists,
  isOnNow,
  normalize,
  type StripDay,
  venueLocation,
} from "./listings";
import type { MonthDay } from "./month";
import {
  addDays,
  addMonths,
  type DayKey,
  dayParts,
  eventEndLabel,
  eventTimeLabel,
  formatDate,
  formatDayHeading,
  formatMonth,
  formatShortClock,
} from "./time";
import type { CalendarEvent, Regular, Relevance, Venue } from "./types";

/** Entries listed in a month-grid cell before "+N more". */
export const MONTH_CELL_ENTRIES = 3;

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | null | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value != null) el.setAttribute(name, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

/** Only http(s) links from scraped data become hrefs. */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, href } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}

function srOnly(text: string): HTMLSpanElement {
  return h("span", { class: "sr-only" }, text);
}

/** Venue, neighborhood and town; themes may leave out the neighborhood. */
function renderVenue(venueId: string, venue: Venue | undefined): Node {
  if (!venue) return h("p", { class: "event-venue" }, venueId);
  const href = safeUrl(venue.url);
  const location = venueLocation(venue);
  const hood = location.slice(0, -venue.town.length);
  return h(
    "p",
    { class: "event-venue" },
    href ? h("a", { href }, venue.name) : venue.name,
    h(
      "span",
      { class: "event-place" },
      hood && h("span", { class: "event-hood" }, hood),
      venue.town,
    ),
  );
}

/** A clock time in two forms, "7:30 pm" and "7:30p"; each theme shows one. */
function clock(long: string, short: string): Node[] {
  return [
    h("span", { class: "clock-long" }, long),
    h("span", { class: "clock-short" }, short),
  ];
}

/**
 * Status markers ("on now", "jazz-adjacent"). Each theme draws its own glyph
 * or label; the text here is for screen readers.
 */
function renderMarks(relevance: Relevance, onNow = false): Child {
  if (!onNow && relevance !== "adjacent") return null;
  return h(
    "p",
    { class: "event-marks" },
    onNow && h("span", { class: "mark mark-now" }, srOnly("On now.")),
    relevance === "adjacent" &&
      h("span", { class: "mark mark-adjacent" }, srOnly("Jazz-adjacent.")),
  );
}

/** The title, linked to the listing's own page when there is one. */
function renderTitle(
  id: string,
  title: string,
  url: string | null | undefined,
  ...rest: Child[]
): HTMLHeadingElement {
  const href = safeUrl(url);
  return h(
    "h3",
    { class: "event-title", id },
    href
      ? h("a", { class: "event-link", href }, title)
      : h("span", { class: "event-link" }, title),
    ...rest,
  );
}

/** Price, ticket link and tags: the small print of a listing. */
function renderExtra(event: CalendarEvent, about: string): Child {
  const tickets = safeUrl(event.ticket_url);
  const tags = event.tags ?? [];
  if (!event.price && !tickets && tags.length === 0) return null;
  return h(
    "p",
    { class: "event-extra" },
    event.price && h("span", { class: "event-price" }, event.price),
    tickets &&
      h(
        "a",
        { class: "event-tickets", href: tickets },
        "Tickets",
        srOnly(about),
      ),
    ...tags.map((tag) => h("span", { class: "event-tag" }, tag)),
  );
}

/** Saves text as a file via a temporary object URL. */
function downloadFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** "Lilypad Jam Session" -> "lilypad-jam-session". */
function fileSlug(text: string): string {
  const slug = normalize(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "event";
}

/** A small menu: a Google Calendar link and an .ics download. */
function renderAddToCalendar(
  event: CalendarEvent,
  venue: Venue | undefined,
  about: string,
): HTMLDetailsElement {
  const download = h(
    "button",
    { type: "button", class: "menu-item" },
    "Apple, Outlook (.ics)",
  );
  download.addEventListener("click", () => {
    const venues = new Map(venue ? [[venue.id, venue]] : []);
    const ics = buildCalendar([event], venues, {
      name: event.title,
      stamp: new Date(),
    });
    downloadFile(`${fileSlug(event.title)}.ics`, ics, "text/calendar");
  });
  return h(
    "details",
    { class: "add-to-calendar" },
    h(
      "summary",
      { class: "add-to-calendar-toggle", title: "Add to calendar" },
      h("span", { class: "icon icon-calendar", "aria-hidden": "true" }),
      h("span", { class: "add-to-calendar-label" }, "Add to calendar"),
      srOnly(about),
    ),
    h(
      "ul",
      { class: "popover menu" },
      h(
        "li",
        {},
        h(
          "a",
          {
            class: "menu-item",
            href: googleEventUrl(event, venue, ASSUMED_DURATION_MS),
            target: "_blank",
            rel: "noopener",
          },
          "Google Calendar",
        ),
      ),
      h("li", {}, download),
    ),
  );
}

/**
 * One listing. The article's children are deliberately flat (time, marks,
 * title, venue, extra, calendar menu) so each theme can lay them out as
 * columns, a hanging list or two lines of text without different markup.
 */
function renderEvent(
  event: CalendarEvent,
  venue: Venue | undefined,
  now: Date,
): HTMLLIElement {
  const onNow = !event.cancelled && isOnNow(event, now);
  const classes = ["event", event.relevance];
  if (event.cancelled) classes.push("cancelled");
  if (onNow) classes.push("is-now");
  const titleId = `event-${event.id}`;
  const artists = extraArtists(event);
  const endLabel = eventEndLabel(event);
  const about = ` for ${event.title} at ${venue?.name ?? event.venue}`;
  return h(
    "li",
    { class: classes.join(" ") },
    h(
      "article",
      { class: "event-row", "aria-labelledby": titleId },
      h(
        "p",
        { class: "event-time" },
        h(
          "time",
          { datetime: event.start },
          ...(event.all_day
            ? [eventTimeLabel(event)]
            : clock(
                eventTimeLabel(event),
                formatShortClock(new Date(event.start)),
              )),
        ),
        endLabel &&
          event.end &&
          h(
            "span",
            { class: "event-end" },
            " ",
            ...clock(endLabel, `to ${formatShortClock(new Date(event.end))}`),
          ),
      ),
      renderMarks(event.relevance, onNow),
      renderTitle(
        titleId,
        event.title,
        event.url,
        event.cancelled &&
          h("span", { class: "badge badge-cancelled" }, "Cancelled"),
        artists.length > 0 &&
          h("span", { class: "event-artists" }, `with ${artists.join(", ")}`),
      ),
      renderVenue(event.venue, venue),
      renderExtra(event, about),
      !event.cancelled && renderAddToCalendar(event, venue, about),
    ),
  );
}

function relativeDay(day: DayKey, today: DayKey): string | null {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return null;
}

function renderDayHeading(id: string, day: DayKey, today: DayKey): Node {
  const parts = dayParts(day);
  const relative = relativeDay(day, today);
  return h(
    "h2",
    { class: "day-heading", id },
    h(
      "time",
      { datetime: day },
      h("span", { class: "day-long" }, parts.long),
      h(
        "span",
        { class: "day-short" },
        `${parts.weekday} ${parts.day}`,
        h("span", { class: "day-month" }, ` ${parts.month}`),
      ),
    ),
    relative && h("span", { class: "day-relative" }, relative),
  );
}

/** Jump links to each day of the list, quiet days shown but not linked. */
export function renderDayStrip(
  days: readonly StripDay[],
  today: DayKey,
): HTMLElement[] {
  return days.map(({ day, count }) => {
    const { weekday, day: date } = dayParts(day);
    const classes = ["strip-day"];
    if (day === today) classes.push("is-today");
    const label = [
      h("span", { class: "strip-weekday" }, weekday),
      h("span", { class: "strip-date" }, date),
    ];
    return h(
      "li",
      {},
      count > 0
        ? h(
            "a",
            {
              class: classes.join(" "),
              href: `#day-${day}`,
              "aria-label": `${formatDayHeading(day)}: ${showCount(count)}`,
              "aria-current": day === today ? "date" : null,
            },
            ...label,
          )
        : h(
            "span",
            { class: `${classes.join(" ")} is-empty` },
            ...label,
            srOnly(": no shows"),
          ),
    );
  });
}

export function renderDays(
  groups: readonly DayGroup[],
  venues: ReadonlyMap<string, Venue>,
  now: Date,
  today: DayKey,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const { day, events } of groups) {
    const headingId = `day-${day}`;
    fragment.append(
      h(
        "section",
        { class: "day", "aria-labelledby": headingId },
        renderDayHeading(headingId, day, today),
        h(
          "ol",
          { class: "events" },
          ...events.map((event) =>
            renderEvent(event, venues.get(event.venue), now),
          ),
        ),
      ),
    );
  }
  return fragment;
}

function renderRegular(
  regular: Regular,
  venue: Venue | undefined,
  index: number,
): HTMLLIElement {
  const titleId = `regular-${index}`;
  const checked = formatDate(regular.checked);
  return h(
    "li",
    { class: `regular ${regular.relevance}` },
    h(
      "article",
      { class: "regular-row", "aria-labelledby": titleId },
      h("p", { class: "regular-when" }, regular.when),
      renderMarks(regular.relevance),
      renderTitle(titleId, regular.title, regular.url),
      renderVenue(regular.venue, venue),
      checked &&
        h(
          "p",
          { class: "regular-checked" },
          "Schedule as of ",
          h("time", { datetime: regular.checked }, checked),
        ),
    ),
  );
}

export function renderRegulars(
  regulars: readonly Regular[],
  venues: ReadonlyMap<string, Venue>,
): HTMLLIElement[] {
  return regulars.map((regular, index) =>
    renderRegular(regular, venues.get(regular.venue), index),
  );
}

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

/** "1 show", "3 shows". */
export function showCount(count: number): string {
  return `${count} ${count === 1 ? "show" : "shows"}`;
}

function renderMonthCell(
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
  const date = h("span", { class: "month-date" }, String(Number(day.slice(8))));
  if (events.length === 0) {
    return h(
      "td",
      { class: classes.join(" ") },
      h(
        "span",
        {
          class: "month-day",
          "aria-current": day === today ? "date" : null,
        },
        date,
      ),
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
        "aria-current": day === today ? "date" : null,
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

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function monthNavLink(
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
  const current = today.slice(0, 7);
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
        monthNavLink(
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
        monthNavLink(
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
            ...week.map((day) => renderMonthCell(day, today, selected, links)),
          ),
        ),
      ),
    ),
  );
}

/** A centered notice for the loading, empty and error states. */
export function renderNotice(
  title: string,
  body: string,
  action?: { label: string; onClick: () => void },
): HTMLDivElement {
  const button =
    action && h("button", { type: "button", class: "button" }, action.label);
  if (button && action) button.addEventListener("click", action.onClick);
  return h(
    "div",
    { class: "notice" },
    h("p", { class: "notice-title" }, title),
    h("p", {}, body),
    button,
  );
}
