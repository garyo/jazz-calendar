/**
 * The dead-man's switch: an hourly cron (wrangler.toml) checks when the
 * scraper last uploaded status.json and tells the owner through ntfy when it's
 * stale, so a broken scraper on the Mac doesn't go unnoticed. Only full runs
 * upload status.json; the quick republishes after approvals (`jazzcal
 * refresh`) upload just events.json, so they can't hide a broken scrape.
 *
 * It keeps no state. The check alerts in the hour after the data turns 30
 * hours old, then in the same hour of each following day (54 h, 78 h, …).
 * The cron's scheduled times are exactly an hour apart, so exactly one tick
 * lands in each of those hours: one notice a day while the data stays stale.
 */

import { type NotifyEnv, notify } from "./worker-notify";

export interface FreshnessEnv extends NotifyEnv {
  DATA: R2Bucket;
}

const HOUR = 3_600_000;
/** The scraper uploads daily, so this allows one late or failed run. */
export const STALE_HOURS = 30;
const REPEAT_HOURS = 24;
/** With no status.json at all, alert once a day at this hour (13:00 UTC is 8 or 9 a.m. in Boston). */
const MISSING_ALERT_UTC_HOUR = 13;
const LOG = "~/Library/Logs/jazzcal.log";
const TITLE = "Boston Jazz Calendar: no fresh data";

/** Whether the hourly tick should alert about data this old. */
export function staleAlertDue(ageMs: number): boolean {
  const hoursOver = Math.floor(ageMs / HOUR) - STALE_HOURS;
  return hoursOver >= 0 && hoursOver % REPEAT_HOURS === 0;
}

function bostonTime(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Checks status.json's age at the cron's scheduled time and alerts if due. */
export async function checkFreshness(
  env: FreshnessEnv,
  scheduledTime: number,
): Promise<void> {
  const head = await env.DATA.head("status.json");
  let message: string;
  if (head) {
    const ageMs = scheduledTime - head.uploaded.getTime();
    if (!staleAlertDue(ageMs)) return;
    const hours = Math.floor(ageMs / HOUR);
    message = `The scraper last finished a full run ${hours} hours ago (${bostonTime(head.uploaded)}).`;
  } else {
    if (new Date(scheduledTime).getUTCHours() !== MISSING_ALERT_UTC_HOUR) {
      return;
    }
    message = "status.json is missing from R2.";
  }
  await notify(env, {
    title: TITLE,
    message: `${message}\nCheck the scraper on the Mac and ${LOG}.`,
    tags: ["warning"],
    priority: 4,
  });
}
