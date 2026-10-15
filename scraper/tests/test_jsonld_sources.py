"""The jsonld adapter's page-hint options, against real pages from the sources using them."""

from datetime import datetime
from pathlib import Path

from jazzcal.adapters import jsonld
from jazzcal.config import TZ, Registry

FIXTURES = Path(__file__).parent / "fixtures"


def options(source_id: str) -> dict:
    return Registry.load().source(source_id).options


def test_hobgoblin_time_from_page() -> None:
    url = "https://www.hobgoblinbar.com/event/129-siha-han-solo-piano-vocals/"
    page = (FIXTURES / "hobgoblin-event.html").read_text()
    [event] = jsonld.parse(page, base_url=url, options=options("hobgoblin"))
    assert event.title == "Siha Han (solo piano & vocals)"
    assert not event.all_day
    assert event.start == datetime(2026, 10, 15, 19, 0, tzinfo=TZ)
    assert event.end == datetime(2026, 10, 15, 23, 0, tzinfo=TZ)


def test_global_arts_live_dates_time_and_venue() -> None:
    url = "https://www.globalartslive.org/content/event_page/10407"
    page = (FIXTURES / "gal-event.html").read_text()
    [event] = jsonld.parse(page, base_url=url, options=options("global-arts-live"))
    assert event.start == datetime(2026, 11, 19, 19, 30, tzinfo=TZ)
    assert event.venue_name == "Somerville Theatre"
    assert event.price is None
    assert Registry.load().resolve_venue(event.venue_name) == "somerville-theatre"


def test_without_hints_bare_date_is_all_day() -> None:
    page = (FIXTURES / "gal-event.html").read_text()
    [event] = jsonld.parse(page, base_url="https://www.globalartslive.org/")
    assert event.all_day
    assert event.venue_name is None
    assert event.price == "$20"


def test_html_in_title() -> None:
    page = """<script type="application/ld+json">{"@type": "Event",
      "name": "Warren Miller's <i>Days Off</i>",
      "startDate": "2026-11-06T19:30:00-05:00"}</script>"""
    [event] = jsonld.parse(page, base_url="https://x.example/")
    assert event.title == "Warren Miller's Days Off"


def test_unparseable_date_is_skipped() -> None:
    page = """<script type="application/ld+json">[
      {"@type": "Event", "name": "Bad", "startDate": "sometime soon"},
      {"@type": "Event", "name": "Good", "startDate": "2026-11-01T20:00:00-05:00"}
    ]</script>"""
    assert [e.title for e in jsonld.parse(page, base_url="https://x.example/")] == ["Good"]
