# bostonjazzcalendar.com: site

The public website: one Cloudflare Worker with static assets. The front end is
vanilla TypeScript bundled with `bun build`, plus plain CSS. The listings
come from the Python scraper in `../scraper`, which uploads its output
through the publish API below. The worker stores it in R2.

```
public/          static files copied into dist/ (index.html, styles.css, _headers, …)
src/main.ts      front-end entry: fetches /data/events.json, filters, renders
src/render.ts    DOM construction (text only, never innerHTML)
src/listings.ts  pure logic: upcoming, filtering, grouping by Boston-local day
src/time.ts      America/New_York date and time formatting
src/url-state.ts filter state <-> query string
src/types.ts     TS mirror of ../schema/events.schema.json
src/worker.ts    the Worker: R2-backed data routes and the publish API
```

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
| `PUT /api/publish/:key` | Upload one of the three keys (see below) |

Data responses carry `Cache-Control: public, max-age=300`, an `ETag`, and
`Access-Control-Allow-Origin: *`, since the feed is meant to be reused. A
matching `If-None-Match` gets `304`. A missing object gets `404`. HEAD works.

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
