/**
 * The published data feed, hand-mirrored from ../../schema/events.schema.json
 * (generated from the scraper's pydantic models). Keep the two in sync.
 * Fields the schema gives a default are optional here, so the site copes
 * with a producer that omits them.
 */

export type Relevance = "jazz" | "adjacent";
export type JazzLevel = "dedicated" | "regular" | "occasional";

export interface Venue {
  /** Stable slug, e.g. "lilypad". */
  id: string;
  name: string;
  address?: string | null;
  /** Municipality, e.g. "Cambridge". */
  town: string;
  /** e.g. "Inman Square", "South End". */
  neighborhood?: string | null;
  /** Venue home page. */
  url?: string | null;
  jazz_level: JazzLevel;
  lat?: number | null;
  lng?: number | null;
}

/** The schema's `Event`, renamed so it doesn't shadow the DOM's `Event`. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 with UTC offset, Boston local time. */
  start: string;
  end?: string | null;
  /** True when no start time is known. */
  all_day?: boolean;
  /** Venue id; see EventsFile.venues. */
  venue: string;
  /** Where to read about the event: the venue's or source's page. */
  url: string;
  ticket_url?: string | null;
  /** Free text, e.g. "$20", "Free", "$15-25". */
  price?: string | null;
  artists?: string[];
  relevance: Relevance;
  /** e.g. "jam", "brunch", "big band". */
  tags?: string[];
  cancelled?: boolean;
  /** Ids of the sources that list this event. */
  sources: string[];
}

/** Served as /data/events.json. */
export interface EventsFile {
  version?: number;
  generated_at: string;
  venues: Venue[];
  /** Sorted by start. */
  events: CalendarEvent[];
}

/** Served as /data/status.json. */
export interface SourceStatus {
  id: string;
  ok: boolean;
  events: number;
  last_success: string | null;
  error: string | null;
}

export interface StatusFile {
  generated_at: string;
  sources: SourceStatus[];
}
