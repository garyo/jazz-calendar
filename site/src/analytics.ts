/**
 * Anonymous visit counts through featherstat, the owner's self-hosted analytics
 * (cookieless; IPs are never stored). Runs only on the production host, so local
 * and preview visits stay out of the numbers. Filters rewrite the URL constantly,
 * so this sends one pageview per visit rather than hooking `history`; outbound
 * clicks to venue and ticket pages are counted by the tracker itself.
 */

const ORIGIN = "https://analytics.oberbrunner.com";
const PRODUCTION_HOSTS = [
  "bostonjazzcalendar.com",
  "www.bostonjazzcalendar.com",
];
/** featherstat's id for this site (Settings → Sites); null keeps analytics off. */
const SITE_ID: number | null = 10;

interface Tracker {
  init(config: {
    site: number;
    endpoint: string;
    autoPageviews: boolean;
  }): void;
  page(): void;
}

export async function startAnalytics(): Promise<void> {
  if (SITE_ID === null || !PRODUCTION_HOSTS.includes(location.hostname)) return;
  // A variable, not a literal, so the bundler leaves the import to the browser.
  const trackerUrl = `${ORIGIN}/tracker.js`;
  try {
    const tracker: Tracker = await import(trackerUrl);
    tracker.init({
      site: SITE_ID,
      endpoint: `${ORIGIN}/api/collect`,
      autoPageviews: false,
    });
    tracker.page();
  } catch {
    // Analytics must never break the calendar.
  }
}
