# Aggregation strategy — research pass

As of 2026-10-15. Companion to [venues.md](venues.md). Not legal advice; a sourced summary of the
landscape and a conservative posture.

## Summary

1. **There is no single feed.** Boston jazz is spread over ~120 venues on a dozen platforms.
   Roughly a third have a clean machine-readable feed. A third need HTML parsing. The rest are
   recurring residencies with no per-date listings, or are bot-walled.
2. **ArtsBoston is the biggest single lever.** Its Bostix calendar publishes a public ICS feed of
   everything it lists. We verified `https://bostix.org/wp-json/apollo/v1/calendar/subscribe/all`:
   4,161 occurrences, 98 events mentioning jazz. **JazzBoston's calendar is built from this same
   data**: JazzBoston approves the Jazz/Blues-tagged ArtsBoston submissions. A separate partner
   syndication API exists (`/api/v1/syndication/`, robots-disallowed). → Ask ArtsBoston and
   JazzBoston for permission or partnership before relying on it.
3. **Build per-platform adapters, not per-venue scrapers.** About 10 platform adapters (ICS, Tribe
   REST, JSON-LD, Squarespace HTML, Wix Events, Localist, Spektrix, Eventbrite, Ticketmaster,
   generic LLM) cover nearly every venue. Each venue becomes a config line.
4. **Fill the long tail with people.** Use recurring-schedule entries for residencies like Wally's
   and the hotel lounges. Add a submission form for musicians and venues. Add an inbox that receives
   venue and musician newsletters (with permission), parsed by an LLM.

## Secondary and aggregator sources

| Source | Use | Feed | Notes |
|---|---|---|---|
| ArtsBoston / Bostix | **Primary cross-venue input** (with permission) | ICS (verified); per-org ICS `/apollo/v1/calendar/subscribe/organization/{id}` | ICS has no CATEGORIES and floating times (assume America/New_York). Filter jazz by text and venue. |
| JazzBoston jazz calendar | Cross-check | HTML only | Same data as Bostix. |
| JazzBoston venue sheet | Seed venue list | Published Google Sheet (CSV) | 31 venues. |
| JazzBoston jam list | Recurring jams | HTML | jazzboston.org/jazzjams/ |
| Charlie Kohlhase's Weekly Jazz Calendar Highlights | Discovery only | HTML (one line per show) | Hand-curated selection, so it may carry thin compilation copyright. Don't mirror it; verify at source. Good partnership candidate. |
| Songkick venue pages | Discovery (Midway, Regattabar) | MusicEvent JSON-LD | Songkick's API is closed to hobbyists. |
| Cambridge Day, City of Cambridge calendar, Arts Fuse RSS | Discovery | RSS / HTML | Editorial; don't copy. |
| northofboston.org | North Shore | Tribe REST + `?ical=1` | 17 jazz hits. |
| thebostoncalendar.com, do617, jazznearyou.com, Bay State Banner | — | Cloudflare-blocked | Don't bypass; ask or skip. |
| DigBoston, Boston Jazz Society | — | — | Defunct. |

## Ticketing and event APIs

| Platform | Usable? | Terms worth knowing |
|---|---|---|
| **Ticketmaster Discovery** | Yes — free key | 5,000 calls/day. No deriving revenue from the API. Remove content within 24 h on request. Covers TicketWeb venues (Regattabar, Middle East, Scullers?) — verify. |
| **Eventbrite** | Yes, per organizer/venue ID | Public search was removed Dec 2019. `GET /v3/organizations/{id}/events/` still works. Good for small series. |
| **JamBase Data API** | Yes — free non-commercial tier | 1,000 calls/month; attribution required. Good for touring acts. |
| SeatGeek | Maybe | Little club inventory. |
| Bandsintown, Songkick | No | Artist-only / no hobbyists. |
| DICE, AXS, Tixr, Etix, See Tickets | No public API | Use venue pages. |
| Facebook events | No | Graph API event search removed 2018. |

## Machine-readable formats, in order of preference

