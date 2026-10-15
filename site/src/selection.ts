/**
 * The venue, town and jazz-adjacent selection: the part of a view that a
 * calendar feed can carry. The front end and the Worker both use this
 * module, so the page and /calendar.ics?venue=… always agree on what a
 * selection includes.
 */

import type { Relevance, Venue } from "./types";

export interface Selection {
  /** Venue ids, sorted. */
  venues: string[];
  /** Venue towns, sorted. */
  towns: string[];
  /** Include jazz-adjacent listings. */
  adjacent: boolean;
}

export const EVERYTHING: Readonly<Selection> = {
  venues: [],
  towns: [],
  adjacent: true,
};

export const MAX_VENUES = 64;
export const MAX_TOWNS = 32;

/** How many names a selection's description lists before "+ N more". */
const NAMED_IN_LABEL = 3;

const VENUE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOWN = /^[^\p{C},]{1,64}$/u;

export function isEverything(selection: Selection): boolean {
  return (
    selection.venues.length === 0 &&
    selection.towns.length === 0 &&
    selection.adjacent
  );
}

/**
 * Jazz-adjacent listings drop out when excluded. Beyond that, with no venue
 * or town selected everything matches; otherwise a listing matches when it
 * is at any selected venue or in any selected town.
 */
export function matchesSelection(
  listing: { venue: string; relevance: Relevance },
  venue: Venue | undefined,
  selection: Selection,
): boolean {
  if (!selection.adjacent && listing.relevance === "adjacent") return false;
  const { venues, towns } = selection;
  if (venues.length === 0 && towns.length === 0) return true;
  return (
    venues.includes(listing.venue) ||
    (venue !== undefined && towns.includes(venue.town))
  );
}

/** Values of a comma-separated (or repeated) parameter, deduplicated and sorted. */
function listParam(params: URLSearchParams, name: string): string[] {
  const values = params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].sort();
}

/** For page URLs: anything unusable is dropped. `town=Cambridge` still parses. */
export function parseSelection(params: URLSearchParams): Selection {
  return {
    venues: listParam(params, "venue").slice(0, MAX_VENUES),
    towns: listParam(params, "town").slice(0, MAX_TOWNS),
    adjacent: params.get("adjacent") !== "0",
  };
}

/** For feed URLs: null when a value is malformed or a list is too long. */
export function parseFeedSelection(params: URLSearchParams): Selection | null {
  const adjacent = params.get("adjacent");
  if (adjacent !== null && adjacent !== "0" && adjacent !== "1") return null;
  const venues = listParam(params, "venue");
  const towns = listParam(params, "town");
  if (venues.length > MAX_VENUES || towns.length > MAX_TOWNS) return null;
  if (!venues.every((id) => VENUE_ID.test(id))) return null;
  if (!towns.every((town) => TOWN.test(town))) return null;
  return { venues, towns, adjacent: adjacent !== "0" };
}

/**
 * The selection without venues and towns the venue list lacks, so feeds keep
 * working after a venue leaves the registry. Null when that empties a
 * selection that named some: it must match nothing, not everything.
 */
export function knownSelection(
  selection: Selection,
  venues: readonly Venue[],
): Selection | null {
  const ids = new Set(venues.map((venue) => venue.id));
  const towns = new Set(venues.map((venue) => venue.town));
  const known = {
    ...selection,
    venues: selection.venues.filter((id) => ids.has(id)),
    towns: selection.towns.filter((town) => towns.has(town)),
  };
  const named = selection.venues.length + selection.towns.length;
  return named > 0 && known.venues.length + known.towns.length === 0
    ? null
    : known;
}

/** Sets the selection's non-default parameters. */
export function writeSelection(
  params: URLSearchParams,
  selection: Selection,
): void {
  if (selection.venues.length > 0) {
    params.set("venue", [...selection.venues].sort().join(","));
  }
  if (selection.towns.length > 0) {
    params.set("town", [...selection.towns].sort().join(","));
  }
  if (!selection.adjacent) params.set("adjacent", "0");
}

/** A query string that keeps list commas literal: "venue=lilypad,wallys". */
export function queryString(params: URLSearchParams): string {
  return params.toString().replaceAll("%2C", ",");
}

/** The canonical feed query for a selection, or "" for everything. */
export function feedQuery(selection: Selection): string {
  const params = new URLSearchParams();
  writeSelection(params, selection);
  return queryString(params);
}

/** "The Lilypad, Wally's Café, Somerville", or "" when nothing is selected. */
export function selectionLabel(
  selection: Selection,
  venues: ReadonlyMap<string, Venue>,
): string {
  const names = [
    ...selection.venues.map((id) => venues.get(id)?.name ?? id),
    ...selection.towns,
  ];
  if (names.length <= NAMED_IN_LABEL) return names.join(", ");
  const rest = names.length - NAMED_IN_LABEL;
  return `${names.slice(0, NAMED_IN_LABEL).join(", ")} + ${rest} more`;
}

/** "Boston Jazz Calendar: The Lilypad, Cambridge (jazz only)". */
export function calendarName(
  selection: Selection,
  venues: ReadonlyMap<string, Venue>,
): string {
  const label = selectionLabel(selection, venues);
  const name = label
    ? `Boston Jazz Calendar: ${label}`
    : "Boston Jazz Calendar";
  return selection.adjacent ? name : `${name} (jazz only)`;
}
