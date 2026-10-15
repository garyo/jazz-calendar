# jazzcal — the scraper

Collects jazz and jazz-adjacent events from Boston-area venues and calendars, and publishes
them to the site as `events.json` and `status.json`. The site builds its `/calendar.ics`
feeds from `events.json`.

```sh
uv sync
uv run jazzcal run                 # scrape every enabled source, build var/out/
uv run jazzcal run --source nec    # just one source (repeatable)
uv run jazzcal show lilypad        # print what a source yields, without storing it
uv run jazzcal run --offline       # rebuild from cached pages only, no network
uv run jazzcal publish             # upload var/out/ to the site
uv run jazzcal schema              # regenerate ../schema/events.schema.json
uv run jazzcal adapters            # list the adapters and the options each takes
```

Checks: `uv run ruff format . && uv run ruff check . && uvx ty check && uv run pytest -q`

## How it works

- **`../data/venues.yaml`** is the venue registry. **`../data/sources.yaml`** lists the
  sources, each handled by an *adapter* for its platform (`ics`, `tribe`, `jsonld`,
  `squarespace`, ...). Their order sets priority when two sources list the same event.
  Loading checks every source, enabled or not: its settings (`models.Source`) and its
  adapter's `options`. A misspelled or ill-typed setting, a regex that doesn't compile or an
  unknown adapter stops the run with the source's id.
- **Adapters** (`src/jazzcal/adapters/`) fetch through `http.Http` and return
  `ScrapedEvent`s. Parsing is a pure function tested against saved pages in
  `tests/fixtures/`. An adapter that takes options declares them as a pydantic model,
  `@adapter("jsonld", options=JsonLdOptions)`, and receives them parsed. Shared helpers for
  clock times, all-caps titles, cancellations and JSON-LD live in `adapters/__init__.py`
  and `adapters/times.py`. A `ScrapedEvent` drops an end that isn't after its start.
- **`http.Http`** is polite and careful by construction:
  - It sends an identifying User-Agent.
  - It honors robots.txt (RFC 9309, wildcards included) and Crawl-delay. A robots.txt that
    answers with a server error blocks its host for the rest of the run, but isn't cached.
  - It waits at least 3 s between requests to a host.
  - It retries a server error, timeout or failed connection twice, backing off (5 s, then
    10 s) or waiting out a Retry-After of up to a minute. A longer Retry-After ends the try.
  - Pages fetched within `--max-age` (6 h) come from the cache in `var/cache/`; older ones are
    revalidated with a conditional GET. Event detail pages that adapters follow from a list
    page are reused for 5 days (`DETAIL_MAX_AGE`); the list pages still refresh every run.
  - It follows at most 5 redirects, and checks robots.txt for every host along the way.
  - It fetches only http(s) URLs on public addresses, so a page can't redirect it into
    the local network. The site's own host (`$JAZZCAL_SITE`) is exempt, for local testing.
  - It stops reading a response at 10 MB.
- **`store.Store`** (SQLite, `var/jazzcal.db`) keeps every source's listings.
  - A source that fails keeps its last good listings, and the failure shows in `status.json`.
    After 7 days of failures its events are dropped.
  - A run that finds no events at all counts as a failure ("0 events (had N upcoming last
    run)") when the last successful run found shows still to come. That's usually a broken
    page rather than an empty calendar.
  - An event a source stops listing is dropped after two runs without it.
  - After each scrape, the store forgets listings a source has dropped whose events ended over
    30 days ago, and the cache deletes pages unused for 30 days (except on `--offline` runs).
- **`pipeline.scrape_source`** runs a source's adapter and applies its `title_strip` and
  `title_replace` to the titles (`Source.retitle`, ignoring case). `jazzcal show` prints
  what it returns.
- **`pipeline.build`**:
  1. Resolves venues (by id, name, alias or street address).
  2. Classifies each event as jazz, adjacent or other (`classify.py`).
  3. Merges duplicates across sources (same venue and night, start within an hour, similar
     title). A set starting before 4 am belongs to the previous night (`config.night_of`), as
     on the site.
  4. Drops past events.
  5. Gives each event a stable id, which is also its calendar UID. A new event's id derives
     from its leading listing (`sha1(source|uid)`). Each listing remembers the id it was
     published under, and an event keeps the id of its longest-standing listing. So when a
     higher-priority source starts or stops listing a show, calendar apps don't see it
     deleted and added again.

### When sources keep failing

