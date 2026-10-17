# Boston Jazz Calendar

Every jazz and jazz-adjacent show in Greater Boston, in one place. Each listing links to the
venue and its tickets. Lives at [bostonjazzcalendar.com](https://bostonjazzcalendar.com).

| Directory | What |
|---|---|
| [`scraper/`](scraper/) | Python (uv). Gathers events from venue sites and calendars, and publishes the feed. Runs on a schedule on a small server. |
| [`site/`](site/) | TypeScript (bun). A Cloudflare Worker serving the static front end, plus the feed from R2. |
| [`data/`](data/) | The venue and source registries the scraper reads. |
| [`schema/`](schema/) | JSON Schema of the published feed (generated from `scraper/src/jazzcal/models.py`) and a sample feed. |
| [`research/`](research/) | Venue survey and notes on aggregation, data sources and the legal landscape. |

Data flow: venue sites → `scraper` (daily) → `PUT /api/publish/*` → R2 → `site` →
`/data/events.json`, `/calendar.ics`.

## Ground rules

- Publish facts and links only: no copied descriptions or images.
- Honor robots.txt; never get around a bot wall.
- Identify the scraper; fetch each source at most a few times a day.
- Remove a venue's listings promptly if it asks, and any listing whose artist asks (see
  "Removing listings on request" in [`scraper/README.md`](scraper/README.md)).

## License

MIT; see [LICENSE](LICENSE). Event listings belong to their venues; this project publishes
only facts and links back to them.
