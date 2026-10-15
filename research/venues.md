# Boston-area jazz venues — research pass

As of 2026-10-15. Compiled from web research plus a light, polite technical check of each venue's
calendar (1–3 requests per site). "Unverified" means we couldn't confirm it is current.

**Data source key** — the best way found to get each venue's events:

- **ICS** — public iCalendar feed
- **API** — public JSON endpoint (WordPress *The Events Calendar* / "Tribe", Localist, Spektrix, etc.)
- **JSON-LD** — schema.org `Event` markup embedded in the venue's pages
- **HTML** — scrape the calendar page itself
- **Ticketing** — via a ticketing vendor (Ticketmaster Discovery API, Eventbrite organizer, TicketWeb)
- **Regular** — no per-date listings exist. If the venue publishes the standing schedule, list it
  under weekly regulars (never as dated events); otherwise ask the venue
- **Manual** — annual festival or one-off; enter by hand
- **Blocked** — Cloudflare bot wall or robots.txt forbids it; needs permission or another source

**Squarespace note:** the stock Squarespace robots.txt disallows `?format=json` and `?format=ical`
for *all* bots (verified on lilypadinman.com). Their HTML pages are allowed. For Squarespace venues
we either parse the HTML or ask the venue for permission to use the JSON feed.

---

## Dedicated jazz rooms

| Venue | Where | Jazz | Calendar | Data source | Notes |
|---|---|---|---|---|---|
| Wally's Café | 427 Mass Ave, South End | Nightly | wallyscafe.com/one-night/ | Recurring | Jam Tue–Sat 7–9, night set 10–12. Lineups only on Instagram. Cloudflare blocks curl. |
| Scullers Jazz Club | 400 Soldiers Field Rd, Allston | Dedicated | scullersjazz.com/calendar/ | HTML (MusicIDB widget, venueId 715) | TicketWeb. robots allows all. |
| Regattabar | Charles Hotel, 1 Bennett St, Cambridge | Mostly jazz, some blues/soul | ticketweb.com/venue/regattabar-cambridge-ma/748814 | Blocked by terms: TicketWeb's Terms of Use forbid scraping; try the Ticketmaster API, ArtsBoston, or ask the venue | Its own site has no schedule. |
| The Lilypad | 1353 Cambridge St, Inman Sq, Cambridge | Mostly jazz/avant | lilypadinman.com/home | HTML (Squarespace) | 64 of 121 upcoming events tagged "Jazz". JSON feed works but is robots-disallowed → ask permission. Also sends a Mailchimp "Wednesday Weekly". |
| The Mad Monkfish (Jazz Baroness Room) | 524 Mass Ave, Central Sq, Cambridge | Wed–Sun + jams | themadmonkfish.com/jazz-schedule/ | JSON-LD (27 events) | Use themadmonkfish.com; madmonkfish.com is not their site. |
| POSTunderground | 386 Washington St (VFW basement), Brookline | Dedicated | postunderground.com | HTML (plain text schedule) | Fri/some Sat 7:30–11, alternating months. House band Hard Bop Cafe. Back Nov 6. |
| Jazz Urbane Café | 2300 Washington St, Nubian Sq, Roxbury | Dedicated (in intent) | jazzurbanecafe.com | JSON-LD (Wix Events) | Not fully open yet; events only. |
| Marblehead Arts "Jazz at the Arts" | 8 Hooper St, Marblehead | Monthly series | marbleheadarts.org | Ticketing (TicketTailor organizer page) | Main site Cloudflare-blocked. |

## Restaurants, bars and rooms with regular jazz

