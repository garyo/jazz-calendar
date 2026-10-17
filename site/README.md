# bostonjazzcalendar.com: site

The public website: one Cloudflare Worker with static assets. The front end is
vanilla TypeScript bundled with `bun build`, plus plain CSS. The listings
come from the Python scraper in `../scraper`, which uploads its output
through the publish API below. The worker stores it in R2.

```
public/          static files copied into dist/ (index.html, styles.css, _headers, …)
public/admin.html  the submissions review page (unlinked, noindex), with admin.css
scripts/build.ts the build: bundles, copies public/, hashes asset names (below)
migrations/      D1 schema for submissions and added venues
src/main.ts      front-end entry: keeps the view state in step with the URL,
                 loads the feed, re-renders on every change
src/feed.ts      fetches /data/events.json and indexes it for the page
src/controls.ts  the filters: search (debounced), pickers and chips, presets
src/view.ts      the list and month views for a view state
src/render.ts    DOM construction (text only, never innerHTML): shows, days,
                 regulars, sources; src/month-grid.ts: the month grid
src/calendar-menu.ts  each show's "Add to calendar" menu, built on first open
src/subscribe.ts the "Subscribe to this view" panel
src/dom.ts       DOM helpers: h, byId, srOnly, safeUrl
src/picker.ts    multi-select (venues, towns); src/disclosure.ts: popover toggling
src/listings.ts  pure logic: upcoming, filtering, grouping by night (a set
                 before 4 am belongs to the evening before; see time.ts)
src/month.ts     pure logic: the month view's Sunday-first grid
src/selection.ts venue/town/jazz-adjacent selection: matching, parsing, feed names
                 (shared by the front end and the Worker)
src/calendar-export.ts  iCalendar generation and Google Calendar links (shared)
src/credits.ts   source credits: "via" lines and the list of sources (shared)
src/time.ts      America/New_York date and time formatting
src/url-state.ts view state <-> query string
src/types.ts     TS mirror of ../schema/events.schema.json
src/worker.ts    the Worker: R2-backed data routes, the publish API
src/worker-calendar.ts     the Worker's /calendar.ics feeds (cached, gzipped, ETags)
src/worker-submissions.ts  the Worker's gig submission and review API (D1)
src/worker-freshness.ts    the hourly cron: alerts when events.json goes stale
src/worker-http.ts         response and bearer-token helpers for the Worker
src/worker-notify.ts       ntfy notices to the owner (submissions, stale data)
src/submission.ts  submission records, limits and validation (shared)
src/submit.ts    the "Submit a gig" dialog; src/admin.ts: the review page
src/theme.ts     the review-period theme switcher and each theme's fonts
```

## Themes

`public/styles.css` holds the shared structure, drawn entirely from custom
properties. Each `public/theme-*.css` (`guide`, `program`, `lateset`, `club`)
defines its colors and fonts, light and dark, plus its own layouts, all scoped
to `:root[data-theme="…"]`. Program's layout is shared by four variants
(`liner`, `hardbop`, `evening`, `broadsheet`): `theme-program.css` scopes it
to the whole family, and each variant's file, loaded after it, adds only
colors, fonts and a few flourishes. A new variant goes in that selector list.

A small inline script in `index.html` sets `data-theme` before first paint
from `?theme=…`, then the choice saved in `localStorage`, then the default
(`liner`). It also adds a Google Fonts stylesheet for only that theme's
families, so a visitor downloads one theme's fonts, not all eight. The
footer switcher changes the theme in place and loads a newly picked theme's
fonts then. `THEME_FONTS` in `src/theme.ts` lists each theme's families
with only the weights and styles its CSS uses (no `opsz` axis); the inline
script carries a copy of that table. `_headers` allows the script by its
sha256. After changing the script, update both; `theme.test.ts` checks the
copy, the hash, and that each theme's fonts match the families its
stylesheet names.

