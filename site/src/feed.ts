/** The listings feed, /data/events.json, indexed for the page. */

import {
  type Credits,
  creditsById,
  type SourceList,
  sourceList,
} from "./credits";
import { venuesWithListings } from "./listings";
import type { CalendarEvent, EventsFile, Regular, Venue } from "./types";

const FEED_URL = "/data/events.json";

export interface Feed {
  generatedAt: string;
  events: CalendarEvent[];
  regulars: Regular[];
  /** Every venue, by id. */
  venues: Map<string, Venue>;
  /** Venues with at least one listing or regular, by town and name. */
  listed: Venue[];
  credits: Credits;
  sources: SourceList;
}

/** Indexes a feed; an older one without regulars or sources still works. */
export function readFeed(file: EventsFile): Feed {
  const venues = new Map(file.venues.map((venue) => [venue.id, venue]));
  const regulars = file.regulars ?? [];
  const sources = file.sources ?? [];
  return {
    generatedAt: file.generated_at,
    events: file.events,
    regulars,
    venues,
    listed: venuesWithListings([...file.events, ...regulars], venues),
    credits: creditsById(sources),
    sources: sourceList(sources, file.events, venues),
  };
}

export async function fetchFeed(): Promise<Feed> {
  const response = await fetch(FEED_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readFeed(await response.json());
}
