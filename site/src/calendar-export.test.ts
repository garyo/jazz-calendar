import { describe, expect, test } from "bun:test";
import {
  buildCalendar,
  escapeText,
  foldLine,
  googleEventUrl,
  utcStamp,
} from "./calendar-export";
import type { CalendarEvent, SourceCredit, Venue } from "./types";

// Output must not depend on the host's zone.
process.env.TZ = "Asia/Tokyo";

const HOUR = 60 * 60 * 1000;
const lilypad: Venue = {
  id: "lilypad",
  name: "The Lilypad",
  address: "1353 Cambridge St",
  town: "Cambridge",
  jazz_level: "dedicated",
};
const venues = new Map([[lilypad.id, lilypad]]);
const show: CalendarEvent = {
  id: "abc123",
  title: "Trio; standards, ballads",
  start: "2026-10-15T20:00:00-04:00",
  end: "2026-10-15T22:00:00-04:00",
  venue: "lilypad",
  url: "https://example.com/show?a=1,2",
  ticket_url: "https://tickets.example.com/x",
  price: "$15-25",
  relevance: "jazz",
  sources: ["test"],
};
const ticketmaster: SourceCredit = {
  id: "tm",
  name: "Ticketmaster",
  url: "https://www.ticketmaster.com",
  via: true,
};
const stamp = new Date("2026-10-15T10:00:00Z");
const options = { name: "x", stamp };

/** Checks line endings, then returns the unfolded content lines. */
function unfold(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replaceAll("\r\n", "")).not.toContain("\n");
  return ics.replace(/\r\n /g, "").split("\r\n").slice(0, -1);
}

/** Each VEVENT's lines, without BEGIN and END. */
function vevents(ics: string): string[][] {
  const events: string[][] = [];
  let current: string[] | null = null;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      events.push(current);
    } else if (line === "END:VEVENT") {
      current = null;
    } else {
      current?.push(line);
    }
  }
  return events;
}

const only = (events: CalendarEvent[]) =>
  vevents(buildCalendar(events, venues, options));

describe("escapeText", () => {
  test("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  test("drops other control characters", () => {
    expect(escapeText("tab\there\u0007")).toBe("tabhere");
  });
});

