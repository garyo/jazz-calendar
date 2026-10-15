import json
from datetime import date, datetime
from pathlib import Path

from jazzcal.adapters import clean, ics, jsonld, recurring, tribe
from jazzcal.config import TZ
from jazzcal.models import Source

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 15, 6, tzinfo=TZ)


def test_ics_trumba_fields() -> None:
    events = ics.parse((FIXTURES / "nec.ics").read_text(), now=NOW)
    orchestra = next(e for e in events if e.title.startswith("NEC Jazz Orchestra: Blues"))
    assert orchestra.start == datetime(2026, 10, 22, 19, 30, tzinfo=TZ)
    assert orchestra.venue_name == "Plimpton Shattuck Black Box Theatre"
    assert orchestra.price == "Free - No ticket required"
    assert orchestra.url and orchestra.url.startswith("https://nec.trumba.com/")
    assert {"Concert", "Jazz"} <= set(orchestra.categories)
    assert all(not c.endswith("\\") for e in events for c in e.categories)


def test_ics_window_and_categories() -> None:
    events = ics.parse((FIXTURES / "armory.ics").read_text(), now=NOW)
    assert events
    assert all(NOW.date() <= e.start.date() for e in events)
    improv = next(e for e in events if e.title == "Atomic Comedy Indie Improv Night")
    assert improv.categories == ["Cafe", "Comedy"]
    assert len({e.uid for e in events}) == len(events)


def test_tribe() -> None:
    events = tribe.parse_page(json.loads((FIXTURES / "longy.json").read_text()))
    first = events[0]
    assert first.start == datetime(2026, 10, 15, 19, 0, tzinfo=TZ)
    assert first.venue_name == "Edward M. Pickman Concert Hall"
    assert "Main Stage" in first.categories
    assert first.price is None


def test_jsonld() -> None:
    page = """<html><head><script type="application/ld+json">
    {"@context": "https://schema.org", "@graph": [
      {"@type": "Organization", "name": "Club"},
      {"@type": "MusicEvent", "name": "Trio &amp; Friends",
       "startDate": "2026-10-20T20:00:00-04:00",
       "url": "/events/trio", "location": {"@type": "Place", "name": "The Club"},
       "offers": {"@type": "Offer", "price": "20", "url": "https://tix.example/1"},
       "performer": [{"@type": "MusicGroup", "name": "The Trio"}],
       "eventStatus": "https://schema.org/EventCancelled"},
      {"@type": "Event", "name": "Festival", "startDate": "2026-10-24"}
    ]}</script></head></html>"""
    trio, festival = jsonld.parse(page, base_url="https://club.example/calendar")
    assert trio.title == "Trio & Friends"
    assert trio.url == "https://club.example/events/trio"
    assert trio.price == "$20"
    assert trio.artists == ["The Trio"]
    assert trio.cancelled
    assert festival.all_day
    assert festival.start == datetime(2026, 10, 24, tzinfo=TZ)


def test_recurring_nth_weekday_across_dst() -> None:
    source = Source(
        id="jam",
        adapter="recurring",
        url="https://example.org",
        options={"title": "Jam", "days": ["fri"], "nth": [1, 3], "start": "17:00", "weeks": 6},
    )
    events = recurring.occurrences(source, date(2026, 10, 15))
    dates = [e.start.date() for e in events]
    assert dates == [date(2026, 10, 16), date(2026, 11, 6), date(2026, 11, 20)]
    # 5pm local both before and after the November DST change.
    assert {e.start.hour for e in events} == {17}
    assert events[0].start.utcoffset() != events[1].start.utcoffset()


def test_clean_repairs_cp1252() -> None:
    assert clean("Fat n\x92  Gristle &amp; Co ") == "Fat n\u2019 Gristle & Co"
    assert clean("  ") is None
