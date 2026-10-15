/** Pure logic for the month view: a Sunday-first grid of Boston-local days. */

import { addDays, type DayKey, dayKey, monthOf, weekday } from "./time";
import type { CalendarEvent } from "./types";

export interface MonthDay {
  day: DayKey;
  /** False for the leading and trailing days of neighboring months. */
  inMonth: boolean;
  /** Events starting that day (Boston time), in feed order. */
  events: CalendarEvent[];
}

/**
 * The weeks covering `month` ("YYYY-MM"), Sunday through Saturday, each
 * day holding the given events that start on it. Events are placed by
 * their Boston-local start date, so a 12:30 am set belongs to the next day.
 */
export function buildMonth(
  month: string,
  events: readonly CalendarEvent[],
): MonthDay[][] {
  const first = `${month}-01`;
  const start = addDays(first, -weekday(first));
  const byDay = new Map<DayKey, CalendarEvent[]>();
  const weeks: MonthDay[][] = [];
  for (let day = start; weeks.length === 0 || monthOf(day) === month; ) {
    const week: MonthDay[] = [];
    for (let i = 0; i < 7; i++, day = addDays(day, 1)) {
      const dayEvents: CalendarEvent[] = [];
      byDay.set(day, dayEvents);
      week.push({ day, inMonth: monthOf(day) === month, events: dayEvents });
    }
    weeks.push(week);
  }
  for (const event of events) {
    byDay.get(dayKey(new Date(event.start)))?.push(event);
  }
  return weeks;
}
