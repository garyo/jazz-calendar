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

/**
 * A standing weekly series with no dated listings. Shown apart from the
 * calendar, since a standing schedule doesn't promise any particular night.
 */
export interface Regular {
  /** Venue id; see EventsFile.venues. */
  venue: string;
  title: string;
  /** The schedule as the venue states it, e.g. "Tuesday–Saturday, 7–9 pm". */
  when: string;
  relevance: Relevance;
  /** Where the venue or organizer publishes the schedule. */
  url: string;
  /** "YYYY-MM-DD": when we last confirmed the schedule there. */
  checked: string;
}

/** A source of the published listings, and how to credit it. */
export interface SourceCredit {
  /** Source id, as in CalendarEvent.sources. */
  id: string;
  /** For people, e.g. "The Lilypad’s calendar". */
  name: string;
  /** A public https page for people, never an API or feed. */
  url: string;
  /** A third party to the venue, such as a ticket seller; listings say "via" it. */
  via?: boolean;
}

/** Served as /data/events.json. */
export interface EventsFile {
  version?: number;
  generated_at: string;
  venues: Venue[];
  /** Sorted by start. */
  events: CalendarEvent[];
  /** Optional here so the site copes with an older feed. */
  regulars?: Regular[];
  /**
   * Every source some event lists, in priority order. Optional here so the
   * site copes with an older feed.
   */
  sources?: SourceCredit[];
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
