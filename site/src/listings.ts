/**
 * Pure listing logic: which events are upcoming, which events and regulars
 * match the filters, and how events group into Boston-local days.
 */

import { addDays, type DayKey, dayKey, weekday } from "./time";
import type { CalendarEvent, Regular, Relevance, Venue } from "./types";
import type { DatePreset, Filters } from "./url-state";

/** How long an event with no end time stays listed after it starts. */
const ASSUMED_DURATION_MS = 3 * 60 * 60 * 1000;

export interface DayGroup {
  day: DayKey;
  events: CalendarEvent[];
}

/** Inclusive range of Boston-local days. */
interface DayRange {
  from: DayKey;
  to: DayKey;
}

function lastDay(event: CalendarEvent): DayKey {
  return dayKey(new Date(event.end ?? event.start));
}

/** Not yet over; a started show stays listed until its end (or for a few hours). */
export function isUpcoming(event: CalendarEvent, now: Date): boolean {
  if (event.all_day) return lastDay(event) >= dayKey(now);
  const end = event.end
    ? Date.parse(event.end)
    : Date.parse(event.start) + ASSUMED_DURATION_MS;
  return end > now.getTime();
}

export function isOnNow(event: CalendarEvent, now: Date): boolean {
  return (
    !event.all_day &&
    Date.parse(event.start) <= now.getTime() &&
    isUpcoming(event, now)
  );
}

/** The day an event is listed under: its start day, or today if still running. */
export function listingDay(event: CalendarEvent, today: DayKey): DayKey {
  const start = dayKey(new Date(event.start));
  return start < today ? today : start;
}

/** The days a preset covers, or null for no limit. Friday counts as weekend. */
export function presetRange(
  preset: DatePreset,
  today: DayKey,
): DayRange | null {
  switch (preset) {
    case "tonight":
      return { from: today, to: today };
    case "week":
      return { from: today, to: addDays(today, 6) };
    case "weekend": {
      const day = weekday(today);
      if (day === 0) return { from: today, to: today };
      const from = day >= 5 ? today : addDays(today, 5 - day);
      return { from, to: addDays(today, 7 - day) };
    }
    case "all":
      return null;
  }
}

/** Lowercase, without accents or apostrophes, so "wallys cafe" finds "Wally's Café". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}|['’]/gu, "")
    .toLowerCase();
}

function searchTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

function matchesTerms(texts: readonly string[], terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = normalize(texts.join(" "));
  return terms.every((term) => haystack.includes(term));
}

/** The relevance and town filters, shared by events and regulars. */
function matchesListing(
  listing: { relevance: Relevance },
  venue: Venue | undefined,
  filters: Filters,
): boolean {
  if (!filters.adjacent && listing.relevance === "adjacent") return false;
  return !filters.town || venue?.town === filters.town;
}

export function filterEvents(
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
  filters: Filters,
  now: Date,
): CalendarEvent[] {
  const today = dayKey(now);
  const range = presetRange(filters.when, today);
  const terms = searchTerms(filters.query);
  return events.filter((event) => {
    if (!isUpcoming(event, now)) return false;
    const venue = venues.get(event.venue);
    if (!matchesListing(event, venue, filters)) return false;
    if (range) {
      const day = listingDay(event, today);
      if (day < range.from || day > range.to) return false;
    }
    return matchesTerms(
      [event.title, ...(event.artists ?? []), venue?.name ?? ""],
      terms,
    );
  });
}

/** Regulars matching the filters; date presets don't apply to them. */
export function filterRegulars(
  regulars: readonly Regular[],
  venues: ReadonlyMap<string, Venue>,
  filters: Filters,
): Regular[] {
  const terms = searchTerms(filters.query);
  return regulars.filter((regular) => {
    const venue = venues.get(regular.venue);
    return (
      matchesListing(regular, venue, filters) &&
      matchesTerms([regular.title, venue?.name ?? ""], terms)
    );
  });
}

/** Consecutive runs of same-day events; input is sorted by start. */
export function groupByDay(
  events: readonly CalendarEvent[],
  today: DayKey,
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const event of events) {
    const day = listingDay(event, today);
    const last = groups.at(-1);
    if (last?.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}

/** Artists not already named in the title. */
export function extraArtists(event: CalendarEvent): string[] {
  const title = normalize(event.title);
  return (event.artists ?? []).filter(
    (artist) => !title.includes(normalize(artist)),
  );
}

/** "Inman Square, Cambridge", or just the town. */
export function venueLocation(venue: Venue): string {
  const { neighborhood, town } = venue;
  return neighborhood && neighborhood !== town
    ? `${neighborhood}, ${town}`
    : town;
}

/** Towns of venues that have at least one of the given listings, sorted. */
export function townsWithListings(
  listings: readonly { venue: string }[],
  venues: ReadonlyMap<string, Venue>,
): string[] {
  const towns = new Set<string>();
  for (const listing of listings) {
    const town = venues.get(listing.venue)?.town;
    if (town) towns.add(town);
  }
  return [...towns].sort((a, b) => a.localeCompare(b));
}
