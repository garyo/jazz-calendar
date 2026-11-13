/**
 * Pure listing logic: which events are upcoming, which events and regulars
 * match the filters, and how events group into nights: a Boston-local day
 * plus its small hours (see NIGHT_CUTOFF_HOUR).
 */

import { matchesSelection } from "./selection";
import {
  addDays,
  type DayKey,
  dayKey,
  eventNight,
  eventTimeLabel,
  formatDayHeading,
  monthOf,
  nightOf,
  WEEKDAYS,
  weekday,
} from "./time";
import type { CalendarEvent, Regular, Venue, Weekday } from "./types";
import type { DatePreset, ViewState } from "./url-state";

/** How long an event with no end time is assumed to last. */
export const ASSUMED_DURATION_MS = 3 * 60 * 60 * 1000;

export interface DayGroup {
  day: DayKey;
  events: CalendarEvent[];
}

/** Inclusive range of nights. */
interface DayRange {
  from: DayKey;
  to: DayKey;
}

function lastDay(event: CalendarEvent): DayKey {
  return dayKey(new Date(event.end ?? event.start));
}

/** When a timed show is over: its end, or a few hours after it starts. */
function endTime(event: CalendarEvent): number {
  return event.end
    ? Date.parse(event.end)
    : Date.parse(event.start) + ASSUMED_DURATION_MS;
}

/** Not yet over; a started show stays listed until its end (or for a few hours). */
export function isUpcoming(event: CalendarEvent, now: Date): boolean {
  if (event.all_day) return lastDay(event) >= dayKey(now);
  return endTime(event) > now.getTime();
}

export function isOnNow(event: CalendarEvent, now: Date): boolean {
  return (
    !event.all_day &&
    Date.parse(event.start) <= now.getTime() &&
    isUpcoming(event, now)
  );
}

/**
 * The next instant after `now` when a timed show starts or ends, changing
 * whether it's on now or listed at all; Infinity if none will. All-day
 * listings change with the date (see nextTurnover).
 */
export function nextShowChange(
  events: readonly CalendarEvent[],
  now: Date,
): number {
  let next = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.all_day) continue;
    for (const time of [Date.parse(event.start), endTime(event)]) {
      if (time > now.getTime() && time < next) next = time;
    }
  }
  return next;
}

/** The night an event is listed under: its own, or tonight if still running. */
export function listingDay(event: CalendarEvent, today: DayKey): DayKey {
  const night = eventNight(event);
  return night < today ? today : night;
}

/**
 * The nights a preset covers, or null for no limit. Friday counts as
 * weekend. `today` is tonight (see nightOf), so at 1 am it is still the
 * evening's date.
 */
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

export function searchTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

export function matchesTerms(
  texts: readonly string[],
  terms: string[],
): boolean {
  if (terms.length === 0) return true;
  const haystack = normalize(texts.join(" "));
  return terms.every((term) => haystack.includes(term));
}

/** The list view's nights: the chosen day, else the date preset's; null for every date. */
export function listRange(state: ViewState, today: DayKey): DayRange | null {
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
  const today = nightOf(now);
  const range = listRange(state, today);
  const upcoming = events.filter((event) => {
    if (!isUpcoming(event, now)) return false;
    if (!range) return true;
    const day = listingDay(event, today);
    return day >= range.from && day <= range.to;
  });
  return matchingEvents(upcoming, venues, state);
}

/**
 * Whether a regular usually runs on a day: one of its weekdays and, when it
 * says which of them in a month ("1st and 3rd Fridays"), one of those.
 */
export function runsOn(regular: Regular, day: DayKey): boolean {
  // A feed older than `days` doesn't say, so no day can claim it.
  if (!regular.days?.includes(WEEKDAYS[weekday(day)])) return false;
  const nth = regular.nth ?? [];
  if (nth.length === 0) return true;
  const isLast = monthOf(addDays(day, 7)) !== monthOf(day);
  return (
    nth.includes(Math.ceil(Number(day.slice(8)) / 7)) ||
    (isLast && nth.includes(-1))
  );
}

