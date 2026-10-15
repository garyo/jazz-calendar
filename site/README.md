# bostonjazzcalendar.com: site

The public website: one Cloudflare Worker with static assets. The front end is
vanilla TypeScript bundled with `bun build`, plus plain CSS. The listings
come from the Python scraper in `../scraper`, which uploads its output
through the publish API below. The worker stores it in R2.

```
public/          static files copied into dist/ (index.html, styles.css, _headers, …)
public/admin.html  the submissions review page (unlinked, noindex), with admin.css
migrations/      D1 schema for gig submissions
src/main.ts      front-end entry: fetches /data/events.json, wires controls, renders
src/render.ts    DOM construction (text only, never innerHTML), incl. the month grid
src/picker.ts    multi-select (venues, towns); src/disclosure.ts: popover toggling
src/listings.ts  pure logic: upcoming, filtering, grouping by Boston-local day
src/month.ts     pure logic: the month view's Sunday-first grid
src/selection.ts venue/town/jazz-adjacent selection: matching, parsing, feed names
                 (shared by the front end and the Worker)
src/calendar-export.ts  iCalendar generation and Google Calendar links (shared)
src/credits.ts   source credits: "via" lines and the list of sources (shared)
src/time.ts      America/New_York date and time formatting
src/url-state.ts view state <-> query string
src/types.ts     TS mirror of ../schema/events.schema.json
src/worker.ts    the Worker: R2-backed data routes, filtered feeds, the publish API
src/worker-submissions.ts  the Worker's gig submission and review API (D1)
src/worker-http.ts         response and bearer-token helpers for the Worker
src/submission.ts  submission records, limits and validation (shared)
src/submit.ts    the "Submit a gig" dialog; src/admin.ts: the review page
src/theme.ts     the review-period theme switcher
```

## Themes

`public/styles.css` holds the shared structure, drawn entirely from custom
properties. Each `public/theme-*.css` (`guide`, `program`, `lateset`, `club`)
defines its colors and fonts, light and dark, plus its own layouts, all scoped
to `:root[data-theme="…"]`. Program's layout is shared by four variants
(`liner`, `hardbop`, `evening`, `broadsheet`): `theme-program.css` scopes it
to the whole family, and each variant's file, loaded after it, adds only
colors, fonts and a few flourishes. A new variant goes in that selector list. A small inline script in `index.html` sets
`data-theme` before first paint from `?theme=…`, then the choice saved in
`localStorage`, then the default (`liner`); `_headers` allows that script
by its sha256, which `theme.test.ts` checks. The footer switcher changes it in
place. To settle on one theme, delete the other theme files and their
`<link>`s, the switcher (`#theme-switcher` and `themeSwitcher()` in
`main.ts`), and fold the remaining theme into `styles.css` if wanted.

Page URLs carry the view: `q`, `venue=lilypad,wallys`, `town=Cambridge,Somerville`
(a single old-style `town=` still works), `adjacent=0`, `when`, `view=month`,
`month=2026-11` and `day=2026-11-12`. A listing matches the selection when it
is at any selected venue or in any selected town; with neither selected,
everything matches. Regulars follow the same rule.

## Development

```sh
bun install
bun run seed:local   # put ../schema/sample-events.json into local R2 as events.json
bun run dev          # build, then wrangler dev on http://localhost:8787
```

`wrangler dev` reloads static files when `dist/` changes. After editing
front-end code, run `bun run build` in another terminal. Local R2 data lives
in `.wrangler/state` and persists between runs.

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
| `bun run build` | Bundle `src/main.ts` and `src/admin.ts` and copy `public/` into `dist/` |
| `bun run typecheck` | `tsc` for the front end and the worker (separate configs) |
| `bun run lint` / `lint:fix` | Biome |
| `bun run test` | `bun test`: time, filtering, URL-state, rendering (happy-dom) and worker tests |
| `bun run check` | typecheck + lint + test |
| `bun run deploy` | Build, then `wrangler deploy` |

## One-time Cloudflare setup (owner)

`account_id` comes from the `CLOUDFLARE_ACCOUNT_ID` environment variable, not
`wrangler.toml`.

1. Create the bucket:
   `bunx wrangler r2 bucket create bostonjazzcalendar-data`
2. Set the publish token (generate a long random one, e.g.
   `openssl rand -base64 32`):
   `bunx wrangler secret put PUBLISH_TOKEN`
   Give the same token to the scraper's upload step.
