/**
 * DOM construction for the listings, the regulars and the list of sources.
 * All data is inserted as text, never HTML.
 */

import { renderAddToCalendar } from "./calendar-menu";
import {
  type Credits,
  type SourceEntry,
  type SourceList,
  viaCredits,
} from "./credits";
import { type Child, h, safeUrl, srOnly } from "./dom";
import {
  type DayGroup,
  extraArtists,
  isOnNow,
  type StripDay,
  showCount,
  venueLocation,
} from "./listings";
import {
  addDays,
  type DayKey,
  dayParts,
  eventEndLabel,
  eventTimeLabel,
  formatDate,
  formatDayHeading,
  formatShortClock,
  formatUpdated,
  isLateSet,
} from "./time";
import type {
  CalendarEvent,
  Regular,
  Relevance,
  SourceCredit,
  Venue,
} from "./types";

/** Links that leave the site open in a new tab, and say so to screen readers. */
function external(
  attrs: Record<string, string | null>,
  ...children: Child[]
): HTMLAnchorElement {
  return h(
    "a",
    { ...attrs, target: "_blank", rel: "noopener" },
    ...children,
    srOnly(" (opens in a new tab)"),
  );
}

/** A source's name, linked to its page. */
function creditLink(credit: SourceEntry | SourceCredit): Node | string {
  const href = safeUrl(credit.url);
  return href ? external({ href }, credit.name) : credit.name;
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
    href ? external({ href }, venue.name) : venue.name,
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
 * The "on now" marker. Each theme draws its own glyph or label; the text here
 * is for screen readers.
 */
function renderMarks(onNow: boolean): Child {
  if (!onNow) return null;
  return h(
    "p",
    { class: "event-marks" },
    h("span", { class: "mark mark-now" }, srOnly("On now.")),
  );
}

/** Tag pills, led by "jazz-adjacent" when it applies. */
function renderTags(relevance: Relevance, tags: readonly string[]): Child[] {
  return [
    relevance === "adjacent" &&
      h("span", { class: "event-tag tag-adjacent" }, "jazz-adjacent"),
    ...tags.map((tag) => h("span", { class: "event-tag" }, tag)),
  ];
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
      ? external({ class: "event-link", href }, title)
      : h("span", { class: "event-link" }, title),
    ...rest,
  );
}

/** "via Ticketmaster": the third parties a listing came through. */
function renderVia(via: readonly SourceCredit[]): Child {
  if (via.length === 0) return null;
  return h(
    "span",
    { class: "event-via" },
    "via ",
    ...via.flatMap((credit, i) => [i > 0 && ", ", creditLink(credit)]),
  );
}

/** Price, ticket link, credit and tags: the small print of a listing. */
function renderExtra(
  event: CalendarEvent,
  about: string,
  via: readonly SourceCredit[],
): Child {
  const tickets = safeUrl(event.ticket_url);
  // A "free" tag only repeats a price that already says so.
  const tags = (event.tags ?? []).filter(
    (tag) => !(tag === "free" && /^free/i.test(event.price ?? "")),
  );
  const adjacent = event.relevance === "adjacent";
  if (
    !event.price &&
    !tickets &&
    via.length === 0 &&
    tags.length === 0 &&
    !adjacent
  ) {
    return null;
  }
  return h(
    "p",
    { class: "event-extra" },
    event.price && h("span", { class: "event-price" }, event.price),
    tickets &&
      external(
        { class: "event-tickets", href: tickets },
        "Tickets",
        srOnly(about),
      ),
    renderVia(via),
    ...renderTags(event.relevance, tags),
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
  credits: Credits,
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
  const via = viaCredits(event, credits);
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
        isLateSet(event) &&
          h(
            "span",
            { class: "event-late" },
            h("span", { "aria-hidden": "true" }, "late"),
            srOnly(" (after midnight)"),
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
      renderMarks(onNow),
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
      renderExtra(event, about, via),
      !event.cancelled &&
        renderAddToCalendar(event, venue, about, credits, via),
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
  credits: Credits,
  now: Date,
  today: DayKey,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const { day, events } of groups) {
    const headingId = `day-${day}`;
    const section = h(
      "section",
      { class: "day", "aria-labelledby": headingId },
      renderDayHeading(headingId, day, today),
      h(
        "ol",
        { class: "events" },
        ...events.map((event) =>
          renderEvent(event, venues.get(event.venue), credits, now),
        ),
      ),
    );
    // Sizes the placeholder of a day that hasn't been laid out yet.
    section.style.setProperty("--day-events", String(events.length));
    fragment.append(section);
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
      renderTitle(titleId, regular.title, regular.url),
      renderVenue(regular.venue, venue),
      regular.relevance === "adjacent" &&
        h("p", { class: "event-extra" }, ...renderTags(regular.relevance, [])),
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

const andList = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The list of sources: the venues' own calendars, then the services that
 * supply other venues' listings, each with those venues.
 */
export function renderSourceList({ own, via }: SourceList): HTMLElement[] {
  const group = (
    heading: string,
    items: readonly HTMLLIElement[],
  ): HTMLElement[] =>
    items.length === 0
      ? []
      : [
          h("h3", { class: "sources-heading" }, heading),
          h("ul", { class: "sources-list" }, ...items),
        ];
  return [
    ...group(
      "Venues’ and presenters’ own calendars",
      own.map((entry) => h("li", {}, creditLink(entry))),
    ),
    ...group(
      "Through other services",
      via.map((entry) =>
        h(
          "li",
          {},
          creditLink(entry),
          entry.venues.length > 0 && `, for ${andList.format(entry.venues)}`,
        ),
      ),
    ),
  ];
}

/** A feed older than this gets a "may be out of date" warning. */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** "Updated today at 6 am", with a warning when the feed is stale. */
export function renderUpdated(
  target: HTMLElement,
  generatedAt: string,
  now: Date,
): void {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return;
  const stale = now.getTime() - date.getTime() > STALE_AFTER_MS;
  target.replaceChildren(
    "Updated ",
    h("time", { datetime: generatedAt }, formatUpdated(date, now)),
    ...(stale ? [". Listings may be out of date."] : []),
  );
  target.classList.toggle("stale", stale);
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
