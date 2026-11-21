/**
 * The home page, with the next two weeks' shows written into it, so search
 * engines and readers without JavaScript see the listings, not just the
 * page's frame. The shows go into #results, after the <noscript> notice, as
 * a plain version of the list view that the script replaces once the feed
 * loads; and into the head as schema.org MusicEvent data, which is what
 * Google reads for its event listings.
 *
 * The page comes from the asset layer unchanged when events.json is
 * missing, and its ETag is dropped either way, since it would vouch only
 * for the static file.
 */

import { groupByDay, isUpcoming, venueLocation } from "./listings";
import {
  addDays,
  type DayKey,
  dayParts,
  eventEndLabel,
  eventNight,
  eventTimeLabel,
  formatShortClock,
  nightOf,
} from "./time";
import type { CalendarEvent, EventsFile, Venue } from "./types";
import { type CalendarEnv, loadFeed } from "./worker-calendar";

export const PAGE_PATH = "/";
/** Nights written into the page, today included. */
const NIGHTS = 14;
const SCHEMA = "https://schema.org";
/** Every venue is in Massachusetts. */
const REGION = "MA";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** An http(s) URL, escaped for an attribute, or null. */
function href(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? escapeHtml(parsed.href)
      : null;
  } catch {
    return null;
  }
}

function link(url: string | null | undefined, text: string): string {
  const target = href(url);
  return target
    ? `<a href="${target}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`
    : escapeHtml(text);
}

/** The shows to write in: upcoming, on tonight or one of the next nights. */
export function upcoming(
  events: readonly CalendarEvent[],
  now: Date,
): CalendarEvent[] {
  const today = nightOf(now);
  const last = addDays(today, NIGHTS - 1);
  return events.filter(
    (event) => isUpcoming(event, now) && eventNight(event) <= last,
  );
}

function clock(long: string, short: string): string {
  return `<span class="clock-long">${escapeHtml(long)}</span><span class="clock-short">${escapeHtml(short)}</span>`;
}

/** Venue, neighborhood and town, marked up as the list view's are. */
function renderPlace(venue: Venue): string {
  const hood = venueLocation(venue).slice(0, -venue.town.length);
  return [
    link(venue.url, venue.name),
    '<span class="event-place">',
    hood ? `<span class="event-hood">${escapeHtml(hood)}</span>` : "",
    `${escapeHtml(venue.town)}</span>`,
  ].join("");
}

function renderEvent(event: CalendarEvent, venue: Venue | undefined): string {
  const time = event.all_day
    ? escapeHtml(eventTimeLabel(event))
    : clock(eventTimeLabel(event), formatShortClock(new Date(event.start)));
  const end = eventEndLabel(event);
  const endClock =
    end && event.end
      ? ` <span class="event-end">${clock(end, `to ${formatShortClock(new Date(event.end))}`)}</span>`
      : "";
  const cancelled = event.cancelled
    ? ' <span class="badge badge-cancelled">Cancelled</span>'
    : "";
  const place = venue ? renderPlace(venue) : escapeHtml(event.venue);
  const classes = ["event", event.relevance, event.cancelled && "cancelled"];
  return [
    `<li class="${classes.filter(Boolean).join(" ")}"><article class="event-row">`,
    `<p class="event-time"><time datetime="${escapeHtml(event.start)}">${time}</time>${endClock}</p>`,
    `<h3 class="event-title">${link(event.url, event.title)}${cancelled}</h3>`,
    `<p class="event-venue">${place}</p>`,
    "</article></li>",
  ].join("");
}

function renderHeading(day: DayKey, today: DayKey): string {
  const parts = dayParts(day);
  const relative =
    day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : null;
  return [
    `<h2 class="day-heading"><time datetime="${day}">`,
    `<span class="day-long">${escapeHtml(parts.long)}</span>`,
    `<span class="day-short">${escapeHtml(`${parts.weekday} ${parts.day}`)}<span class="day-month"> ${escapeHtml(parts.month)}</span></span>`,
    "</time>",
    relative ? `<span class="day-relative">${relative}</span>` : "",
    "</h2>",
  ].join("");
}

/**
 * The listings as HTML: one section per night, like the list view's, but
 * without its data-key attributes, so the script replaces them all.
 */
export function renderListings(
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
  today: DayKey,
): string {
  return groupByDay(events, today)
    .map(
      ({ day, events }) =>
        `<section class="day">${renderHeading(day, today)}<ol class="events">${events
          .map((event) => renderEvent(event, venues.get(event.venue)))
          .join("")}</ol></section>`,
    )
    .join("");
}

/** A show as a schema.org MusicEvent. */
function musicEvent(
  event: CalendarEvent,
  venue: Venue | undefined,
): Record<string, unknown> {
  const dated = (iso: string) => (event.all_day ? iso.slice(0, 10) : iso);
  return {
    "@type": "MusicEvent",
    name: event.title,
    startDate: dated(event.start),
    ...(event.end && !event.all_day ? { endDate: event.end } : {}),
    eventStatus: `${SCHEMA}/${event.cancelled ? "EventCancelled" : "EventScheduled"}`,
    eventAttendanceMode: `${SCHEMA}/OfflineEventAttendanceMode`,
    url: event.url,
    location: {
      "@type": "Place",
      name: venue?.name ?? event.venue,
      ...(venue?.url ? { url: venue.url } : {}),
      address: {
        "@type": "PostalAddress",
        ...(venue?.address ? { streetAddress: venue.address } : {}),
        ...(venue ? { addressLocality: venue.town } : {}),
        addressRegion: REGION,
        addressCountry: "US",
      },
    },
    ...(event.artists?.length
      ? {
          performer: event.artists.map((name) => ({
            "@type": "PerformingGroup",
            name,
          })),
        }
      : {}),
    ...(event.ticket_url
      ? { offers: { "@type": "Offer", url: event.ticket_url } }
      : {}),
  };
}

/**
 * The shows as a JSON-LD script's text. "<" is escaped, so no title can
 * end the script early.
 */
export function structuredData(
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
): string {
  const graph = events.map((event) =>
    musicEvent(event, venues.get(event.venue)),
  );
  return JSON.stringify({ "@context": SCHEMA, "@graph": graph }).replace(
    /</g,
    "\\u003c",
  );
}

/** The page's additions for the feed at `now`. */
export function prerender(
  data: EventsFile,
  venues: ReadonlyMap<string, Venue>,
  now: Date,
): { head: string; listings: string } {
  const events = upcoming(data.events, now);
  return {
    head: `<script type="application/ld+json">${structuredData(events, venues)}</script>`,
    listings: renderListings(events, venues, nightOf(now)),
  };
}

/** The home page from the asset layer, with the coming shows written in. */
export async function servePage(
  request: Request,
  env: CalendarEnv & { ASSETS: Fetcher },
  now = new Date(),
): Promise<Response> {
  // Unconditionally, so a 304 can't stand for a page whose listings changed.
  const page = await env.ASSETS.fetch(request.url, { method: request.method });
  const type = page.headers.get("content-type") ?? "";
  if (!page.ok || !type.startsWith("text/html")) return page;
  const feed = await loadFeed(env).catch((error: unknown) => {
    console.error("events.json didn't load for the page:", error);
    return undefined;
  });
  const response = new Response(page.body, page);
  response.headers.delete("etag");
  if (!feed) return response;
  const { head, listings } = prerender(feed.data, feed.venues, now);
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(head, { html: true });
      },
    })
    .on("#results", {
      element(element) {
        element.append(listings, { html: true });
      },
    })
    .transform(response);
}
