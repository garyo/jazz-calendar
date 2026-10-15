# jazzcal — the scraper

Collects jazz and jazz-adjacent events from Boston-area venues and calendars, and publishes
them to the site as `events.json`, `status.json` and `calendar.ics`.

```sh
uv sync
uv run jazzcal run                 # scrape every enabled source, build var/out/
uv run jazzcal run --source nec    # just one source (repeatable)
uv run jazzcal show lilypad        # print what a source yields, without storing it
uv run jazzcal run --offline       # rebuild from cached pages only, no network
uv run jazzcal publish             # upload var/out/ to the site
uv run jazzcal schema              # regenerate ../schema/events.schema.json
```

Checks: `uv run ruff format . && uv run ruff check . && uvx ty check && uv run pytest -q`

## How it works

- **`../data/venues.yaml`** is the venue registry. **`../data/sources.yaml`** lists the
  sources, each handled by an *adapter* for its platform (`ics`, `tribe`, `jsonld`,
  `squarespace`, ...). Their order sets priority when two sources list the same event.
- **Adapters** (`src/jazzcal/adapters/`) fetch through `http.Http` and return
  `ScrapedEvent`s. Parsing is a pure function tested against saved pages in
  `tests/fixtures/`.
- **`http.Http`** is polite by construction:
  - It sends an identifying User-Agent.
  - It honors robots.txt (RFC 9309, wildcards included) and Crawl-delay.
  - It waits at least 3 s between requests to a host.
  - Pages fetched within `--max-age` (6 h) come from the cache in `var/cache/`; older ones are
    revalidated with a conditional GET.
- **`store.Store`** (SQLite, `var/jazzcal.db`) keeps every source's listings.
  - A source that fails keeps its last good listings, and the failure shows in `status.json`.
    After 7 days of failures its events are dropped.
  - An event a source stops listing is dropped after two runs without it.
- **`pipeline.build`**:
  1. Resolves venues (by id, name, alias or street address).
  2. Classifies each event as jazz, adjacent or other (`classify.py`).
  3. Merges duplicates across sources (same venue and day, start within an hour, similar
     title).
  4. Drops past events.

### Weekly regulars

`../data/regulars.yaml` lists standing series that venues publish with no dated listings, such
as Wally's jam. The feed carries them in a separate `regulars` list, and the site shows them in
their own section. They never become calendar events: a standing schedule doesn't promise any
particular night. Only list what a venue or organizer publishes, and recheck it now and then.

### Classification

`classify.py` decides jazz, adjacent or other with keyword rules. A ruling is *certain* when
it rests on something decisive: the source's word, an explicit genre in the title or tags, or
a dedicated jazz room. The rest are guesses.

With `--classifier claude-haiku-5-5` (or `JAZZCAL_CLASSIFIER`), those guesses go to a language
model (`llm.py`), 25 listings per request. Its verdicts are cached by content in the store, so
only new or changed listings cost anything.
- It may answer "unknown", which changes nothing.
- It can drop a listing the rules kept only when at least 85% sure. Missing a local gig is
  worse than listing a stray show.
- A source's `unknown:` option sets the fallback for rooms where unfamiliar acts are usually
  jazz.

`uv run jazzcal eval [--classifier MODEL]` scores rules alone and rules plus the model against
the hand labels in `eval/labels.yaml`. It leads with missed shows. Any classifier that has a
`name` and `classify(questions) -> {id: Verdict}` can be compared this way.

We publish facts and links only, never venue descriptions or images. Every event links back to
its venue or source.

## Adding a source

1. Find the venue's most structured data. In order of preference: an ICS feed, a JSON API,
   JSON-LD in the page, then HTML. See `../research/venues.md`.
2. Check robots.txt. If it disallows the path, don't work around it; ask the venue instead.
3. Add the venue to `venues.yaml` if it's new, then the source to `sources.yaml`.
4. Check what comes out with `uv run jazzcal show <id>` and `uv run jazzcal run --source <id>`.
5. Save a test fixture, then redact it before committing:
   `uv run python tests/redact.py [--keep SELECTOR] tests/fixtures/<file>`. Fixtures keep
   facts and structure only, never venue descriptions, bios or images.

## Deployment

The scraper runs on a small Linux box (a cloud VM or a home server) under a systemd timer.
It publishes to the Cloudflare site through its authenticated publish API (see
`../site/README.md`).

```sh
sudo useradd --system --home /opt/jazz-calendar jazzcal
sudo git clone <repo> /opt/jazz-calendar && sudo chown -R jazzcal /opt/jazz-calendar
sudo -u jazzcal sh -c 'cd /opt/jazz-calendar/scraper && uv sync --frozen'
sudo install -m 600 deploy/jazzcal.env.example /etc/jazzcal.env   # then edit it
sudo cp deploy/jazzcal.service deploy/jazzcal.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jazzcal.timer
```

Day to day:
- Run now: `sudo systemctl start jazzcal`
- Logs: `journalctl -u jazzcal`
- Debug as the service user: `sudo -u jazzcal uv run jazzcal run --source <id> -v`

Set `JAZZCAL_HEALTHCHECK_URL` to get an alert when daily runs stop.