If an enabled source fails on 2 runs in a row, the run sends one [ntfy](https://ntfy.sh)
notification listing every such source with its error. While they keep failing it repeats
at most once a week, or sooner when another source starts failing. It uses the same settings
as `deploy/run.sh`: `NTFY_USER` and `NTFY_PASS` (nothing is sent without them), `NTFY_URL`
(default `https://ntfy.oberbrunner.com`) and `NTFY_TOPIC` (default `misc`). A failed
notification never fails the run. `run.sh` posts separately, at high priority, when a whole
run fails.

### Weekly regulars

`../data/regulars.yaml` lists standing series that venues publish with no dated listings, such
as Wally's jam. The feed carries them in a separate `regulars` list, and the site shows them in
their own section. They never become calendar events: a standing schedule doesn't promise any
particular night. Only list what a venue or organizer publishes, and recheck it now and then.
`when` is the schedule in the venue's words; `days` (plus `nth`, for e.g. 1st and 3rd Fridays)
lets the site show a series in views of the days it usually runs.

### Submitted gigs

Musicians and venues can submit gigs on the site; the owner approves them on its `/admin` page
(see `../site/README.md`). The `submissions` source reads the approved, upcoming ones from
`$JAZZCAL_SITE/api/submissions/approved` with `JAZZCAL_PUBLISH_TOKEN`, so it needs no settings
of its own. Each comes with the venue id and relevance the editor chose (`ScrapedEvent.relevance`,
which `classify.py` takes as certain) and links to the page the submitter gave as confirmation.
It sits below the venues' own sources, so their listing of the same show wins. To try it against
a local `wrangler dev`: `JAZZCAL_SITE=http://127.0.0.1:8787 uv run jazzcal show submissions`.

### Classification

`classify.py` decides jazz, adjacent or other with keyword rules. A ruling is *certain* when
it rests on something decisive: the source's word, an explicit jazz genre in the title or tags,
or a dedicated jazz room. The rest are guesses.

With `--classifier claude-haiku-5-5` (or `JAZZCAL_CLASSIFIER`), those guesses go to a language
model (`llm.py`), 25 listings per request. Its verdicts are cached by content in the store, so
only new or changed listings cost anything.
- It may answer "unknown", which changes nothing.
- It can drop a listing the rules kept only when at least 85% sure. Missing a local gig is
  worse than listing a stray show.
- A source's `unknown:` setting gives the fallback for rooms where unfamiliar acts are
  usually jazz.

`uv run jazzcal eval [--classifier MODEL]` scores rules alone and rules plus the model against
the hand labels in `eval/labels.yaml`. It leads with missed shows. Any classifier that has a
`name` and `classify(questions) -> {id: Verdict}` can be compared this way.

We publish facts and links only, never venue descriptions or images. Every event links back to
its venue or source. The feed's `sources` list credits each source its events came from, and a
listing that came through a third party (`via: true`, e.g. Ticketmaster) says so on the site
and in calendar descriptions ("Listing via Ticketmaster").

## Adding a source

1. Find the venue's most structured data. In order of preference: an ICS feed, a JSON API,
   JSON-LD in the page, then HTML. See `../research/venues.md`.
2. Check robots.txt. If it disallows the path, don't work around it; ask the venue instead.
3. Add the venue to `venues.yaml` if it's new, then the source to `sources.yaml`, with a
   `credit`: a name and public page for people, plus `via: true` when it's a third party to
   the venue (a ticket seller or aggregator). The site and calendar feeds credit it from there.
   The file's header describes the settings any source can have (`include`, `exclude`,
   `unknown`, `title_strip`, ...); `uv run jazzcal adapters` lists each adapter's `options`.
   Both are checked when the registry loads, so a typo fails at once rather than being
   ignored.
4. Check what comes out with `uv run jazzcal show <id>` and `uv run jazzcal run --source <id>`.
5. Save a test fixture, then redact it before committing:
   `uv run python tests/redact.py [--keep SELECTOR] tests/fixtures/<file>`. Fixtures keep
   facts and structure only, never venue descriptions, bios or images.

## Deployment

The scraper runs once a day on a small always-on machine and publishes to the Cloudflare site
through its authenticated publish API (see `../site/README.md`). Secrets live in an env file
outside the repo; `deploy/jazzcal.env.example` lists them.

### macOS (launchd), the current setup

```sh
git clone <repo> ~/src/jazz-calendar && cd ~/src/jazz-calendar/scraper && uv sync --frozen
mkdir -p ~/.config/jazzcal
install -m 600 deploy/jazzcal.env.example ~/.config/jazzcal/env   # then fill it in
deploy/run.sh                                                    # one manual run to check
sudo cp deploy/com.bostonjazzcalendar.scraper.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.bostonjazzcalendar.scraper.plist
```

Replace `USERNAME` in the plist with the account that runs it (`sed -i "" "s/USERNAME/$(whoami)/g" ...`).

Day to day:
- Run now: `sudo launchctl kickstart system/com.bostonjazzcalendar.scraper`
- Logs: `~/Library/Logs/jazzcal.log`
- Update: `git pull && uv sync --frozen`. The job picks up the new code on its next run.
- Remove: `sudo launchctl bootout system/com.bostonjazzcalendar.scraper`

### Linux (systemd)

```sh
sudo useradd --system --home /opt/jazz-calendar jazzcal
sudo git clone <repo> /opt/jazz-calendar && sudo chown -R jazzcal /opt/jazz-calendar
sudo -u jazzcal sh -c 'cd /opt/jazz-calendar/scraper && uv sync --frozen'
sudo install -m 600 deploy/jazzcal.env.example /etc/jazzcal.env   # then edit it
sudo cp deploy/jazzcal.service deploy/jazzcal.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jazzcal.timer
```

Run now with `sudo systemctl start jazzcal`; logs are in `journalctl -u jazzcal`.

Either way, set `JAZZCAL_HEALTHCHECK_URL` to get an alert when daily runs stop.

`jazzcal publish` uploads `events.json`, then `status.json`, so the status always describes
a publish that went through. Each upload is retried up to 3 times on server errors and failed
connections. The healthcheck ping comes last; if it fails, the run logs a warning but still
succeeds.
