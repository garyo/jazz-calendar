/**
 * Boston-local calendar and clock helpers. All display happens in
 * America/New_York regardless of the viewer's own time zone.
 */

import type { CalendarEvent } from "./types";

export const TIME_ZONE = "America/New_York";

/** A Boston-local calendar date, "YYYY-MM-DD"; compares correctly as a string. */
export type DayKey = string;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// Day keys are pure calendar dates, so they are formatted as UTC noon.
const headingFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "short",
  day: "numeric",
});

const shortDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

function partsOf(format: Intl.DateTimeFormat, date: Date): Parts {
  const parts: Parts = {};
  for (const { type, value } of format.formatToParts(date)) parts[type] = value;
  return parts;
}

function keyToDate(key: DayKey): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** The Boston-local calendar date of an instant. */
export function dayKey(date: Date): DayKey {
  const p = partsOf(dateFormat, date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(key: DayKey, days: number): DayKey {
  const date = keyToDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(key: DayKey): number {
  return keyToDate(key).getUTCDay();
}

/** "Thursday, Oct 15". */
export function formatDayHeading(key: DayKey): string {
  return headingFormat.format(keyToDate(key));
}

/** "8 pm", "8:15 pm". */
export function formatClock(date: Date): string {
  const { hour, minute, dayPeriod } = partsOf(clockFormat, date);
  const time = minute === "00" ? hour : `${hour}:${minute}`;
  return `${time} ${dayPeriod?.toLowerCase()}`;
}

/**
 * The start-time label for an event. `all_day` means no start time is known;
 * an explicit end suggests a genuinely all-day listing rather than a missing
 * time.
 */
export function eventTimeLabel(event: CalendarEvent): string {
  if (event.all_day) return event.end ? "All day" : "Time TBA";
  return formatClock(new Date(event.start));
}

/** "to 9:30 pm", or null when there's no usable end time. */
export function eventEndLabel(event: CalendarEvent): string | null {
  if (event.all_day || !event.end) return null;
  const end = new Date(event.end);
  return end > new Date(event.start) ? `to ${formatClock(end)}` : null;
}

/** "today at 6 am", "yesterday at 11:30 pm", "Oct 12 at 6 am". */
export function formatUpdated(date: Date, now: Date): string {
  const key = dayKey(date);
  const today = dayKey(now);
  const day =
    key === today
      ? "today"
      : key === addDays(today, -1)
        ? "yesterday"
        : shortDateFormat.format(keyToDate(key));
  return `${day} at ${formatClock(date)}`;
}