| Venue | Where | Jazz | Calendar | Data source | Notes |
|---|---|---|---|---|---|
| The Beehive | 541 Tremont St, South End | Some nights + weekend brunch jam | beehiveboston.com/musiccalendar | JSON-LD (Wix Events detail pages) | Same owner opening "King Bee" in South Boston. |
| Long Live Roxbury | 152 Hampden St, Roxbury | Thursday Jazz Night 6–9, free | longlivebeerworks.com/boston | HTML (static text, Squarespace) | Artists listed through Dec 17. |
| The Square Root — Jazz Sundays | 2 Corinth St, Roslindale | ~2 Sundays/mo, Sep–Jun | squarerootrozzie.com/events/ | ICS (Tockify `sqrozzietester`) + HTML (brianfriedland.com for artists) | Curated by Brian Friedland. |
| Midway Café | 3496 Washington St, Jamaica Plain | Wednesday jazz (Fully Celebrated Orchestra, Persistent Fools) | none (Instagram/Facebook) | Blocked; use Songkick venue 418641 or Kohlhase's list | robots blocks AI bots and the calendar path. |
| HobGoblin | 48 Temple Pl, Downtown Crossing | Thu–Sat jazz-leaning piano | hobgoblinbar.com/events/ | JSON-LD (BentoBox) | Yoko Miwa, Rebecca Cline, etc. |
| Grace by Nia | 60 Seaport Blvd #325, Seaport | Jazz/soul/R&B Fri–Sat + Sun brunch | gracebynia.com | Recurring | No performer listings. Squarespace. |
| Kestra Jazz Lounge (Omni Seaport) | 450 Summer St, Seaport | Thu–Sat 7–10 | omnihotels.com | Recurring; Blocked | Curated by Will Dailey. 2026 status unverified. |
| The Fed at The Langham | 250 Franklin St, Financial District | "Jazz Friday" 6–9 | langhamhotels.com | Recurring | |
| The Plough & Stars | 912 Mass Ave, Cambridge | Tuesdays: Johnny Trama & The B3 Kings; soul/blues/organ late sets | calendar.ploughandstars.com | HTML (static month grid) | Easy scrape; no robots.txt on calendar host. |
| Phoenix Landing | 512 Mass Ave, Cambridge | JazzBoston jam 1st & 3rd Fri 5–7 | jazzboston.org/jazzjams/ | Recurring | phoenixlandingbar.com is not the bar's site. |
| Sally O'Brien's | 335 Somerville Ave, Union Sq, Somerville | Dub Apocalypse Sundays; Boston Modern Big Band | sallyobriensbar.com/music/ | HTML (free text) | |
| The Burren (Backroom) | 247 Elm St, Davis Sq, Somerville | Gypsy jazz (The Django Cadre), jazz brunch shows | burren.com/music.html | HTML (static) | Tickets via 24 Hour Music, which also books McCarthy's & Toad. |
| The Wellington | 75 Leonard St, Belmont | Jazz brunch series; Saturday band sessions 7:30–9:30 (Morningside Music, mixed styles) | thewellingtonbelmont.com/live-music/ | Recurring (Saturdays); brunch dates on social media only | Friday nights are pop-rock covers. |
| The Bluebird Bar | 1293 Washington St, West Newton | Mondays 7–9; Sunday jazz brunch 11–2 | thebluebirdbar.com | Recurring | Website mentions Mondays; the Sunday brunch is reported by musicians but unconfirmed. |
| Tryst | 689 Mass Ave, Arlington | Thursdays 6–9 | trystrestaurant.com/late-night-jazz-arlington | HTML (Wix; JS-rendered) | |
| Morningside Music Studio / Annex | 108 Summer St, Arlington | Jams, "Jazz on the Edge" | morningsidemusic.org | Ticketing (Eventbrite organizer; ID not yet found) | Co-runs the Arlington Jazz Festival. |
| Beacon Restaurant | 123 Pleasant St, Marblehead | "Sinatra Sundays", jazz brunch | thebeaconmarblehead.com/entertainment | HTML | |
| QArts Gallery Jazz Series | 1229 Hancock St, Quincy | Alternate Sundays at 4 | no site found | Via ArtsBoston/JazzBoston | |
| Concord Conservatory of Music | 1317 Main St, Concord | Monthly jam + concerts | concordconservatory.org/news-events/calendar/ | HTML with embedded event JSON | |
| Mosesian Center for the Arts | 321 Arsenal St, Watertown | "Chords and Cocktails" series | mosesianarts.org | Blocked (robots + Cloudflare) | Get via ArtsBoston or ask. |
| Arts Wayland (First Parish) | 225 Boston Post Rd, Wayland | Berklee Faculty Jazz Series | artswayland.com/pages/calendar | API (Shopify `/products.json`) | |
| Backbeat Brewing | 31 Park St, Beverly | Big-band Mondays | backbeatbrewing.com | Recurring | Last confirmed 3/2025. |
| Bell Inn & Tavern | 2 Washington St, Peabody | Thursday jazz dinner | bellinnpeabody.com/events | HTML | Unverified for 2026. |