describe("foldLine", () => {
  test("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  test("folds at 75 octets, continuation lines starting with a space", () => {
    const line = `DESCRIPTION:${"x".repeat(200)}`;
    const folded = foldLine(line);
    const pieces = folded.split("\r\n");
    expect(pieces[0]).toHaveLength(75);
    for (const piece of pieces.slice(1)) {
      expect(piece.startsWith(" ")).toBe(true);
      expect(piece.length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });

  test("never splits a multi-byte character", () => {
    const line = `SUMMARY:${"é".repeat(40)}🎷${"ü".repeat(40)}`;
    const folded = foldLine(line);
    const encoder = new TextEncoder();
    for (const piece of folded.split("\r\n")) {
      expect(encoder.encode(piece).length).toBeLessThanOrEqual(75);
      // A split surrogate pair would not survive the round trip.
      expect(new TextDecoder().decode(encoder.encode(piece))).toBe(piece);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });
});

describe("buildCalendar", () => {
  test("calendar properties", () => {
    const ics = buildCalendar([], venues, {
      name: "Boston Jazz Calendar: The Lilypad, Wally's Café",
      stamp,
      refreshHours: 12,
    });
    const lines = unfold(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain(
      "X-WR-CALNAME:Boston Jazz Calendar: The Lilypad\\, Wally's Café",
    );
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H");
    expect(lines).toContain("X-PUBLISHED-TTL:PT12H");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  test("a timed event, in UTC, with escaped text", () => {
    expect(only([show])).toEqual([
      [
        "UID:abc123@bostonjazzcalendar.com",
        "DTSTAMP:20261015T100000Z",
        "DTSTART:20261016T000000Z",
        "DTEND:20261016T020000Z",
        String.raw`SUMMARY:Trio\; standards\, ballads @ The Lilypad`,
        String.raw`LOCATION:The Lilypad\, 1353 Cambridge St\, Cambridge`,
        "URL:https://example.com/show?a=1,2",
        String.raw`DESCRIPTION:$15-25\nDetails: https://example.com/show?a=1\,2\nTickets: https://tickets.example.com/x`,
      ],
    ]);
  });

  test("credits a third party in the description, keeping the UID", () => {
    const own: SourceCredit = {
      id: "own",
      name: "Own",
      url: "https://own.example",
    };
    const credits = new Map([
      [own.id, own],
      [ticketmaster.id, ticketmaster],
    ]);
    const [lines] = vevents(
      buildCalendar([{ ...show, sources: ["own", "tm"] }], venues, {
        ...options,
        credits,
      }),
    );
    expect(lines).toContain("UID:abc123@bostonjazzcalendar.com");
    expect(lines?.find((line) => line.startsWith("DESCRIPTION:"))).toEndWith(
      String.raw`\nTickets: https://tickets.example.com/x\nListing via Ticketmaster: https://www.ticketmaster.com`,
    );
    const ownOnly = vevents(
      buildCalendar([{ ...show, sources: ["own"] }], venues, {
        ...options,
        credits,
      }),
    );
    expect(ownOnly.flat().join("\n")).not.toContain("via");
  });

  test("UTC conversion across the end and start of DST", () => {
    const dtstart = (start: string) =>
      only([{ ...show, start, end: null }])[0].find((line) =>
        line.startsWith("DTSTART"),
      );
    expect(dtstart("2026-11-01T01:30:00-04:00")).toBe(
      "DTSTART:20261101T053000Z",
    );
    expect(dtstart("2026-11-01T01:30:00-05:00")).toBe(
      "DTSTART:20261101T063000Z",
    );
    expect(dtstart("2026-11-02T20:00:00-05:00")).toBe(
      "DTSTART:20261103T010000Z",
    );
    expect(dtstart("2027-03-14T03:30:00-04:00")).toBe(
      "DTSTART:20270314T073000Z",
    );
  });

  test("no usable end means no DTEND", () => {
    for (const end of [null, show.start]) {
      const [event] = only([{ ...show, end }]);
      expect(event.some((line) => line.startsWith("DTEND"))).toBe(false);
    }
  });

  test("all-day events use Boston-local dates", () => {
    const allDay = {
      ...show,
      all_day: true,
      start: "2026-11-22T00:00:00-05:00",
      end: null,
    };
    const [one] = only([allDay]);
    expect(one).toContain("DTSTART;VALUE=DATE:20261122");
    expect(one).toContain("DTEND;VALUE=DATE:20261123");
    const [two] = only([{ ...allDay, end: "2026-11-23T23:59:00-05:00" }]);
    expect(two).toContain("DTEND;VALUE=DATE:20261124");
  });

  test("cancelled events", () => {
    expect(only([{ ...show, cancelled: true }])[0]).toContain(
      "STATUS:CANCELLED",
    );
    expect(only([show])[0]).not.toContain("STATUS:CANCELLED");
  });

  test("an unknown venue or a malformed date doesn't break the feed", () => {
    const events = only([
      { ...show, venue: "gone", price: null, ticket_url: null },
      { ...show, id: "bad", start: "soon" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(String.raw`SUMMARY:Trio\; standards\, ballads`);
    expect(events[0].some((line) => line.startsWith("LOCATION"))).toBe(false);
    expect(events[0]).toContain(
      String.raw`DESCRIPTION:Details: https://example.com/show?a=1\,2`,
    );
  });
});

describe("googleEventUrl", () => {
  const params = (url: string) => new URL(url).searchParams;

  test("a timed event", () => {
    const url = googleEventUrl(show, lilypad, 3 * HOUR);
    expect(url).toStartWith("https://calendar.google.com/calendar/render?");
    const p = params(url);
    expect(p.get("action")).toBe("TEMPLATE");
    expect(p.get("text")).toBe("Trio; standards, ballads @ The Lilypad");
    expect(p.get("dates")).toBe("20261016T000000Z/20261016T020000Z");
    expect(p.get("location")).toBe("The Lilypad, 1353 Cambridge St, Cambridge");
    expect(p.get("details")).toContain(
      "Tickets: https://tickets.example.com/x",
    );
    expect(p.get("ctz")).toBe("America/New_York");
  });

  test("credits a third party in the details", () => {
    const p = params(googleEventUrl(show, lilypad, HOUR, [ticketmaster]));
    expect(p.get("details")).toEndWith(
      "Listing via Ticketmaster: https://www.ticketmaster.com",
    );
  });

  test("no end: the assumed duration", () => {
    const p = params(googleEventUrl({ ...show, end: null }, lilypad, 3 * HOUR));
    expect(p.get("dates")).toBe("20261016T000000Z/20261016T030000Z");
  });

  test("all day", () => {
    const allDay = {
      ...show,
      all_day: true,
      start: "2026-11-22T00:00:00-05:00",
      end: null,
    };
    expect(params(googleEventUrl(allDay, lilypad, HOUR)).get("dates")).toBe(
      "20261122/20261123",
    );
  });
});

test("utcStamp drops milliseconds", () => {
  expect(utcStamp(new Date("2026-10-15T20:00:05.123-04:00"))).toBe(
    "20261016T000005Z",
  );
});
