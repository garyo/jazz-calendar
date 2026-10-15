# bostonjazzcalendar.com: site

The public website: one Cloudflare Worker with static assets. The front end is
vanilla TypeScript bundled with `bun build`, plus plain CSS. The listings
come from the Python scraper in `../scraper`, which uploads its output
through the publish API below. The worker stores it in R2.

```
public/          static files copied into dist/ (index.html, styles.css, _headers, …)
src/main.ts      front-end entry: fetches /data/events.json, wires controls, renders
src/render.ts    DOM construction (text only, never innerHTML), incl. the month grid
src/picker.ts    multi-select (venues, towns); src/disclosure.ts: popover toggling
src/listings.ts  pure logic: upcoming, filtering, grouping by Boston-local day
src/month.ts     pure logic: the month view's Sunday-first grid
src/selection.ts venue/town/jazz-adjacent selection: matching, parsing, feed names
                 (shared by the front end and the Worker)
src/calendar-export.ts  iCalendar generation and Google Calendar links (shared)
src/time.ts      America/New_York date and time formatting
src/url-state.ts view state <-> query string
src/types.ts     TS mirror of ../schema/events.schema.json
src/worker.ts    the Worker: R2-backed data routes, filtered feeds, the publish API
src/theme.ts     the review-period theme switcher
```

## Themes

`public/styles.css` holds the shared structure, drawn entirely from custom
properties. Each `public/theme-*.css` (`guide`, `program`, `lateset`, `club`)
defines its colors and fonts, light and dark, plus its own layouts, all scoped
to `:root[data-theme="…"]`. Program's layout is shared by four variants
(`liner`, `bluenote`, `evening`, `broadsheet`): `theme-program.css` scopes it
to the whole family, and each variant's file, loaded after it, adds only
colors, fonts and a few flourishes. A new variant goes in that selector list. A small inline script in `index.html` sets
`data-theme` before first paint from `?theme=…`, then the choice saved in
`localStorage`, then the default (`program`); `_headers` allows that script
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

To try the publish API locally, create `.dev.vars` (gitignored):

```
PUBLISH_TOKEN=local-dev-token
```

Other scripts:

| Script | What it does |
|---|---|
| `bun run build` | Bundle `src/main.ts` and copy `public/` into `dist/` |
| `bun run typecheck` | `tsc` for the front end and the worker (separate configs) |
| `bun run lint` / `lint:fix` | Biome |
| `bun run test` | `bun test`: time, filtering, URL-state and worker tests |
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
3. Deploy once with `bun run deploy`.
4. Add the custom domain: in the dashboard, Workers & Pages →
   `bostonjazzcalendar` → Settings → Domains & Routes → Add →
   Custom domain → `bostonjazzcalendar.com` (and `www.` if wanted). The zone
   must be on the same Cloudflare account. Alternatively, add
   `routes = [{ pattern = "bostonjazzcalendar.com", custom_domain = true }]` to
   `wrangler.toml`.
5. Optional: set up Cloudflare Email Routing so
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
