import json
from datetime import datetime
from pathlib import Path

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import clean, ics, is_cancelled, json_ld, jsonld, tribe, uncaps, unique_urls
from jazzcal.config import TZ

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


def test_clean_repairs_cp1252() -> None:
    assert clean("Fat n\x92  Gristle &amp; Co ") == "Fat n\u2019 Gristle & Co"
    assert clean("  ") is None


def test_uncaps() -> None:
    assert uncaps("PAT DOE'S COUNT-OFF (SOLO) - 10TH ANNUAL") == (
        "Pat Doe's Count-Off (Solo) - 10th Annual"
    )
    assert uncaps("Pat DOE and the B3 Kings") == "Pat DOE and the B3 Kings"


def test_is_cancelled() -> None:
    assert is_cancelled("Pat Doe Trio", "CANCELED: rescheduled to May")
    assert is_cancelled("Cancelled - Pat Doe Trio")
    assert not is_cancelled("Pat Doe Trio", "Cancellation policy: none")


def test_json_ld_skips_bad_blocks() -> None:
    page = """<script type="application/ld+json">{"@type": "Event"}</script>
    <script type="application/ld+json">{not json</script>
    <script type="application/ld+json">[1]</script>"""
    assert list(json_ld(HTMLParser(page))) == [{"@type": "Event"}, [1]]


def test_unique_urls() -> None:
    urls = ["/e/1", "https://club.example/e/1/", "/e/2/", "/e/2", "https://other.example/e/1"]
    assert unique_urls(urls, base_url="https://club.example/calendar") == [
        "https://club.example/e/1",
        "https://club.example/e/2/",
        "https://other.example/e/1",
    ]
