/** Pure logic for the month view: a Sunday-first grid of Boston-local days. */

import { addDays, type DayKey, eventNight, monthOf, weekday } from "./time";
import type { CalendarEvent } from "./types";

export interface MonthDay {
  day: DayKey;
  /** False for the leading and trailing days of neighboring months. */
  inMonth: boolean;
  /** Events on that night (see eventNight), in feed order. */
  events: CalendarEvent[];
}

/**
 * The weeks covering `month` ("YYYY-MM"), Sunday through Saturday, each
 * day holding the given events of that night: a 12:30 am set on Saturday
 * goes on Friday, as in the list.
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
    byDay.get(eventNight(event))?.push(event);
  }
  return weeks;
}
