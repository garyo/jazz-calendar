"""The jsonld adapter's page-hint options, against real pages from the sources using them."""

from datetime import datetime
from pathlib import Path

from jazzcal.adapters import jsonld
from jazzcal.config import TZ, Registry, VenueConfig
from jazzcal.models import Source

FIXTURES = Path(__file__).parent / "fixtures"

HOBGOBLIN = {"time_selector": "article h1 + p"}
GLOBAL_ARTS_LIVE = {
    "time_selector": ".date-display-single",
    "venue_selector": 'meta[property="og:title"]',
    "venue_pattern": r"\bat ((?:(?! at ).)+)$",
    "no_price": True,
}


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
