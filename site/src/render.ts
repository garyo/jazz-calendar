/** DOM construction for the listings. All data is inserted as text, never HTML. */

import {
  type DayGroup,
  extraArtists,
  isOnNow,
  venueLocation,
} from "./listings";
import {
  addDays,
  type DayKey,
  eventEndLabel,
  eventTimeLabel,
  formatDate,
  formatDayHeading,
} from "./time";
import type { CalendarEvent, Regular, Relevance, Venue } from "./types";

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

function renderVenue(venueId: string, venue: Venue | undefined): Node {
  if (!venue) return h("p", { class: "event-venue" }, venueId);
  const href = safeUrl(venue.url);
  return h(
    "p",
    { class: "event-venue" },
    href ? h("a", { href }, venue.name) : venue.name,
    h("span", { class: "event-place" }, venueLocation(venue)),
  );
}

function adjacentChip(relevance: Relevance): Child {
  return (
    relevance === "adjacent" &&
    h("li", { class: "chip chip-adjacent" }, "jazz-adjacent")
  );
}

function renderMeta(event: CalendarEvent): Node | null {
  const chips = [
    adjacentChip(event.relevance),
    ...(event.tags ?? []).map((tag) => h("li", { class: "chip" }, tag)),
  ].filter(Boolean);
  if (!event.price && chips.length === 0) return null;
  return h(
    "div",
    { class: "event-meta" },
    event.price && h("span", { class: "event-price" }, event.price),
    chips.length > 0 &&
      h("ul", { class: "chips", "aria-label": "Tags" }, ...chips),
  );
}

function renderLinks(event: CalendarEvent, venueName: string): Node | null {
  const details = safeUrl(event.url);
  const tickets = safeUrl(event.ticket_url);
  if (!details && !tickets) return null;
  const about = ` for ${event.title} at ${venueName}`;
  return h(
    "p",
    { class: "event-links" },
    details &&
      h("a", { class: "button", href: details }, "Details", srOnly(about)),
    tickets &&
      h(
        "a",
        { class: "button button-primary", href: tickets },
        "Tickets",
        srOnly(about),
      ),
  );
}

function renderEvent(
  event: CalendarEvent,
  venue: Venue | undefined,
  now: Date,
): HTMLLIElement {
  const classes = ["event", event.relevance];
  if (event.cancelled) classes.push("cancelled");
  const titleId = `event-${event.id}`;
  const artists = extraArtists(event);
  const endLabel = eventEndLabel(event);
  const onNow = !event.cancelled && isOnNow(event, now);
  return h(
    "li",
    { class: classes.join(" ") },
    h(
      "article",
      { "aria-labelledby": titleId },
      h(
        "p",
        { class: "event-time" },
        h("time", { datetime: event.start }, eventTimeLabel(event)),
        endLabel && h("span", { class: "event-end" }, endLabel),
        onNow && h("span", { class: "badge badge-now" }, "On now"),
      ),
      h(
        "div",
        { class: "event-body" },
        h(
          "h3",
          { class: "event-title", id: titleId },
          event.cancelled &&
            h("span", { class: "badge badge-cancelled" }, "Cancelled"),
          h("span", { class: "event-title-text" }, event.title),
        ),
        artists.length > 0 &&
          h("p", { class: "event-artists" }, `with ${artists.join(", ")}`),
        renderVenue(event.venue, venue),
        renderMeta(event),
        renderLinks(event, venue?.name ?? event.venue),
      ),
    ),
  );
}

function relativeDay(day: DayKey, today: DayKey): string | null {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return null;
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
    const relative = relativeDay(day, today);
    fragment.append(
      h(
        "section",
        { class: "day", "aria-labelledby": headingId },
        h(
          "h2",
          { class: "day-heading", id: headingId },
          h("time", { datetime: day }, formatDayHeading(day)),
          relative && h("span", { class: "day-relative" }, relative),
        ),
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
  const venueName = venue?.name ?? regular.venue;
  const schedule = safeUrl(regular.url);
  const checked = formatDate(regular.checked);
  const chip = adjacentChip(regular.relevance);
  return h(
    "li",
    { class: `regular ${regular.relevance}` },
    h(
      "article",
      { class: "event-body", "aria-labelledby": titleId },
      h("h3", { class: "event-title", id: titleId }, regular.title),
      h("p", { class: "regular-when" }, regular.when),
      renderVenue(regular.venue, venue),
      chip &&
        h(
          "div",
          { class: "event-meta" },
          h("ul", { class: "chips", "aria-label": "Tags" }, chip),
        ),
      h(
        "p",
        { class: "event-links" },
        schedule &&
          h(
            "a",
            { class: "button", href: schedule },
            "Schedule",
            srOnly(` for ${regular.title} at ${venueName}`),
          ),
        checked &&
          h(
            "span",
            { class: "regular-checked" },
            "as of ",
            h("time", { datetime: regular.checked }, checked),
          ),
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
