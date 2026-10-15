/**
 * Calendar export: iCalendar (RFC 5545) feeds and files, and Google
 * Calendar "add event" links. Shared by the Worker (filtered feeds) and the
 * front end (one-show downloads), and kept free of DOM and Worker APIs.
 */

import { type Credits, viaCredits, viaLine } from "./credits";
import { addDays, dayKey, TIME_ZONE } from "./time";
import type { CalendarEvent, SourceCredit, Venue } from "./types";

export const UID_DOMAIN = "bostonjazzcalendar.com";
const PRODID = "-//bostonjazzcalendar.com//site//EN";
/** RFC 5545 §3.1: content lines are folded at 75 octets. */
const MAX_LINE_OCTETS = 75;
const GOOGLE_TEMPLATE = "https://calendar.google.com/calendar/render";

/** Escapes a TEXT value (RFC 5545 §3.3.11); other control characters are dropped. */
export function escapeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\\;,]/g, (char) => `\\${char}`)
    .replace(/\n/g, "\\n")
    .replace(/\p{Cc}/gu, "");
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/**
 * Folds a content line into CRLF-joined pieces of at most 75 octets, each
 * continuation starting with a space. Never splits a UTF-8 sequence.
 */
export function foldLine(line: string): string {
  const pieces: string[] = [];
  let piece = "";
  let octets = 0;
  for (const char of line) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (octets + size > MAX_LINE_OCTETS) {
      pieces.push(piece);
      piece = " ";
      octets = 1;
    }
    piece += char;
    octets += size;
  }
  pieces.push(piece);
  return pieces.join("\r\n");
}

/** "20261015T233000Z". */
export function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function compactDate(key: string): string {
  return key.replaceAll("-", "");
}

/**
 * An all-day event's dates as an exclusive range of Boston-local days,
 * "YYYYMMDD": from its start day to the day after its last.
 */
function allDayRange(event: CalendarEvent): [string, string] {
  const first = dayKey(new Date(event.start));
  const last = event.end ? dayKey(new Date(event.end)) : first;
  const end = addDays(last > first ? last : first, 1);
  return [compactDate(first), compactDate(end)];
}

/** The end instant, when it's known and after the start. */
function endDate(event: CalendarEvent): Date | null {
  if (!event.end) return null;
  const end = new Date(event.end);
  return end > new Date(event.start) ? end : null;
}

export function eventSummary(event: CalendarEvent, venue?: Venue): string {
  return venue ? `${event.title} @ ${venue.name}` : event.title;
}

/** "The Lilypad, 1353 Cambridge St, Cambridge". */
export function eventLocation(venue?: Venue): string {
  if (!venue) return "";
  return [venue.name, venue.address, venue.town].filter(Boolean).join(", ");
}

/**
 * Price, the details and ticket links, then the third parties the listing
 * came through, one per line.
 */
export function eventDescription(
  event: CalendarEvent,
  via: readonly SourceCredit[] = [],
): string {
  return [
    event.price,
    `Details: ${event.url}`,
    event.ticket_url && `Tickets: ${event.ticket_url}`,
    ...via.map(viaLine),
  ]
    .filter(Boolean)
    .join("\n");
}

function veventLines(
  event: CalendarEvent,
  venue: Venue | undefined,
  via: readonly SourceCredit[],
  stamp: string,
): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.id}@${UID_DOMAIN}`,
    `DTSTAMP:${stamp}`,
  ];
  if (event.all_day) {
    const [start, end] = allDayRange(event);
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
  } else {
    lines.push(`DTSTART:${utcStamp(new Date(event.start))}`);
    const end = endDate(event);
    if (end) lines.push(`DTEND:${utcStamp(end)}`);
  }
  lines.push(`SUMMARY:${escapeText(eventSummary(event, venue))}`);
  const location = eventLocation(venue);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  lines.push(
    `URL:${event.url.replace(/\p{Cc}/gu, "")}`,
    `DESCRIPTION:${escapeText(eventDescription(event, via))}`,
  );
  if (event.cancelled) lines.push("STATUS:CANCELLED");
  lines.push("END:VEVENT");
  return lines;
}

export interface CalendarOptions {
  /** X-WR-CALNAME. */
  name: string;
  /** DTSTAMP for every event: when the data was generated. */
  stamp: Date;
  /** For subscriptions: how often clients should refetch. */
  refreshHours?: number;
  /** The feed's source credits, for "Listing via" lines. */
  credits?: Credits;
}

/** A complete VCALENDAR with CRLF line endings and folded lines. */
export function buildCalendar(
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
  { name, stamp, refreshHours, credits = new Map() }: CalendarOptions,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${TIME_ZONE}`,
  ];
  if (refreshHours) {
    const duration = `PT${refreshHours}H`;
    lines.push(
      `REFRESH-INTERVAL;VALUE=DURATION:${duration}`,
      `X-PUBLISHED-TTL:${duration}`,
    );
  }
  const dtstamp = utcStamp(stamp);
  for (const event of events) {
    // A malformed date would otherwise throw and lose the whole feed.
    if (Number.isNaN(Date.parse(event.start))) continue;
    lines.push(
      ...veventLines(
        event,
        venues.get(event.venue),
        viaCredits(event, credits),
        dtstamp,
      ),
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/**
 * A Google Calendar "add event" link. Google needs an end, so a show with
 * none gets `assumedDurationMs`.
 */
export function googleEventUrl(
  event: CalendarEvent,
  venue: Venue | undefined,
  assumedDurationMs: number,
  via: readonly SourceCredit[] = [],
): string {
  let dates: string;
  if (event.all_day) {
    dates = allDayRange(event).join("/");
  } else {
    const start = new Date(event.start);
    const end = endDate(event) ?? new Date(start.getTime() + assumedDurationMs);
    dates = `${utcStamp(start)}/${utcStamp(end)}`;
  }
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: eventSummary(event, venue),
    dates,
    location: eventLocation(venue),
    details: eventDescription(event, via),
    ctz: TIME_ZONE,
  });
  return `${GOOGLE_TEMPLATE}?${params}`;
}
