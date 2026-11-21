import { describe, expect, test } from "bun:test";
import type { CalendarEvent, EventsFile, Venue } from "./types";
import { servePage, structuredData, upcoming } from "./worker-page";

const NOW = new Date("2026-10-15T12:00:00-04:00");

const venue: Venue = {
  id: "blue-room",
  name: "The Blue Room",
  address: "1 Example St",
  town: "Cambridge",
  neighborhood: "Kendall Square",
  url: "https://blueroom.example",
  jazz_level: "dedicated",
};

function show(fields: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1",
    title: "Pat Doe Trio",
    start: "2026-10-15T20:00:00-04:00",
    end: "2026-10-15T22:00:00-04:00",
    venue: venue.id,
    url: "https://blueroom.example/pat-doe",
    relevance: "jazz",
    sources: ["blue-room"],
    ...fields,
  };
}

const PAGE = `<!doctype html><html><head><title>t</title></head><body><div id="results"><noscript>n</noscript></div></body></html>`;

function env(feed: EventsFile | null) {
  return {
    ASSETS: {
      fetch: async () =>
        new Response(PAGE, {
          headers: { "content-type": "text/html", etag: '"static"' },
        }),
    } as unknown as Fetcher,
    DATA: {
      get: async () =>
        feed && {
          etag: `v${Math.random()}`,
          body: true,
          json: async () => feed,
        },
    } as unknown as R2Bucket,
  };
}

function feed(events: CalendarEvent[]): EventsFile {
  return { generated_at: NOW.toISOString(), venues: [venue], events };
}

const request = new Request("https://bostonjazzcalendar.com/");

describe("the home page", () => {
  test("lists the coming shows in #results and as MusicEvent data", async () => {
    const response = await servePage(
      request,
      env(feed([show({ title: "Pat Doe <Trio> & Friends" })])),
      NOW,
    );
    const html = await response.text();
    expect(response.headers.get("etag")).toBeNull();
    expect(html).toContain(
      '<noscript>n</noscript><section class="day"><h2 class="day-heading">',
    );
    expect(html).toContain('<span class="day-relative">Today</span>');
    expect(html).toContain(
      '<a href="https://blueroom.example/pat-doe" target="_blank" rel="noopener">Pat Doe &lt;Trio&gt; &amp; Friends</a>',
    );
    expect(html).toContain(
      '<span class="event-hood">Kendall Square, </span>Cambridge</span>',
    );
    const json = html.match(
      /<script type="application\/ld\+json">(.*?)<\/script>/,
    )?.[1];
    const data = JSON.parse(json ?? "null");
    expect(data["@graph"]).toEqual([
      {
        "@type": "MusicEvent",
        name: "Pat Doe <Trio> & Friends",
        startDate: "2026-10-15T20:00:00-04:00",
        endDate: "2026-10-15T22:00:00-04:00",
        eventStatus: "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        url: "https://blueroom.example/pat-doe",
        location: {
          "@type": "Place",
          name: "The Blue Room",
          url: "https://blueroom.example",
          address: {
            "@type": "PostalAddress",
            streetAddress: "1 Example St",
            addressLocality: "Cambridge",
            addressRegion: "MA",
            addressCountry: "US",
          },
        },
      },
    ]);
  });

  test("structured data can't close its script early", () => {
    const text = structuredData(
      [show({ title: "</script><script>alert(1)</script>" })],
      new Map([[venue.id, venue]]),
    );
    expect(text).not.toContain("<");
    expect(JSON.parse(text)["@graph"][0].name).toBe(
      "</script><script>alert(1)</script>",
    );
  });

  test("marks cancelled shows and dates all-day ones", () => {
    const text = structuredData(
      [show({ cancelled: true, all_day: true, end: null })],
      new Map([[venue.id, venue]]),
    );
    const [event] = JSON.parse(text)["@graph"];
    expect(event.eventStatus).toBe("https://schema.org/EventCancelled");
    expect(event.startDate).toBe("2026-10-15");
    expect(event.endDate).toBeUndefined();
  });

  test("covers tonight and the next 13 nights, not shows already over", () => {
    const events = [
      show({
        id: "over",
        start: "2026-10-15T09:00:00-04:00",
        end: "2026-10-15T11:00:00-04:00",
      }),
      show({ id: "tonight" }),
      show({ id: "last", start: "2026-10-28T20:00:00-04:00", end: null }),
      show({ id: "later", start: "2026-10-29T20:00:00-04:00", end: null }),
    ];
    expect(upcoming(events, NOW).map((e) => e.id)).toEqual(["tonight", "last"]);
  });

  test("is served as it is, less its ETag, without events.json", async () => {
    const response = await servePage(request, env(null), NOW);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get("etag")).toBeNull();
  });
});