1. **ICS** — Google Calendar public ICS, Trumba (NEC, Tufts), Tockify, LibCal, Events Manager,
   Tribe `?ical=1`. Parse with `icalendar` + `recurring-ical-events`.
2. **Platform JSON APIs** — Tribe `/wp-json/tribe/events/v1/events`, Localist `/api/2/events`,
   Spektrix, BiblioCommons, Event Espresso, Elfsight, Shopify `/products.json`, AEG venue JSON.
3. **schema.org Event JSON-LD** — common on BentoBox, Wix Events, Live Nation, Drupal and ticketing
   pages. Parse with `extruct` or by hand.
4. **Squarespace** — `?format=json` exists but is robots-disallowed by default; parse HTML or get
   permission.
5. **Arbitrary HTML** — CSS selectors where stable; otherwise the LLM adapter.

**LLM extraction**

How it works:
- Cut the page down to the event region, convert to markdown, and extract with a strict JSON schema.
- Require a verbatim `evidence` snippet per event and check it actually appears in the source.
  This catches invented events.
- Cache results by content hash, so the LLM only runs when a page changes.

Cost: at ~10K tokens in and 2K out per page, Haiku-class models cost about $0.002 per page. That is
pennies per day at our scale.

## Legal and ethical landscape (US / First Circuit)

- **Facts are free; prose and photos aren't.**
  - Event title, date, time, venue, artists and price are uncopyrightable facts
    (*Feist v. Rural*, 499 U.S. 340 (1991)).
  - Venue descriptions and photos are copyrighted (*AP v. Meltwater*, S.D.N.Y. 2013).
  - Publish facts plus a link; never copy blurbs or images. Use only images that are submitted to us.
  - Wholesale copying of a *curated selection* (e.g. Kohlhase's picks) carries thin compilation
    copyright.
- **CFAA is not a real risk for public pages.**
  - *Van Buren v. US* (2021) adopted a "gates-up-or-down" test.
  - *hiQ v. LinkedIn* (9th Cir. 2022) held that public pages have no gates.
  - But hiQ still lost on contract claims and settled for $500k.
  - First Circuit precedent (*EF Cultural Travel v. Explorica / Zefer*, 2001–03) suggests a site can
    restrict scraping by saying so explicitly. → Honor explicit no-scraping terms and any
    cease-and-desist.
- **Terms of service.**
  - *Meta v. Bright Data* (N.D. Cal. 2024) found logged-out scraping wasn't "use" under Meta's terms.
  - Browsewrap terms are weakly enforceable in Massachusetts (*Cullinane v. Uber*, 1st Cir. 2018;
    *Kauders v. Uber*, Mass. 2021).
  - But a cease-and-desist creates actual notice, so stop when asked.
- **Trespass to chattels** requires real harm (*Intel v. Hamidi*). A few polite requests a day
  carries negligible risk.
- **robots.txt** (RFC 9309) is a norm, not access control. Courts and people read honoring it as
  good faith. **Honor it.**
- **No circumvention.** Don't defeat Cloudflare challenges or similar (DMCA §1201 risk, and plainly
  bad faith).
- **Trademark.** Plain-text venue names are nominative use. No logos, no implied endorsement; add an
  "independent, not affiliated" note.

### Recommended posture

1. Identify the bot: `User-Agent: BostonJazzCalendarBot/1.0 (+https://bostonjazzcalendar.com/bot)`
   with a contact address.
2. Fetch each source at most daily. Use conditional GET (ETag / If-Modified-Since), 2–5 s between
   requests to a host, back off on 429/5xx, and cache robots.txt for 24 h at most.
3. Honor robots.txt and explicit terms. Never bypass bot walls or log in.
4. On every event, publish facts plus a prominent link to the venue and ticket page. Don't copy
   descriptions or images.
5. **Email every venue before launch:** a heads-up, an offer of free promotion, a request for
   permission to use their feed, and an easy opt-out. Remove within 24 h on request.