### From JazzBoston's venue sheet, not yet checked

These are on [JazzBoston's published venue list](https://docs.google.com/spreadsheets/d/e/2PACX-1vSSvTbh5dOwckedPNNjw4DRnbYKHTB6c2Pk32JLy5xVD2WfnChsfILBGdiP7ZM-4ayae9doMz1aCcNm/pub?gid=0&single=true&output=csv)
(31 rows, CSV) but no agent got to them:

- Lou's, 13 Brattle St, Cambridge
- Oggi Gourmet, 30 Dunster St, Cambridge
- Phinista Cafe, 1876 Mass Ave, Cambridge
- Zuzu (Middle East), 474 Mass Ave, Cambridge
- Boston Swing Central, 26 New St, Cambridge (swing dance)
- Parish Center for the Arts, 10 Lincoln St, Westford

## Occasional jazz / jazz-adjacent at mixed-genre venues

Needs per-event jazz filtering.

| Venue | Where | Calendar | Data source | Notes |
|---|---|---|---|---|
| City Winery | 80 Beverly St, West End | citywinery.com/pages/locations/boston | HTML; internal API unclear | Touring jazz (Kamasi Washington, Spyro Gyra, Boney James this fall). |
| Club Café (Napoleon Room) | 209 Columbus Ave | clubcafe.com/full-calendar/ | API (Event Espresso REST) | Cabaret / songbook. |
| Bar Moxy | 240 Tremont St | barmoxy.com/events | HTML (Wix) | "Moxy Jazz Nights", frequency unverified. |
| Sonia / The Middle East | 10 Brookline St / 472 Mass Ave, Cambridge | mideastclub.com/calendar/ | Ticketing (TicketWeb) | Cambridge NITES: NE Jazz Collaborative Monday big-band series from Sep 14. Needs full browser UA. |
| Arrow Street Arts | 2 Arrow St, Harvard Sq | arrowstarts.org/shows-events | HTML (Squarespace); Ticketmaster venue 9486 | NE Jazz Collaborative shows (Brazilian night). |
| Lizard Lounge | 1667 Mass Ave, Cambridge | lizardloungeclub.com | API (Tribe REST, 232 events) | Organ Fairchild, Dub Apocalypse. Drop "No Event Tonight" placeholders. |
| McCarthy's & Toad | 1912–1920 Mass Ave, Porter Sq | mccarthystoad.com/calendar | API (Elfsight widget JSON) | Toad reopened 2025. |
| Club Passim | 47 Palmer St, Harvard Sq | passim.org/live-music/ | HTML (embedded JS object with genre tags) | ~3 of 87 tagged Jazz/Latin. |
| The Sinclair | 52 Church St, Harvard Sq | sinclaircambridge.com/events | HTML (`--compressed`); AXS | |
| The Cantab Lounge | 738 Mass Ave, Central Sq | thecantablounge.com/lounge | HTML (TuneHatch embed) | cantab-lounge.com is not the Cantab's site. |
| Arts at the Armory | 191 Highland Ave, Somerville | artsatthearmory.org/events/ | ICS (`/events.ics`) | Plus West Coast Swing. |
| Somerville Theatre / Crystal Ballroom | 55 Davis Sq | somervilletheatre.com/events/ | HTML; Ticketmaster | John Scofield Nov 19 (Global Arts Live). |
| The Jungle | Union Sq, Somerville | thejunglemusicclub.com/events-calendar | Ticketing (Eventbrite) | 2026 jazz unverified. |
| Chevalier Theatre | 30 Forest St, Medford | chevaliertheatre.com/calendar/ | HTML; Ticketmaster | Rare. |
| Regent Theatre | 7 Medford St, Arlington | regenttheatre.com/events/ | RSS (`/events/feed/`) | Arlington Jazz Festival headliner. Needs full browser UA. |
| Arlington Center for the Arts | 20 Academy St, Arlington | acarts.org/events-calendar | HTML (Wix); Eventbrite | Jazz in 2025; nothing found for 2026. |
| St. John's Episcopal Creative Music Series | 74 Pleasant St, Arlington | via thebostoncalendar.com | Manual | Creative improvised music. 2026 unverified. |
| Café St. Petersburg | 57 Union St, Newton Centre | cafestpetersburg.com/events | Ticketing (Eventbrite organizer 115985507771) | |
| TCAN | 14 Summer St, Natick | tcan.org/events/ | HTML (genre CSS classes) | Crawl-delay 10; needs full browser UA. |
| The Cabot / Off Cabot | 286 Cabot St, Beverly | thecabot.org/whats-on/ | API (Spektrix, with genre fields) | Best feed on the North Shore. |
| Gulu-Gulu Cafe | 247 Essex St, Salem | gulugulucafe.com/events | HTML (Squarespace) | Jazz-funk, blues. |
| Shalin Liu Performance Center | 37 Main St, Rockport (~40 mi) | rockportmusic.org/genre/jazz-rb-soul/ | API (WP REST `upcoming_shows?genre=86`) + HTML for dates | Christian Sands, Take 6. |
| Groton Hill Music Center | Groton (~35 mi) | grotonhill.org/concerts/ | API (WP REST with Jazz taxonomy) + HTML for dates | Danilo Pérez, Club d'Elf. |
| Methuen Memorial Music Hall | Methuen (~28 mi) | mmmh.org | JSON-LD | Crawl-delay 20. |
| Spire Center | 25½ Court St, Plymouth | spirecenter.org/event-listings/ | HTML; Etix | |
| South Shore Conservatory | 1 Conservatory Dr, Hingham | sscmusic.org/events/ | JSON-LD (Modern Events Calendar) | |
| Norwood Theatre | Norwood | norwoodstage.com/shows-events | RSS (Squarespace) | |
| ICA Boston | 25 Harbor Shore Dr, Seaport | icaboston.org/calendar/?event_type[]=music | JSON-LD on event pages | A few music shows a year, now and then jazz; BSO co-productions. |
| Larz Anderson Auto Museum | 15 Newton St, Brookline | larzanderson.org/eventschedule | JSON-LD (Wix Events) | Winter swing dances. |
| Eustis Estate (Historic New England) | 1424 Canton Ave, Milton | my.historicnewengland.org | HTML (Tessitura) | Concert series; August jazz festival. |
| House of Blues / Roadrunner / Leader Bank Pavilion / Boch Center | Boston | various | JSON-LD (HoB, Pavilion, Boch); API (Roadrunner AEG JSON) | Rare jazz-adjacent; keyword filter. |

## Presenters

Presenters book jazz into several halls.

| Presenter | Calendar | Data source | Notes |
|---|---|---|---|
| Vivo Performing Arts (formerly Celebrity Series) | vivoperformingarts.org/…/performance-event-calendar/?genre=jazz | HTML (`?genre=jazz`) + JSON-LD | Biggest jazz presenter in town: Christian McBride, Coltrane 100, Michel Camilo, Emmet Cohen. Free Roxbury series. |
| Global Arts Live | globalartslive.org | JSON-LD (MusicEvent; venue name blank) | Books BPC, Cutler Majestic, Somerville Theatre, Sanders. |
| Makanda Project | makandaproject.com/upcoming-performances/ | HTML | Free big-band concerts in Roxbury/Dorchester churches & BPL. |
| Boston Jazz Foundation / Jazz Square | bostonjazzfoundation.org | Ticketing (Eventbrite organizer 64421726363) | Union Church, 485 Columbus Ave. |
| New England Jazz Collaborative | Instagram @nejazzcollab | via venues | Cambridge NITES, Arrow Street. |
| Mandorla Music | (Humanitix pages) | JSON-LD | Creative/improvised, at SMFA. |
| GBH Jazz Night | wgbh.org/events | JSON-LD (no location) | Monthly, 2nd Thu Sep–May, free. |

## Schools

| School | Calendar | Data source | Notes |
|---|---|---|---|
| New England Conservatory | necmusic.edu/concerts | **ICS** (`trumba.com/calendars/nec.ics`, 200 events) | Filter on Jazz / CMA text. Site itself is Cloudflare-blocked. |
| Berklee (BPC, Red Room @ Café 939, David Friend Recital Hall, etc.) | berklee.edu/events | JSON-LD + per-event ICS | Crawl-delay 10; `?page=` disallowed. Huge volume of student recitals — filter by venue/series. |
| Longy School of Music | longy.edu/events/ | API (Tribe REST) + ICS (`/calendar/?ical=1`) | Jazz & Contemporary dept. |
| Tufts Granoff | as.tufts.edu/music/… | **ICS** (`trumba.com/calendars/tts-wms-managed-music.ics`) | |
| MIT | calendar.mit.edu | API (Localist `/api/2/events?keyword=jazz`) | |
| Northeastern | calendar.northeastern.edu | API (Localist) | Few jazz events. |
| Boston University | bu.edu/cfa/news/calendar/ | HTML (list page only) | Event detail URLs disallowed; crawl-delay 15. |
| Harvard (Jazz Bands, Sanders) | news.harvard.edu/gazette/harvard-events/events-calendar/ | **ICS** (`trumba.com/calendars/gazette.ics`, `?search=` filters) | Arts and box office sites blocked (Akamai); the Gazette calendar lists Sanders shows. |
| Wellesley BlueJazz | wellesley.edu/events | HTML | |
| Boston Public Library | bpl.bibliocommons.com/events | API (BiblioCommons search `q=jazz`) | Filter kids' music. |
| Newton Free Library | newtonfreelibrary.libcal.com | ICS (LibCal) | |

## Festivals and annual events

Enter these by hand.

| Event | When | Where |
|---|---|---|
| Arlington Jazz Festival | April (2026: Apr 8–12) | Multi-venue, Arlington — arlingtonjazz.org |
| Roslindale Jazz Festival | May | Roslindale Village |
| Melrose Jazz Fest | May | Melrose |
| Somerville PorchFest | May | Citywide (some jazz/brass) |
| BAMS Fest | June | Franklin Park |
| Cambridge Jazz Festival | Late July (2026: Jul 25–26) | Danehy Park |
| NEMPAC Jazz in the Park | Thursdays, Jul–Aug | Greenway / North End |
| Salem Jazz & Soul Festival | August | Salem Willows |
| David Chesnut Jazz Festival | August | Eustis Estate, Milton |
| Boston Jazz Fest | Late August (2026: Aug 28–29) | Maritime Park, Seaport |
| Let's Dance Boston | Late September | Dewey Square (salsa / Afro-Caribbean bands) |
| Tito Puente Latin Music Series | Summer | Villa Victoria, South End |

## Closed, dormant or unverified

Keep these out of the scraper.

- **Ryles Jazz Club** (Inman) — closed June 2018
- **Les Zygomates** — closed July 2020
- **Top of the Hub** — closed April 2020
- **Wonder Bar** (Allston) — closed
- **Thunder Road** (Somerville) — closed
- **Johnny D's** (Davis Sq) — closed 2015
- **Moldova Restaurant** (Newton, home of the Newton Jazz Jam) — closed Dec 2024
- **Atwood's Tavern** — no music listed in 2026; status unverified
- **Bella Luna / Milky Way** (JP) — no jazz found since 2018; status unverified
- **Darryl's Corner Bar & Kitchen** — website unreachable in Oct 2026; status unverified
- **Global Jazz Club** (Arlington St Church) — nothing since Fall 2024
- **Boston Jazz Week** — last held 2019
- **Berklee Beantown Jazz Festival** — reportedly discontinued; unverified
- **Amazing Things Arts Center** (Framingham) — jazz jam ended
- **Domains that aren't the venue's** — cantab-lounge.com, madmonkfish.com, phoenixlandingbar.com

## Gaps in this pass

The session's web-search budget ran out before these were covered:

- **Cambridge/Somerville:** Grendel's Den and Aeronaut (Cloudflare-blocked), Bow Market, Remnant, Harvard series, Havana Club salsa, swing nights
- **Malden, Everett, Chelsea**
- **Northwest:** Lexington (Cary Hall, Scottish Rite Museum, Follen Church), Waltham (Brandeis, Moody St), Winchester, Woburn, Bedford, Lincoln/deCordova, Wakefield, Stoneham
- **South:** Weston, Sudbury, Braintree, Weymouth, Brookline Booksmith, Thomas Crane Library
- **North Shore:** Salem State, Peabody Essex Museum, Gloucester's Rhumb Line and Minglewood
- **Dorchester restaurants** last seen with jazz in 2017 (home.stead, Ester, Cesaria, Tavolo)