3. Set up gig submissions (see [Gig submissions](#gig-submissions)); the
   deploy fails until `wrangler.toml` has a real D1 `database_id`:
   1. `bunx wrangler d1 create bostonjazzcalendar`, and put the printed
      `database_id` in `wrangler.toml`.
   2. `bunx wrangler d1 migrations apply bostonjazzcalendar --remote`. Run
      it again whenever `migrations/` gains a file.
   3. In the dashboard, Turnstile → Add widget, Managed mode, with the
      hostnames `bostonjazzcalendar.com`, `www.bostonjazzcalendar.com` and
      `jazz-calendar.garyo.workers.dev`. Put its site key in `SITE_KEY` in
      `src/submit.ts` (it's public), and its secret key in the Worker:
      `bunx wrangler secret put TURNSTILE_SECRET`.
   4. `bunx wrangler secret put ADMIN_TOKEN` with another long random token
      (`openssl rand -base64 32`). Paste it into `/admin` once; that browser
      remembers it.
4. Deploy with `bun run deploy`.
5. Add the custom domain: in the dashboard, Workers & Pages →
   `jazz-calendar` → Settings → Domains & Routes → Add →
   Custom domain → `bostonjazzcalendar.com` (and `www.` if wanted). The zone
   must be on the same Cloudflare account. Alternatively, add
   `routes = [{ pattern = "bostonjazzcalendar.com", custom_domain = true }]` to
   `wrangler.toml`.
6. Optional: set up Cloudflare Email Routing so
   `listings@bostonjazzcalendar.com` (shown on the page) reaches a real inbox.

## Routes

Only `/data/*`, `/calendar.ics` and `/api/*` run the worker
(`run_worker_first` in `wrangler.toml`). The asset layer serves everything
else directly, at no worker CPU cost.

| Route | Behavior |
|---|---|
| `GET /data/events.json` | R2 key `events.json`, `application/json` |
| `GET /data/status.json` | R2 key `status.json`, `application/json` |
| `GET /calendar.ics` | R2 key `calendar.ics`, `text/calendar; charset=utf-8` |
| `GET /calendar.ics?venue=…&town=…&adjacent=0` | A feed of just that selection (below) |
| `PUT /api/publish/:key` | Upload one of the three keys (see below) |
| `POST /api/submissions` | A gig from the form (see [Gig submissions](#gig-submissions)) |
| `GET /api/submissions/approved` | Upcoming approved gigs, for the scraper (`PUBLISH_TOKEN`) |
| `GET /api/admin/submissions?status=…` | The review queue (`ADMIN_TOKEN`) |
| `POST /api/admin/submissions/:id` | Approve or reject one (`ADMIN_TOKEN`) |

Data responses carry `Cache-Control: public, max-age=300`, an `ETag`, and
`Access-Control-Allow-Origin: *`, since the feed is meant to be reused. A
matching `If-None-Match` gets `304`. A missing object gets `404`. HEAD works.

## Filtered feeds

`/calendar.ics` with any of `venue`, `town` or `adjacent` builds a feed from
`events.json` using the same matching as the page (`src/selection.ts`), with
the scraper's UIDs, times in UTC and a `REFRESH-INTERVAL` of 12 hours. Lists
are comma-separated; unknown venue ids or towns, malformed values or more
than 64 venues or 32 towns get `400`. A query that selects everything (e.g.
`?adjacent=1`) serves the stored feed. Responses carry
`Cache-Control: public, max-age=3600` and are kept in the Cache API under the
normalized query plus the `events.json` ETag, so a new upload invalidates
them.

## Publish API

```sh
curl -X PUT \
  -H "Authorization: Bearer $PUBLISH_TOKEN" \
  -T events.json \
  https://bostonjazzcalendar.com/api/publish/events.json
```

- `:key` is one of `events.json`, `status.json`, `calendar.ics`. The worker
  sets the content type from the key; the request's own `Content-Type` is
  ignored.
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

## Gig submissions

Musicians and venues can send in gigs that no source lists. Nothing appears
until the owner approves it, and the scraper stays the only publisher of the
feed:

1. "Submit a gig" (any link to `#submit`) opens a dialog. The form checks
   its fields with `src/submission.ts`, gets a Cloudflare Turnstile token
   (the widget's script loads only when the dialog first opens), and posts
   JSON to `POST /api/submissions`.
2. The Worker validates the same way (lengths; a date from today to a year
   out; a start time unless "Time TBA"; a venue id from `events.json`, or
   "other" with a name and town; an http(s) confirmation link; name and
   email), then verifies the token with Turnstile's siteverify, and stores a
   `pending` row in D1. It answers `201 {"id", "status": "pending"}`, `400`
   with `fields` for bad input, `403` when Turnstile says no, and `503`
   until `TURNSTILE_SECRET` is set.
3. The owner reviews at `/admin` (`public/admin.html`, not linked and
   `noindex`), which shows every field, the submitter's name and email, and
   the confirmation link. Approving saves any edits (title, date, times,
   venue, price), and needs a listed venue and a relevance (jazz or
   jazz-adjacent). A gig at a room we don't list waits until the venue is
   added to `../data/venues.yaml` and published. Rejecting an approved gig
   unpublishes it.
4. The scraper's `submissions` source reads
   `GET /api/submissions/approved` with its publish token: upcoming approved
   gigs with only the publishable fields (id, title, date, times, venue id,
   price, link, relevance). They join the next daily build, below the
   venues' own sources, so a venue's listing of the same show wins.

Submitters' names, emails and notes never leave D1 except through the admin
API. Admin and submission responses are `Cache-Control: no-store`.
