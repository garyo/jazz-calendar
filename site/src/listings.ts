/**
 * Pure listing logic: which events are upcoming, which events and regulars
 * match the filters, and how events group into Boston-local days.
 */

import { matchesSelection } from "./selection";
import { addDays, type DayKey, dayKey, weekday } from "./time";
import type { CalendarEvent, Regular, Venue } from "./types";
import type { DatePreset, ViewState } from "./url-state";

/** How long an event with no end time is assumed to last. */
export const ASSUMED_DURATION_MS = 3 * 60 * 60 * 1000;

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

/** The list view's days: the chosen day, else the date preset's. */
function listRange(state: ViewState, today: DayKey): DayRange | null {
  return state.day
    ? { from: state.day, to: state.day }
    : presetRange(state.when, today);
}

/** Events matching the selection and search, whatever their date. */
export function matchingEvents(
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
  state: ViewState,
): CalendarEvent[] {
  const terms = searchTerms(state.query);
  return events.filter((event) => {
    const venue = venues.get(event.venue);
    return (
      matchesSelection(event, venue, state) &&
      matchesTerms(
        [event.title, ...(event.artists ?? []), venue?.name ?? ""],
        terms,
      )
    );
  });
}

/** The list view's events: upcoming, matching, and within its days. */
export function filterEvents(
  events: readonly CalendarEvent[],
  venues: ReadonlyMap<string, Venue>,
  state: ViewState,
  now: Date,
): CalendarEvent[] {
  const today = dayKey(now);
  const range = listRange(state, today);
  const upcoming = events.filter((event) => {
    if (!isUpcoming(event, now)) return false;
    if (!range) return true;
    const day = listingDay(event, today);
    return day >= range.from && day <= range.to;
  });
  return matchingEvents(upcoming, venues, state);
}

/** Regulars matching the selection and search; dates don't apply to them. */
export function filterRegulars(
  regulars: readonly Regular[],
  venues: ReadonlyMap<string, Venue>,
  state: ViewState,
): Regular[] {
  const terms = searchTerms(state.query);
  return regulars.filter((regular) => {
    const venue = venues.get(regular.venue);
    return (
      matchesSelection(regular, venue, state) &&
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

export interface StripDay {
  day: DayKey;
  /** Shows listed that day; 0 for a quiet day inside the range. */
  count: number;
}

/**
 * The days a list covers, for a strip of day links: every day from the first
 * group's through the last's, at most `max` of them. Fewer than two days
 * make no strip.
 */
export function stripDays(groups: readonly DayGroup[], max = 14): StripDay[] {
  const first = groups[0]?.day;
  const last = groups.at(-1)?.day;
  if (!first || !last || first === last) return [];
  const counts = new Map(groups.map(({ day, events }) => [day, events.length]));
  const days: StripDay[] = [];
  for (
    let day = first;
    day <= last && days.length < max;
    day = addDays(day, 1)
  ) {
    days.push({ day, count: counts.get(day) ?? 0 });
  }
  return days;
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

/** A venue name for sorting: "The Lilypad" sorts as "Lilypad". */
export function sortName(name: string): string {
  return normalize(name).replace(/^the\s+/, "");
}

/** Venues with at least one of the given listings, by town and then name. */
export function venuesWithListings(
  listings: readonly { venue: string }[],
  venues: ReadonlyMap<string, Venue>,
): Venue[] {
  const ids = new Set(listings.map((listing) => listing.venue));
  return [...venues.values()]
    .filter((venue) => ids.has(venue.id))
    .sort(
      (a, b) =>
        a.town.localeCompare(b.town) ||
        sortName(a.name).localeCompare(sortName(b.name)),
    );
}
