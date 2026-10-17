"""Leaving listings out on request: listings hidden on the site, and venues that opted out."""

from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from jazzcal import pipeline
from jazzcal.config import TZ, Registry, VenueConfig
from jazzcal.http import Http
from jazzcal.models import EventsFile, Regular, ScrapedEvent, Source
from jazzcal.site_registry import Hidden, SiteRegistry
from jazzcal.store import Store

NOW = datetime(2026, 10, 15, 12, tzinfo=TZ)
TONIGHT = date(2026, 10, 15)


def venue(id: str, **kw: object) -> VenueConfig:
    fields = {"id": id, "name": id.title(), "town": "Cambridge", "jazz_level": "dedicated"}
    return VenueConfig.model_validate(fields | kw)


def event(uid: str, title: str, **kw: object) -> ScrapedEvent:
    return ScrapedEvent.model_validate(
        {"uid": uid, "title": title, "start": NOW + timedelta(hours=8), "relevance": "jazz"} | kw
    )


def regular(venue: str, title: str) -> Regular:
    return Regular.model_validate(
        {"venue": venue, "title": title, "when": "Thursdays", "days": ["thu"],
         "relevance": "jazz", "url": "https://example.com", "checked": "2026-10-01"}
    )  # fmt: skip


def hidden(**kw: object) -> Hidden:
    return Hidden.model_validate({"requested": "2026-10-14"} | kw)


def source(id: str, venue: str | None = None) -> Source:
    return Source(id=id, adapter="fake", url="https://a", venue=venue)


def build(registry: Registry, store: Store, **found: list[ScrapedEvent]) -> EventsFile:
    for source_id, events in found.items():
        store.record_success(source_id, events)
    return pipeline.build(registry, store, NOW)[0]


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(tmp_path / "test.db")


def test_an_entry_must_say_which_listing() -> None:
    hidden(title="Fictional Quartet")
    hidden(venue="club", night="2026-11-07")
    for vague in ({"venue": "club"}, {"night": "2026-11-07"}, {}):
        with pytest.raises(ValidationError, match="needs a title, or a venue and a night"):
            hidden(**vague)


def test_hidden_listings_leave_every_source(store: Store) -> None:
    registry = Registry(
        {"club": venue("club"), "hall": venue("hall")},
        [source("s", "club"), source("agg")],
        hidden=[hidden(title="pat  example"), hidden(venue="hall", night=TONIGHT)],
    )
    feed = build(
        registry,
        store,
        s=[
            event("1", "Pat Example Trio"),
            event("2", "Fictional Quartet"),
            event("5", "Pat Examples of Swing"),  # not the same words
        ],
        agg=[
            event("1", "Pat Example Trio", venue_name="Club"),
            event("3", "Anything at all", venue_name="Hall"),
            event("4", "Next week", venue_name="Hall", start=NOW + timedelta(days=7)),
        ],
    )
    assert sorted(e.title for e in feed.events) == [
        "Fictional Quartet",
        "Next week",
        "Pat Examples of Swing",
    ]


def test_a_performer_entry_hides_their_regular_too(store: Store) -> None:
    registry = Registry(
        {"club": venue("club")},
        [],
        regulars=[regular("club", "Pat Example and Friends"), regular("club", "Open Jam")],
        hidden=[hidden(title="Pat Example"), hidden(title="Open Jam", night=TONIGHT)],
    )
    assert [r.title for r in build(registry, store).regulars] == ["Open Jam"]


def test_an_opted_out_venue_leaves_the_feed(store: Store, tmp_path: Path) -> None:
    registry = Registry(
        {"club": venue("club"), "gone": venue("gone", opted_out="2026-10-14")},
        [source("own", "gone"), source("agg")],
        regulars=[regular("gone", "Weekly Jam")],
    )
    feed = build(
        registry,
        store,
        own=[event("1", "Their gig")],
        agg=[event("2", "Their gig", venue_name="Gone"), event("3", "Elsewhere", venue="club")],
    )
    assert [e.title for e in feed.events] == ["Elsewhere"]
    assert [v.id for v in feed.venues] == ["club"]
    assert feed.regulars == []

    fetched: list[str] = []

    def adapter(source: Source, http: Http) -> list[ScrapedEvent]:
        fetched.append(source.id)
        return []

    with pytest.MonkeyPatch.context() as mp, Http(tmp_path, max_age=timedelta(0)) as http:
        mp.setattr(pipeline, "get_adapter", lambda name: adapter)
        pipeline.scrape(registry, store, http, now=NOW)
    assert fetched == ["agg"]  # its own source isn't even fetched


def test_a_site_venue_matching_one_that_opted_out_is_skipped(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    venues = [
        {"id": "lilypad", "name": "The Lilypad", "address": "1353 Cambridge St",
         "town": "Cambridge", "jazz_level": "dedicated", "opted_out": "2026-10-14"},
        {"id": "club", "name": "Club", "town": "Cambridge", "jazz_level": "dedicated"},
    ]  # fmt: skip
    for name, items in (("venues", venues), ("sources", []), ("regulars", [])):
        (tmp_path / f"{name}.yaml").write_text(yaml.safe_dump(items))
    added = SiteRegistry.model_validate(
        {"venues": [
            {"id": "lily-pad", "name": "Lilypad", "town": "Cambridge", "jazz_level": "regular"},
            {"id": "pad-two", "name": "Another Name", "address": "1353 Cambridge Street",
             "town": "Cambridge", "jazz_level": "regular"},
            {"id": "new-room", "name": "New Room", "town": "Boston", "jazz_level": "regular"},
        ]}
    )  # fmt: skip
    registry = Registry.load(tmp_path, added)
    assert list(registry.venues) == ["lilypad", "club", "new-room"]
    assert "skipping site venue lily-pad: it matches a venue that opted out" in caplog.text
    assert "skipping site venue pad-two" in caplog.text


def test_titles_match_whole_words_literally() -> None:
    entry = hidden(title="C.J. (Trio)")
    assert entry.matches("club", "The C.J. (Trio) live", None)
    assert not entry.matches("club", "CXJX (Trio)", None)


def test_the_site_supplies_hidden_listings(tmp_path: Path) -> None:
    venues = [{"id": "club", "name": "Club", "town": "Cambridge", "jazz_level": "dedicated"}]
    for name, items in (("venues", venues), ("sources", []), ("regulars", [])):
        (tmp_path / f"{name}.yaml").write_text(yaml.safe_dump(items))
    added = SiteRegistry.model_validate(
        {"hidden": [{"title": "Pat Example", "venue": None, "night": None,
                     "requested": "2026-10-14"}]}
    )  # fmt: skip
    registry = Registry.load(tmp_path, added)
    assert registry.withheld("club", "Pat Example Trio", TONIGHT)
    assert not registry.withheld("club", "Fictional Quartet", TONIGHT)


def test_the_data_files_load() -> None:
    Registry.load()