/** Every day of a range, at most a week of them. */
function daysOf({ from, to }: DayRange): DayKey[] {
  const days: DayKey[] = [];
  for (let day = from; day <= to && days.length < 7; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * Regulars matching the selection and search. In a view limited to some
 * days, only those that usually run on one of them.
 */
export function filterRegulars(
  regulars: readonly Regular[],
  venues: ReadonlyMap<string, Venue>,
  state: ViewState,
  today: DayKey,
): Regular[] {
  const terms = searchTerms(state.query);
  const range = listRange(state, today);
  const days = range && daysOf(range);
  return regulars.filter((regular) => {
    const venue = venues.get(regular.venue);
    return (
      matchesSelection(regular, venue, state) &&
      matchesTerms([regular.title, venue?.name ?? ""], terms) &&
      (!days || days.some((day) => runsOn(regular, day)))
    );
  });
}

/** The list view's days in a sentence: "tonight", "on Saturday, Oct 17"; null for no limit. */
function datePhrase(state: ViewState, today: DayKey): string | null {
  if (state.day) {
    return state.day === today
      ? "tonight"
      : `on ${formatDayHeading(state.day)}`;
  }
  switch (state.when) {
    case "tonight":
      return "tonight";
    case "weekend":
      return "this weekend";
    case "week":
      return "in the next 7 days";
    case "all":
      return null;
  }
}

/**
 * The line for a view with no dated shows but some weekly regulars, pointing
 * down to them: "No dated shows tonight, but see the regular weekly gig below."
 * Null when there are no regulars.
 */
export function regularsNotice(
  count: number,
  state: ViewState,
  today: DayKey,
  filtered: boolean,
): string | null {
  if (count === 0) return null;
  const dates = datePhrase(state, today) ?? (filtered ? "match" : "listed");
  return `No dated shows ${dates}, but see the regular weekly ${count === 1 ? "gig" : "gigs"} below.`;
}

/** A night of shows, with the weekly regulars that usually run then. */
export interface Night extends DayGroup {
  regulars: Regular[];
}

/** Whether a show that night is the regular itself: same venue, and one title contains the other. */
function listedAs(regular: Regular, events: readonly CalendarEvent[]): boolean {
  const title = normalize(regular.title);
  return events.some((event) => {
    const other = normalize(event.title);
    return (
      event.venue === regular.venue &&
      (other.includes(title) || title.includes(other))
    );
  });
}

/**
 * The nights to list: each night of shows, and for the nights in `range`
 * (a week at most) the regulars that usually run then, adding nights that
 * have regulars but no shows. A regular a show that night already lists
 * isn't repeated.
 */
export function withRegulars(
  groups: readonly DayGroup[],
  regulars: readonly Regular[],
  range: DayRange,
): Night[] {
  const nights = new Map<DayKey, Night>(
    groups.map((group) => [group.day, { ...group, regulars: [] }]),
  );
  for (const day of daysOf(range)) {
    const night = nights.get(day) ?? { day, events: [], regulars: [] };
    night.regulars = regulars.filter(
      (regular) => runsOn(regular, day) && !listedAs(regular, night.events),
    );
    if (night.regulars.length > 0) nights.set(day, night);
  }
  return [...nights.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Events grouped by the night they're listed under, nights in order and
 * each night's events in input order (sorted by start). An all-day listing
 * at midnight sorts between a night's evening and its late sets, so a
 * night's events aren't always consecutive.
 */
export function groupByDay(
  events: readonly CalendarEvent[],
  today: DayKey,
): DayGroup[] {
  const groups = new Map<DayKey, CalendarEvent[]>();
  for (const event of events) {
    const day = listingDay(event, today);
    const group = groups.get(day);
    if (group) group.push(event);
    else groups.set(day, [event]);
  }
  return [...groups]
    .map(([day, events]) => ({ day, events }))
    .sort((a, b) => a.day.localeCompare(b.day));
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

/** A name for sorting: "The Lilypad" sorts as "Lilypad". */
export function sortName(name: string): string {
  return normalize(name).replace(/^the\s+/, "");
}

/** Compares names by sortName, so "The Lilypad" files under L. */
export function byName(a: string, b: string): number {
  return sortName(a).localeCompare(sortName(b));
}

/** "1 show", "3 shows". */
export function showCount(count: number): string {
  return `${count} ${count === 1 ? "show" : "shows"}`;
}

/** Venues with at least one of the given listings, by town and then name. */
export function venuesWithListings(
  listings: readonly { venue: string }[],
  venues: ReadonlyMap<string, Venue>,
): Venue[] {
  const ids = new Set(listings.map((listing) => listing.venue));
  return [...venues.values()]
    .filter((venue) => ids.has(venue.id))
    .sort((a, b) => a.town.localeCompare(b.town) || byName(a.name, b.name));
}

/** A listing already on the calendar that a submission may repeat. */
export interface Existing {
  title: string;
  /** "Thursday, Nov 20, 8:15 pm", or a regular's schedule. */
  when: string;
}

/** Where and when a gig (`date`) or regular (`days`) runs. */
interface Slot {
  venue: string | null;
  date: DayKey | null;
  days: readonly Weekday[] | null;
}

/**
 * Upcoming listings at a submission's venue that it may repeat, one per
 * title: for a gig, the events and regulars on its night; for a regular,
 * those on any of its weekdays.
 */
export function alreadyListed(
  slot: Slot,
  events: readonly CalendarEvent[],
  regulars: readonly Regular[],
  today: DayKey,
): Existing[] {
  const { venue, date, days } = slot;
  if (!venue || !(date || days?.length)) return [];
  const found = new Map<string, Existing>();
  for (const regular of regulars) {
    const runs = date
      ? runsOn(regular, date)
      : regular.days?.some((day) => days?.includes(day));
    if (regular.venue === venue && runs) {
      found.set(normalize(regular.title), {
        title: regular.title,
        when: regular.when,
      });
    }
  }
  for (const event of events) {
    const night = eventNight(event);
    const onNight = date
      ? night === date
      : days?.includes(WEEKDAYS[weekday(night)]);
    const key = normalize(event.title);
    if (
      event.venue === venue &&
      !event.cancelled &&
      night >= today &&
      onNight &&
      !found.has(key)
    ) {
      found.set(key, {
        title: event.title,
        when: `${formatDayHeading(night)}, ${eventTimeLabel(event)}`,
      });
    }
  }
  return [...found.values()];
}

/** Listings in a line: “Title” (when), …, and how many more past `max`. */
export function listedText(listed: readonly Existing[], max = 4): string {
  const named = listed
    .slice(0, max)
    .map(({ title, when }) => `“${title}” (${when})`);
  const more = listed.length - max;
  return more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
}
