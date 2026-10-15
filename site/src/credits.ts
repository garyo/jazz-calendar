/**
 * Crediting the feed's sources: on each listing that came through a third
 * party ("via Ticketmaster"), in calendar descriptions, and in the page's
 * list of sources. Pure logic, shared by the front end and the Worker.
 */

import type { CalendarEvent, SourceCredit, Venue } from "./types";

export type Credits = ReadonlyMap<string, SourceCredit>;

/** Submitted gigs: credited on each listing, but described on the page in their own line. */
export const SUBMISSIONS = "submissions";

export function creditsById(
  sources: readonly SourceCredit[] = [],
): Map<string, SourceCredit> {
  return new Map(sources.map((source) => [source.id, source]));
}

/** The third parties an event's listings came through, once each, in priority order. */
export function viaCredits(
  event: CalendarEvent,
  credits: Credits,
): SourceCredit[] {
  const found = new Map<string, SourceCredit>();
  for (const id of event.sources) {
    const credit = credits.get(id);
    if (credit?.via && !found.has(credit.name)) found.set(credit.name, credit);
  }
  return [...found.values()];
}

/** "Listing via Ticketmaster: https://www.ticketmaster.com", as the scraper writes it. */
export function viaLine(credit: SourceCredit): string {
  return `Listing via ${credit.name}: ${credit.url}`;
}

export interface SourceEntry {
  name: string;
  url: string;
  /** The venues of the listings it supplied. */
  venues: string[];
}

export interface SourceList {
  /** Venues' and presenters' own calendars. */
  own: SourceEntry[];
  /** Ticket sellers and other services. */
  via: SourceEntry[];
}

/** Compares names with "The Lilypad" under L. */
function byName(a: string, b: string): number {
  const key = (name: string) => name.replace(/^the\s+/i, "");
  return key(a).localeCompare(key(b));
}

/**
 * Every credited source, once per name, in two groups sorted by name, each
 * with the venues of the listings it supplied. Submitted gigs are left out,
 * since the page describes them on their own.
 */
export function sourceList(
  sources: readonly SourceCredit[],
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
): SourceList {
  const named = new Map<string, SourceCredit>();
  const nameOf = new Map<string, string>();
  for (const source of sources) {
    if (source.id === SUBMISSIONS) continue;
    if (!named.has(source.name)) named.set(source.name, source);
    nameOf.set(source.id, source.name);
  }
  const covered = new Map<string, Set<string>>();
  for (const event of events) {
    const venue = venues.get(event.venue)?.name ?? event.venue;
    for (const id of event.sources) {
      const name = nameOf.get(id);
      if (name) covered.set(name, (covered.get(name) ?? new Set()).add(venue));
    }
  }
  const list: SourceList = { own: [], via: [] };
  for (const { name, url, via } of named.values()) {
    const entry = { name, url, venues: [...(covered.get(name) ?? [])] };
    entry.venues.sort(byName);
    (via ? list.via : list.own).push(entry);
  }
  list.own.sort((a, b) => byName(a.name, b.name));
  list.via.sort((a, b) => byName(a.name, b.name));
  return list;
}