To settle on one theme: delete the other theme files and their `<link>`s,
the switcher (`#theme-switcher` and `themeSwitcher()` in `main.ts`), and
the script's table, leaving a plain `<link>` to the remaining theme's fonts
(and dropping the script's hash from `_headers` if the script goes too).
Fold the remaining theme into `styles.css` if wanted.

Page URLs carry the view: `q`, `venue=lilypad,wallys`, `town=Cambridge,Somerville`
(a single old-style `town=` still works), `adjacent=0`, `when`, `view=month`,
`month=2026-11` and `day=2026-11-12`. A listing matches the selection when it
is at any selected venue or in any selected town; with neither selected,
everything matches. Regulars follow the same rule; a view of some days (`when`
or `day`) also shows only those that usually run on one of them (their `days`
and `nth`), still in their own section and never in the month grid or feeds.

## Development

```sh
bun install
bun run seed:local   # put ../schema/sample-events.json into local R2 as events.json
bun run dev          # build, then wrangler dev on http://localhost:8787
```

`wrangler dev` reloads static files when `dist/` changes. After editing
front-end code, run `bun run build` in another terminal. Local R2 data lives
in `.wrangler/state` and persists between runs.

`bun run build` (`scripts/build.ts`) copies `public/` into `dist/`, bundles
`src/main.ts` and `src/admin.ts`, and moves every script and stylesheet to
`dist/assets/` under a content-hashed name (`main-8b92fb4m.js`,
`styles-cce4c0b8c2.css`), rewriting the references in `index.html` and
`admin.html`. `_headers` serves `/assets/*` with
`Cache-Control: public, max-age=31536000, immutable`; the pages and
everything else keep Cloudflare's default, `max-age=0, must-revalidate`, so
a deploy reaches visitors on their next load. Source files keep their plain
names: in `public/`, refer to `/styles.css` or `/main.js` as usual.

To try the publish and submission APIs locally, create `.dev.vars`
(gitignored). The Turnstile secret below is Cloudflare's always-passing test
key; on localhost the form uses the matching test site key.

```
PUBLISH_TOKEN=local-dev-token
ADMIN_TOKEN=local-admin-token
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

and create the local submissions table once:
`bunx wrangler d1 migrations apply bostonjazzcalendar --local`.

Other scripts:

| Script | What it does |
|---|---|
| `bun run build` | Build `dist/`: bundle, copy `public/`, hash asset names (above) |
| `bun run typecheck` | `tsc` for the front end and the worker (separate configs) |
| `bun run lint` / `lint:fix` | Biome |
| `bun run test` | `bun test`: time, filtering, URL-state, rendering and controls (happy-dom), build and worker tests |
| `bun run check` | typecheck + lint + test |
| `bun run deploy` | Build, then `wrangler deploy` (by hand; see Deploys) |

## Deploys

Cloudflare Workers Builds deploys the Worker from GitHub: every push to
`main` builds the site and deploys it, with no step on the owner's Mac.
`bun run deploy` does the same by hand from a checkout. In the Worker's
build settings the root directory should be `site` and the build command
`bun run build`, so `dist/` has the hashed asset names that `_headers`
expects.

## One-time Cloudflare setup (owner)

`account_id` comes from the `CLOUDFLARE_ACCOUNT_ID` environment variable, not
`wrangler.toml`.

1. Create the bucket:
   `bunx wrangler r2 bucket create bostonjazzcalendar-data`
2. Set the publish token (generate a long random one, e.g.
   `openssl rand -base64 32`):
   `bunx wrangler secret put PUBLISH_TOKEN`
   Give the same token to the scraper's upload step.
3. Set up gig submissions (see [Gig submissions](#gig-submissions)):
   1. The D1 database exists and its `database_id` is in `wrangler.toml`.
      For a fresh account, `bunx wrangler d1 create bostonjazzcalendar`
      and put the printed id there instead.
   2. `bunx wrangler d1 migrations apply bostonjazzcalendar --remote`. Run
      it again whenever `migrations/` gains a file.
   3. In the dashboard, Turnstile → Add widget, Managed mode, with the
      hostnames `bostonjazzcalendar.com`, `www.bostonjazzcalendar.com` and
      `jazz-calendar.garyo.workers.dev`. Put its site key in `SITE_KEY` in
      `src/submit.ts` (it's public), and its secret key in the Worker:
      `bunx wrangler secret put TURNSTILE_SECRET`.
   4. `bunx wrangler secret put ADMIN_TOKEN` with another long random token
      (`openssl rand -base64 32`). Paste it into `/admin` when it asks; the
      tab keeps it (in `sessionStorage`) until you close it or sign out.
4. Set up notices to the owner (new submissions, stale data). `NTFY_URL`
   and `NTFY_TOPIC` are plain `[vars]` in `wrangler.toml`; the credentials
   are a secret: `bunx wrangler secret put NTFY_TOKEN`, the base64 of
   `user:password`. Without them no notice is sent. For `wrangler dev`, put
   `NTFY_TOKEN` in `.dev.vars` to test them.
5. Deploy: push to `main` (see [Deploys](#deploys)) or `bun run deploy`.
6. Add the custom domain: in the dashboard, Workers & Pages →
   `jazz-calendar` → Settings → Domains & Routes → Add →
   Custom domain → `bostonjazzcalendar.com` (and `www.` if wanted). The zone
   must be on the same Cloudflare account. Alternatively, add
   `routes = [{ pattern = "bostonjazzcalendar.com", custom_domain = true }]` to
   `wrangler.toml`.
7. Optional: set up Cloudflare Email Routing so
   `listings@bostonjazzcalendar.com` (shown on the page) reaches a real inbox.

## Routes

Only `/data/*`, `/calendar.ics` and `/api/*` run the worker
(`run_worker_first` in `wrangler.toml`). The asset layer serves everything
else directly, at no worker CPU cost.

| Route | Behavior |
|---|---|
| `GET /data/events.json` | R2 key `events.json`, `application/json` |
| `GET /data/status.json` | R2 key `status.json`, `application/json` |
| `GET /calendar.ics` | Every listing as iCalendar, built from `events.json` (below) |
| `GET /calendar.ics?venue=…&town=…&adjacent=0` | A feed of just that selection (below) |
| `PUT /api/publish/:key` | Upload `events.json` or `status.json` (see below) |
| `POST /api/submissions` | A gig from the form (see [Gig submissions](#gig-submissions)) |
| `GET /api/submissions/approved` | Upcoming approved gigs, for the scraper (`PUBLISH_TOKEN`) |
| `GET /api/admin/submissions?status=…` | The review queue (`ADMIN_TOKEN`) |
| `POST /api/admin/submissions/:id` | Approve or reject one (`ADMIN_TOKEN`) |

Data responses carry `Cache-Control: public, max-age=300`, an `ETag`, and
`Access-Control-Allow-Origin: *`, since the feed is meant to be reused. A
matching `If-None-Match` gets `304`. A missing object gets `404`. HEAD works.

## Calendar feeds

`src/worker-calendar.ts` builds every `/calendar.ics` from `events.json` with
`src/calendar-export.ts`, the module the page uses for one-show downloads:
UIDs `{id}@bostonjazzcalendar.com`, times in UTC, all-day shows as dates,
"Listing via" credits, and a `REFRESH-INTERVAL` of 12 hours. Without `venue`,
`town` or `adjacent` (other parameters are ignored) the feed lists
everything. With them, it lists that selection, matched as the page matches
it (`src/selection.ts`). Lists are comma-separated. Malformed values, or more
than 64 venues or 32 towns, get `400`. Venue ids and towns the data doesn't
list are dropped, so old links keep working; a selection naming only those
gets an empty feed.

- Caching: a built feed is kept gzipped in the Cache API for a day, keyed by
  the `events.json` ETag and the canonical query (sorted, deduplicated,
  unknown values dropped, one key for "matches nothing"). A new upload
  changes the key, and stray values add no entries. Each isolate also keeps
  the last `events.json` it parsed, so it can canonicalize a query without
  reading R2 again. A cache hit costs one R2 `head`.
- Compression: Cloudflare doesn't compress `text/calendar` by default, so the
  Worker does. A client that sends `Accept-Encoding: gzip` gets the cached
  gzip bytes as they are (`Content-Encoding: gzip`); others get them
  decompressed. Responses carry `Vary: Accept-Encoding`. The full feed is
  about 13 KB gzipped, against 104 KB plain.
- Validators: responses carry `Cache-Control: public, max-age=3600` and a
  strong `ETag` derived from the `events.json` ETag and the canonical query
  (`-gzip` added for the gzip encoding). An `If-None-Match` that lists it, in
  either encoding, gets `304`.
- CPU: building the feed is the costly part, and it happens once per data
  version per query per data center. For the 219-event feed a build costs
  about 1 ms, plus about 1.3 ms to gzip and 0.2 ms to parse `events.json`
  (Node/V8 timings). A 1,100-event feed costs about 4.7 + 5 + 0.9 ms, close
  to the Free plan's 10 ms. If the feed grows that large, drop the Worker's
  gzip and add a Compression Rule for `text/calendar` in the dashboard
  instead, since edge compression costs the Worker no CPU.

## Publish API

```sh
curl -X PUT \
  -H "Authorization: Bearer $PUBLISH_TOKEN" \
  -T events.json \
  https://bostonjazzcalendar.com/api/publish/events.json
```

- `:key` is `events.json` or `status.json`. The worker sets the content type
  from the key; the request's own `Content-Type` is ignored.
- `calendar.ics` is accepted (`204`) and dropped, since scrapers from before
  the Worker built the feed upload it first and fail the whole publish if
  it's refused. Remove it from `LEGACY_KEY` in `src/worker.ts` once every
  publisher is updated.
- The body is streamed straight into R2 and is not validated, so the scraper
  must validate before uploading. R2 needs the length up front, so send
  `Content-Length` (curl `-T` and httpx with a bytes body both do). A chunked
  body gets `411`.
- Responses:
  - `204`: stored. The response carries the new `ETag`.
  - `401`: missing or wrong token, or no `PUBLISH_TOKEN` configured. The
    token is compared in constant time.
  - `400`: unknown key.
  - `405`: method other than `PUT`.

## Stale-data alerts

A Cron Trigger (`[triggers]` in `wrangler.toml`) runs the Worker's
`scheduled` handler (`src/worker-freshness.ts`) at the top of every hour. It
reads only the metadata of R2's `events.json` (one `head`, no body) and posts
a high-priority ntfy notice, "Boston Jazz Calendar: no fresh data", when the
upload is 30 or more hours old. That's one missed daily run plus a few hours.
The notice gives the age and points at the scraper on the Mac and
`~/Library/Logs/jazzcal.log`.

The check keeps no state. It alerts in the hour after the data turns 30 hours
old, then in the same hour each day (54 h, 78 h, …) until an upload resets
the clock. Cron ticks are scheduled exactly an hour apart, and the age is
measured from the scheduled time, so exactly one tick falls in each of those
hours. A missing `events.json` alerts daily at 13:00 UTC. Notices use the
same `NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN` as new submissions; without
them the check does nothing.

To try it locally: `bun run build && bunx wrangler dev --test-scheduled`,
then `curl 'http://localhost:8787/__scheduled?cron=0+*+*+*+*'`.

## Submissions

Musicians and venues can send in gigs, and standing series ("regulars"),
that no source lists. Nothing appears until the owner approves it, and the
scraper stays the only publisher of the feed:

1. "Submit a gig" (any link to `#submit`) opens a dialog. The form checks
   its fields with `src/submission.ts`, gets a Cloudflare Turnstile token
   (the widget's script loads only when the dialog first opens), and posts
   JSON to `POST /api/submissions`.
2. The Worker reads at most 16 KB of body, counting the bytes that arrive
   rather than trusting `Content-Length`. It validates the same way as the
   form (lengths; for a gig, a date from today to a year out; for a
   regular, its weekdays, and for a monthly one which weeks; a start time
   unless "Time TBA"; a venue id, or "other" with a name, street address and
   town; an http(s) confirmation link; a name, and an email with none of `?&%,;<>` or
   whitespace, so it can't add recipients or headers to a `mailto:` link).
   Then it verifies the token with Turnstile's siteverify, which must report
   success, the widget's action (`submit-gig`) and one of the site's
   hostnames (`SITE_HOSTS`). Only then does it read `events.json` and the
   added venues to check the venue id, so junk posts cost no reads, and it
   stores a `pending`
   row in D1. It answers `201 {"id", "status": "pending"}`, `400` with
   `fields` for bad input, `403` when Turnstile says no, `413` for a body
   over 16 KB, and `503` until `TURNSTILE_SECRET` is set. With one of
   Cloudflare's test secrets (the `.dev.vars` one under Development),
   siteverify reports `example.com` and no action, so only its success
   counts.
3. The owner reviews at `/admin` (`public/admin.html`, not linked and
   `noindex`), which shows every field, the submitter's name and email, and
   the confirmation link. Approving saves any edits (title, how often, date
   or days, times, venue, price) and needs a relevance (jazz or
   jazz-adjacent) and a venue: a listed one, or for a room we don't list, a
   new one from the details on the card (an id, and how much jazz it
   books). The venue and the approval are written in one D1 batch. The
   Venues tab edits or deletes venues added this way (`src/worker-venues.ts`;
   not one an approved listing uses). Approving a regular records it as
   confirmed today; once that's 90 days old the card asks for a recheck, and
   "Still running" confirms it again. Rejecting an approved listing
   unpublishes it.
4. The scraper's `submissions` source reads
   `GET /api/submissions/approved` with its publish token: upcoming approved
   gigs with only the publishable fields (id, title, date, times, venue id,
   price, link, relevance). They join the next daily build, below the
   venues' own sources, so a venue's listing of the same show wins.
5. Each scrape also reads `GET /api/registry` (same token): the added
   venues, and the approved regulars as the feed lists them, with `when`
   written from their days and times (`scheduleText`). The scraper lists
   them after `../data/venues.yaml` and `../data/regulars.yaml`.

Submitters' names, emails and notes never leave D1 except through the admin
API. Admin and submission responses are `Cache-Control: no-store`.

## Security headers and analytics

`public/_headers` sets a Content-Security-Policy on every page. Third-party
code is limited to the Turnstile widget and the analytics tracker, and the
tracker is allowed by exact URL: `script-src` names only
`https://analytics.oberbrunner.com/tracker.js` and `connect-src` only its
`/api/collect`, so nothing else on that host can run here or receive data.
`src/analytics.ts` exports both URLs and `src/csp.test.ts` checks they match.
The tracker loads with a dynamic `import()` only on the production hosts,
with `autoPageviews: false` and a single `page()` call. It has no
Subresource Integrity hash: its URL is unversioned and served with
`max-age=86400`, so a hash would break on every featherstat update.

The review page gets a second, stricter policy (`/admin*`:
`script-src 'self'; connect-src 'self'; frame-src 'none'`). Cloudflare joins
the two rules' headers with a comma, which browsers enforce as two policies,
so the page can run only its own bundle and talk only to this site.
`admin.html` loads no script but `/admin.js` (hashed at build), whose imports never reach
`analytics.ts`; `src/csp.test.ts` checks both.

`_headers` also sends `X-Robots-Tag: noindex` with every response. That's
deliberate during the quiet launch: search engines leave the site out of
their results. `robots.txt` still allows everything on purpose, since a
crawler has to fetch a page to see its noindex. To launch, delete the
`X-Robots-Tag` line.

## Operations / hardening (dashboard)

These live in the Cloudflare dashboard, not in this repo:

1. **Cloudflare Access on the review page.** Zero Trust → Access →
   Applications → Add → Self-hosted. Domain `bostonjazzcalendar.com`,
   paths `admin`, `admin.html` and `api/admin/*`; an Allow policy for the
   owner's email, with one-time PIN login. Keep `ADMIN_TOKEN` as a second
   factor. Leave `/api/publish/*` and `/api/submissions/approved` outside
   Access; the scraper authenticates with its bearer token. Access on the
   custom domain doesn't cover `jazz-calendar.garyo.workers.dev`: once the
   domain is settled, set `workers_dev = false` in `wrangler.toml` and drop
   that host from `SITE_HOSTS` in `src/worker-submissions.ts`, or turn on
   Access for workers.dev under the Worker's Settings → Domains & Routes.
2. **WAF rate limit on submissions.** Security → WAF → Rate limiting rules
   (the free plan allows one rule, counted per IP over 10 seconds). Match
   `http.request.uri.path eq "/api/submissions" and http.request.method eq "POST"`,
   about 3 requests per 10 seconds, action Block. This caps Turnstile and
   D1 work from a single client.
3. **HTTPS only.** SSL/TLS → Edge Certificates: turn on Always Use HTTPS,
   set Minimum TLS Version to 1.2, and enable HSTS (max-age 6 months; add
   includeSubDomains only if every subdomain serves HTTPS; skip preload
   until the site has run that way for a while).