6. Publish our own ICS and JSON-LD under an open license so the data flows back to the community.
7. Revisit the Ticketmaster, JamBase and Patch terms if the site ever carries ads or makes money.

## Newsletters

Many small venues and musicians announce gigs only by email: the Lilypad, Regattabar, and 24 Hour
Music for The Burren and Toad.

**Don't poll the public archives.** Mailchimp's campaign-archive and mailchi.mp domains disallow all
crawlers in robots.txt.

**Subscribe a dedicated inbox instead, with each sender's permission.** For example,
`listings@bostonjazzcalendar.com`, set up with Cloudflare Email Routing → Fastmail or Gmail and read
over IMAP by the daily job. Rules:

- Never fetch tracking pixels or follow links.
- Treat email text as untrusted (prompt injection); the LLM gets no tools and returns only
  schema-validated fields.
- Send newsletter-derived events to a review queue until a sender proves reliable.

## Architecture sketch

- **Scraper in Python (uv)** — the strongest libraries for this job are Python: `icalendar`,
  `recurring-ical-events`, `extruct`, `dateparser`, `rapidfuzz`, `selectolax`, `httpx`, `pydantic`.
  **Site in TypeScript (bun)**, statically generated from the exported JSON.
- **Config-driven sources.** `venues.yaml` holds name, address, coordinates, default genre and
  links. `sources.yaml` maps each source to an adapter, URL, venue and robots status.
- **Adapters are small and pure:** `fetch()` does a polite, cached conditional GET;
  `parse(raw) → list[Event]` is tested against saved fixtures.
- **Normalized event** — fields named after schema.org Event:
  - id
  - source refs
  - title, artists
  - start/end with tz offset
  - venue_id
  - price
  - ticket_url, source_url
  - genre tags
  - jazz_relevance + confidence + method
  - status: scheduled / cancelled / removed
  - first_seen / last_seen
- **Dedup.** Group by (venue, local date). Match when start times are within 60 min and the
  headliner fuzzy-match score is ≥ 85. Source priority: venue site > ticketing API > ArtsBoston >
  newsletter.
- **Change detection.** An event missing from its source on two consecutive runs → `removed`. Never
  hard-delete.
- **Jazz filter at mixed venues, in tiers:**
  1. Venue default
  2. Keyword allow/deny lists
  3. Allowlist of known local jazz artists
  4. LLM classifier for the remainder
  5. Manual `overrides.yaml`

  Low-confidence events go to a review page.
- **Scheduling.** Daily GitHub Actions cron that commits JSON snapshots, which gives free history
  and diffs. Move to a $5 VPS if Azure IP ranges get blocked.
- **Monitoring.**
  - Per-source health: last success, event count, change since last run.
  - Open an issue when a source returns 0 events or drops by more than 50%.
  - Dead-man's switch ping (healthchecks.io).
  - Public `/status` page.

### Prior art worth reading

- [davidgrogan/localarts](https://github.com/davidgrogan/localarts) (Northampton MA) — per-venue
  strategies with a preview step; closest to this project.
- [76tech/venue-playlists](https://github.com/76tech/venue-playlists) (Pittsburgh) — Ticketmaster
  plus scraping plus LLM extraction, daily GitHub Action.
- [sethch/chicago-concerts](https://github.com/sethch/chicago-concerts) — Actions cron → GitHub Pages.

### Suggested build order

1. Venue registry (`venues.yaml`), seeded from venues.md and the JazzBoston sheet.
2. Ask ArtsBoston and JazzBoston about the Bostix feed. Meanwhile, build the ICS adapter against
   NEC, Tufts, Square Root and Arts at the Armory.
3. Tribe, JSON-LD and Localist adapters: Lizard Lounge, Longy, Mad Monkfish, HobGoblin, Beehive,
   MIT, Berklee.
4. HTML adapters for the dedicated rooms: Lilypad, Scullers, Plough & Stars, POSTunderground.
5. Ticketmaster and Eventbrite adapters as a cross-check; recurring residencies.
6. Jazz-relevance filter and review page.
7. Newsletter inbox and submission form.
