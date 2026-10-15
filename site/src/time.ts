/**
 * Boston-local calendar and clock helpers. All display happens in
 * America/New_York regardless of the viewer's own time zone.
 */

import type { CalendarEvent } from "./types";

export const TIME_ZONE = "America/New_York";

/** A Boston-local calendar date, "YYYY-MM-DD"; compares correctly as a string. */
export type DayKey = string;

/**
 * Shows starting before this hour, Boston time, belong to the previous
 * night: a 12:30 am set on Saturday is part of Friday night.
 */
export const NIGHT_CUTOFF_HOUR = 4;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
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

const longDayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
});

const shortDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

const fullDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

const monthFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "long",
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

/**
 * The night an instant belongs to: its Boston-local date, or the day before
 * until NIGHT_CUTOFF_HOUR. Uses the local clock, so DST doesn't move the cutoff.
 */
export function nightOf(date: Date): DayKey {
  const p = partsOf(dateFormat, date);
  const day = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) < NIGHT_CUTOFF_HOUR ? addDays(day, -1) : day;
}

/** The night a listing belongs to. All-day listings keep their date. */
export function eventNight(event: CalendarEvent): DayKey {
  const start = new Date(event.start);
  return event.all_day ? dayKey(start) : nightOf(start);
}

/** A set after midnight, listed with the night before its date. */
export function isLateSet(event: CalendarEvent): boolean {
  return eventNight(event) !== dayKey(new Date(event.start));
}

/** "YYYY-MM": the month a day falls in. */
export function monthOf(key: DayKey): string {
  return key.slice(0, 7);
}

/** The month `months` after "YYYY-MM" (negative for before). */
export function addMonths(month: string, months: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  return date.toISOString().slice(0, 7);
}

/** "November 2026". */
export function formatMonth(month: string): string {
  return monthFormat.format(keyToDate(`${month}-01`));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(key: DayKey): number {
  return keyToDate(key).getUTCDay();
}

/** "Thursday, Oct 15". */
export function formatDayHeading(key: DayKey): string {
  return headingFormat.format(keyToDate(key));
}

export interface DayParts {
  /** "Thursday, October 15". */
  long: string;
  /** "Thu". */
  weekday: string;
  /** "15". */
  day: string;
  /** "Oct". */
  month: string;
}

/** A day's heading in a long and a short form, for the themes to choose from. */
export function dayParts(key: DayKey): DayParts {
  const date = keyToDate(key);
  const { weekday, month, day } = partsOf(longDayFormat, date);
  return {
    long: longDayFormat.format(date),
    weekday: weekday?.slice(0, 3) ?? "",
    day: day ?? "",
    month: month?.slice(0, 3) ?? "",
  };
}

/** "Oct 15, 2026", or null for anything but a "YYYY-MM-DD" date. */
export function formatDate(key: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(key)
    ? fullDateFormat.format(keyToDate(key))
    : null;
}

/** "8 pm", "8:15 pm". */
export function formatClock(date: Date): string {
  const { hour, minute, dayPeriod } = partsOf(clockFormat, date);
  const time = minute === "00" ? hour : `${hour}:${minute}`;
  return `${time} ${dayPeriod?.toLowerCase()}`;
}

/** "8p", "8:15p", "11a": for tight spaces like the month grid. */
export function formatShortClock(date: Date): string {
  const { hour, minute, dayPeriod } = partsOf(clockFormat, date);
  const time = minute === "00" ? hour : `${hour}:${minute}`;
  return `${time}${dayPeriod?.charAt(0).toLowerCase()}`;
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
