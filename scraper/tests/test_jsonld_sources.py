"""The jsonld adapter's options, against real pages from its sources and made-up lists."""

from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from jazzcal import http as http_module
from jazzcal.adapters import jsonld
from jazzcal.adapters.jsonld import JsonLdOptions
from jazzcal.config import TZ, Registry, VenueConfig
from jazzcal.http import Http
from jazzcal.models import Source

FIXTURES = Path(__file__).parent / "fixtures"

HOBGOBLIN = JsonLdOptions(time_selector="article h1 + p")
GLOBAL_ARTS_LIVE = JsonLdOptions.model_validate(
    {
        "time_selector": ".date-display-single",
        "venue_selector": 'meta[property="og:title"]',
        "venue_pattern": r"\bat ((?:(?! at ).)+)$",
        "no_price": True,
        "ticket_link": "a.event-links",
    }
)
GROTON_HILL = JsonLdOptions(
    ticket_link='a[href*="ovationtix.com"][href*="/performance/"]', no_end=True
)


def test_hobgoblin_time_from_page() -> None:
    url = "https://www.hobgoblinbar.com/event/129/"
    page = (FIXTURES / "hobgoblin-event.html").read_text()
    [event] = jsonld.parse(page, base_url=url, options=HOBGOBLIN)
    assert event.title.startswith("10/15 ")
    hobgoblin = Source(
        id="hobgoblin", adapter="jsonld", url=url, title_strip=r"^\d{1,2}/\d{1,2}\s+"
    )
    assert hobgoblin.retitle(event.title) == event.title.removeprefix("10/15 ")
    assert not event.all_day
    assert event.start == datetime(2026, 10, 15, 19, 0, tzinfo=TZ)
    assert event.end == datetime(2026, 10, 15, 23, 0, tzinfo=TZ)


def test_global_arts_live_dates_time_and_venue() -> None:
    url = "https://www.globalartslive.org/content/event_page/10407"
    page = (FIXTURES / "gal-event.html").read_text()
    [event] = jsonld.parse(page, base_url=url, options=GLOBAL_ARTS_LIVE)
    assert event.start == datetime(2026, 11, 19, 19, 30, tzinfo=TZ)
    assert event.venue_name == "Somerville Theatre"
    assert event.price is None
    assert event.ticket_url == "https://my.globalartslive.org/1590"
    theatre = VenueConfig(
        id="somerville-theatre",
        name="Somerville Theatre",
        town="Somerville",
        jazz_level="occasional",
    )
    assert Registry({theatre.id: theatre}, []).resolve_venue(event.venue_name) == theatre.id


def test_without_hints_bare_date_is_all_day() -> None:
    page = (FIXTURES / "gal-event.html").read_text()
    [event] = jsonld.parse(page, base_url="https://www.globalartslive.org/")
    assert event.all_day
    assert event.venue_name is None
    assert event.price == "$20"
    assert (
        event.ticket_url
        == "https://tickets.globalartslive.org/TheatreManager/1/online?performance="
    )


def test_groton_hill_start_and_ticket_link() -> None:
    url = "https://grotonhill.org/concerts/arturo-sandoval/"
    page = (FIXTURES / "groton-hill-event.html").read_text()
    [event] = jsonld.parse(page, base_url=url, options=GROTON_HILL)
    assert event.start == datetime(2027, 4, 23, 20, 0, tzinfo=TZ)
    assert event.end is None  # every event's endDate is 11:30 pm
    assert event.ticket_url == "https://ci.ovationtix.com/grotonhill/performance/11880261"
    assert event.url == url


def test_follows_list_pages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http_module, "MIN_INTERVAL", 0)

    def card(slug: str) -> str:
        return f'<a class="event" href="/shows/{slug}/">{slug}</a>'

    def show(name: str, day: int) -> str:
        return f"""<script type="application/ld+json">{{"@type": "Event",
          "name": "{name}", "startDate": "2026-11-{day:02}T20:00:00-05:00"}}</script>"""

    site = {
        "/jazz/": card("trio") + card("quartet") + '<a class="next" href="/jazz/page/2/">»</a>',
        "/jazz/page/2/": card("trio") + card("past") + '<a class="next" href="/jazz/">»</a>',
        "/shows/trio/": show("Fictional Trio", 6),
        "/shows/quartet/": show("Imaginary Quartet", 13),
        "/shows/past/": "<p>This concert is over.</p>",
    }
    fetched: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        fetched.append(request.url.path)
        return httpx.Response(200, text=site[request.url.path])

    source = Source(id="club", adapter="jsonld", url="https://club.test/jazz/")
    options = JsonLdOptions(follow="a.event", next_page="a.next")
    with Http(
        tmp_path / "cache",
        max_age=timedelta(hours=1),
        trusted_hosts={"club.test"},
        transport=httpx.MockTransport(handle),
    ) as http:
        events = jsonld.scrape(source, http, options)

    assert [e.title for e in events] == ["Fictional Trio", "Imaginary Quartet"]
    assert fetched == ["/jazz/", "/jazz/page/2/", "/shows/trio/", "/shows/quartet/", "/shows/past/"]


def test_html_in_title() -> None:
    page = """<script type="application/ld+json">{"@type": "Event",
      "name": "Pat Doe's <i>Days Off</i>",
      "startDate": "2026-11-06T19:30:00-05:00"}</script>"""
    [event] = jsonld.parse(page, base_url="https://x.example/")
    assert event.title == "Pat Doe's Days Off"


def test_unparseable_date_is_skipped() -> None:
    page = """<script type="application/ld+json">[
      {"@type": "Event", "name": "Bad", "startDate": "sometime soon"},
      {"@type": "Event", "name": "Good", "startDate": "2026-11-01T20:00:00-05:00"}
    ]</script>"""
    assert [e.title for e in jsonld.parse(page, base_url="https://x.example/")] == ["Good"]
