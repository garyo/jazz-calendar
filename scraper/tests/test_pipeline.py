from datetime import date, datetime, timedelta
from pathlib import Path

import icalendar
import pytest
import yaml
from pydantic import ValidationError

from jazzcal import pipeline
from jazzcal.classify import Ruling, classify, tags
from jazzcal.config import TZ, Registry, VenueConfig, address_key
from jazzcal.export import to_ics
from jazzcal.llm import Question, Verdict
from jazzcal.models import Credit, EventsFile, Regular, ScrapedEvent, Source
from jazzcal.store import Store

NOW = datetime(2026, 10, 15, 12, tzinfo=TZ)


def venue(id: str, level: str = "occasional", **kw: object) -> VenueConfig:
    return VenueConfig.model_validate(
        {"id": id, "name": id.title(), "town": "Cambridge", "jazz_level": level, **kw}
    )


def event(uid: str, title: str, hours: float = 8, **kw: object) -> ScrapedEvent:
    return ScrapedEvent.model_validate(
        {"uid": uid, "title": title, "start": NOW + timedelta(hours=hours), **kw}
    )


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(tmp_path / "test.db")


def test_address_key() -> None:
    assert address_key("265 Massachusetts Avenue, Cambridge, MA 02139") == "265 mass cambridge"
    assert address_key("265 Mass Ave, Cambridge") == "265 mass cambridge"
    assert address_key("One Bennett Street, Cambridge, MA 02138") == "1 bennett cambridge"
    assert address_key("The Fed, Boston, MA") is None


def test_resolve_venue() -> None:
    registry = Registry(
        {
            "lilypad": venue("lilypad", aliases=["Lily Pad"], address="1353 Cambridge St"),
            "nec": venue("nec", name="New England Conservatory", aliases=["Jordan Hall"]),
        },
        [],
    )
    assert registry.resolve_venue("The Lily Pad") == "lilypad"
    assert registry.resolve_venue("1353 Cambridge Street, Cambridge, MA 02139") == "lilypad"
    assert registry.resolve_venue("Jordan Hall at NEC") == "nec"
    assert registry.resolve_venue("Somewhere Else") is None


@pytest.mark.parametrize(
    ("title", "level", "expected"),
    [
        ("Trivia Night", "dedicated", "other"),
        ("The Fringe", "dedicated", "jazz"),
        ("Big Band Monday", "occasional", "jazz"),
        ("Dub Apocalypse: funk night", "occasional", "adjacent"),
        ("Indie Rock Showcase", "occasional", "other"),
    ],
)
def test_classify(title: str, level: str, expected: str) -> None:
    source = Source(id="s", adapter="ics", url="https://x")
    assert classify(event("1", title), source, venue("v", level)).relevance == expected


def test_classify_include_pattern() -> None:
    source = Source(id="s", adapter="ics", url="https://x", options={"include": "Jazz"})
    v = venue("v")
    assert classify(event("1", "Recital", categories=["Piano"]), source, v).relevance == "other"
    assert classify(event("2", "Recital", categories=["Jazz"]), source, v).relevance == "jazz"


def test_classify_descriptions() -> None:
    source = Source(id="s", adapter="ics", url="https://x")
    trusting = Source(id="t", adapter="ics", url="https://x", options={"trust_text": True})
    gig = event("1", "Kurt Elling", text="The jazz vocalist returns")
    assert classify(gig, source, venue("v")).relevance == "other"
    assert classify(gig, trusting, venue("v")).relevance == "jazz"
    assert classify(gig, source, venue("v", "regular")).relevance == "jazz"
    late = event("2", "Late Night Set", text="Funk and soul till close")
    assert classify(late, source, venue("v", "regular")).relevance == "adjacent"
    assert classify(event("3", "Brunch & Jam"), source, venue("v", "regular")).relevance == "jazz"
    assert (
        classify(event("4", "Elan Mehler Trio"), source, venue("v", "regular")).relevance == "jazz"
    )
    assert (
        classify(event("5", "Brentano String Quartet"), source, venue("v", "regular")).relevance
        == "other"
    )


def test_unknown_option() -> None:
    source = Source(id="s", adapter="ics", url="https://x", options={"unknown": "adjacent"})
    ruling = classify(event("1", "Dana Moe"), source, venue("v", "regular"))
    assert ruling == Ruling("adjacent", False)


def test_classify_certainty() -> None:
    source = Source(id="s", adapter="ics", url="https://x")
    assert classify(event("1", "Big Band Monday"), source, venue("v")).certain
    assert classify(event("2", "Trivia"), source, venue("v")).certain
    assert classify(event("3", "Anyone"), source, venue("v", "dedicated")).certain
    assert not classify(event("4", "Jean-Luc Ponty"), source, venue("v")).certain
    assert not classify(event("5", "Funk Night"), source, venue("v")).certain


def test_event_relevance_outranks_rules() -> None:
    source = Source(id="s", adapter="submissions", url="https://x")
    reviewed = event("1", "Karaoke Night", relevance="adjacent")
    assert classify(reviewed, source, venue("v")) == Ruling("adjacent", True)


def test_unknown_venue_id_is_skipped(store: Store) -> None:
    source = Source(id="s", adapter="submissions", url="https://a")
    registry = Registry({"club": venue("club")}, [source])
    store.record_success(
        "s",
        [
            event("1", "Pat Doe Quartet", venue="club", relevance="jazz"),
            event("2", "Dana Moe Trio", venue="gone", relevance="jazz"),
        ],
    )
    feed, _ = pipeline.build(registry, store, NOW)
    assert [(e.title, e.relevance) for e in feed.events] == [("Pat Doe Quartet", "jazz")]


def test_tags() -> None:
    assert tags(event("1", "Sunday Jazz Brunch", price="Free")) == ["brunch", "free"]
    assert tags(event("2", "Recital: Pat Doe '27 MM, Jazz Piano")) == ["student"]
    assert tags(event("3", "Faculty Recital: Pat Doe")) == []


def test_build_dedups_and_prefers_earlier_source(store: Store) -> None:
    sources = [
        Source(id="venue-site", adapter="ics", url="https://a", venue="club"),
        Source(id="aggregator", adapter="ics", url="https://b"),
    ]
    registry = Registry({"club": venue("club", "dedicated", aliases=["The Club"])}, sources)
    store.record_success("venue-site", [event("a1", "Pat Doe Quartet")])
    store.record_success(
        "aggregator",
        [
            event(
                "b1",
                "Pat Doe Quartet (album release)",
                hours=8.5,
                venue_name="The Club",
                ticket_url="https://tix",
            ),
            event("b2", "Another Band", hours=8, venue_name="The Club"),
            event("b3", "Lost Venue", venue_name="Nowhere"),
        ],
    )
    feed, status = pipeline.build(registry, store, NOW)
    titles = {e.title: e for e in feed.events}
    assert set(titles) == {"Pat Doe Quartet", "Another Band"}
    merged = titles["Pat Doe Quartet"]
    assert merged.sources == ["venue-site", "aggregator"]
    assert merged.ticket_url == "https://tix"
    assert [s.id for s in status.sources] == ["venue-site", "aggregator"]


def test_missing_listings_drop_after_two_runs(store: Store) -> None:
    source = Source(id="s", adapter="ics", url="https://a", venue="club")
    registry = Registry({"club": venue("club", "dedicated")}, [source])
    store.record_success("s", [event("1", "Gig")])
    for expected in (1, 1, 0):
        assert len(pipeline.build(registry, store, NOW)[0].events) == expected
        store.record_success("s", [])


def test_failed_source_keeps_last_listings(store: Store) -> None:
    source = Source(id="s", adapter="ics", url="https://a", venue="club")
    registry = Registry({"club": venue("club", "dedicated")}, [source])
    store.record_success("s", [event("1", "Gig")])
    store.record_failure("s", "HTTP 504")
    feed, status = pipeline.build(registry, store, NOW)
    assert len(feed.events) == 1
    assert status.sources[0].error == "HTTP 504"


class FakeClassifier:
    name = "fake"

    def __init__(self, answers: dict[str, Verdict]) -> None:
        self.answers = answers
        self.asked: list[str] = []

    def classify(self, questions: list[Question]) -> dict[str, Verdict]:
        self.asked += [q.title for q in questions]
        return {q.id: self.answers[q.title] for q in questions if q.title in self.answers}


def test_classifier_leans_toward_keeping_listings(store: Store) -> None:
    source = Source(id="s", adapter="ics", url="https://a", venue="room")
    registry = Registry({"room": venue("room", "regular")}, [source])
    store.record_success(
        "s",
        [
            event("1", "Pat Doe Trio", hours=1),
            event("2", "Riley Roe Trio", hours=2),
            event("3", "Film Night Trio", hours=3),
            event("4", "Sam Poe", hours=4),
            event("5", "Big Band Monday", hours=5),
        ],
    )
    classifier = FakeClassifier(
        {
            "Pat Doe Trio": Verdict(relevance="unknown", confidence=0.5, reason="local act"),
            "Riley Roe Trio": Verdict(relevance="other", confidence=0.6, reason="unsure"),
            "Film Night Trio": Verdict(relevance="other", confidence=0.95, reason="a film"),
            "Sam Poe": Verdict(relevance="jazz", confidence=0.7, reason="jazz saxophonist"),
        }
    )
    feed, _ = pipeline.build(registry, store, NOW, classifier)
    assert {e.title for e in feed.events} == {
        "Pat Doe Trio",
        "Riley Roe Trio",
        "Sam Poe",
        "Big Band Monday",
    }
    # Certain rulings aren't sent, and verdicts are cached.
    assert sorted(classifier.asked) == [
        "Film Night Trio",
        "Pat Doe Trio",
        "Riley Roe Trio",
        "Sam Poe",
    ]
    pipeline.build(registry, store, NOW, classifier)
    assert len(classifier.asked) == 4


def test_regulars_are_published_apart_from_events(store: Store) -> None:
    regular = Regular(
        venue="club",
        title="Jam session",
        when="Tuesdays, 7-9 pm",
        relevance="jazz",
        url="https://club.example/",
        checked=date(2026, 10, 15),
    )
    registry = Registry({"club": venue("club", "dedicated")}, [], [regular])
    feed, _ = pipeline.build(registry, store, NOW)
    assert feed.events == []
    assert feed.regulars == [regular]


def test_ics_uses_named_timezone(store: Store) -> None:
    source = Source(id="s", adapter="ics", url="https://a", venue="club")
    registry = Registry({"club": venue("club", "dedicated")}, [source])
    store.record_success("s", [event("1", "Gig")])
    feed, _ = pipeline.build(registry, store, NOW)
    roundtripped = EventsFile.model_validate_json(feed.model_dump_json())
    ics = to_ics(roundtripped).decode()
    assert "DTSTART;TZID=America/New_York:20261015T200000" in ics
    assert "BEGIN:VTIMEZONE" in ics


def write_registry(data_dir: Path, sources: list[dict]) -> None:
    venues = [{"id": "club", "name": "Club", "town": "Cambridge", "jazz_level": "dedicated"}]
    for name, items in (("venues", venues), ("sources", sources), ("regulars", [])):
        (data_dir / f"{name}.yaml").write_text(yaml.safe_dump(items))


def test_enabled_sources_need_a_credit(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        [
            {"id": "off", "adapter": "ics", "url": "https://a", "enabled": False},
            {"id": "on", "adapter": "ics", "url": "https://b", "credit": {"name": "B", "url": "https://b"}},
        ],
    )  # fmt: skip
    assert Registry.load(tmp_path).source("on").credit == Credit(name="B", url="https://b")
    write_registry(tmp_path, [{"id": "on", "adapter": "ics", "url": "https://b"}])
    with pytest.raises(ValueError, match="needs a credit"):
        Registry.load(tmp_path)


@pytest.mark.parametrize(
    "credit", [{"name": "", "url": "https://b"}, {"name": "B", "url": "http://b"}, {"name": "B"}]
)
def test_credit_needs_a_name_and_https_url(credit: dict) -> None:
    with pytest.raises(ValidationError):
        Credit.model_validate(credit)


def credited_sources() -> list[Source]:
    return [
        Source(id="own", adapter="ics", url="https://a", venue="club",
               credit=Credit(name="Club calendar", url="https://club.example/")),
        Source(id="tm", adapter="ticketmaster", url="https://api", venue="club",
               credit=Credit(name="Ticketmaster", url="https://www.ticketmaster.com", via=True)),
        Source(id="idle", adapter="ics", url="https://c", venue="club",
               credit=Credit(name="Idle", url="https://idle.example/")),
    ]  # fmt: skip


def test_feed_credits_the_sources_it_lists(store: Store) -> None:
    registry = Registry({"club": venue("club", "dedicated")}, credited_sources())
    store.record_success("own", [event("1", "Pat Doe Quartet")])
    store.record_success("tm", [event("2", "Pat Doe Quartet"), event("3", "Lee Roe Trio")])
    store.record_success("idle", [])
    feed, _ = pipeline.build(registry, store, NOW)
    assert {e.title: e.sources for e in feed.events} == {
        "Pat Doe Quartet": ["own", "tm"],
        "Lee Roe Trio": ["tm"],
    }
    assert [(s.id, s.name, s.via) for s in feed.sources] == [
        ("own", "Club calendar", False),
        ("tm", "Ticketmaster", True),
    ]


def test_ics_credits_third_party_sources(store: Store) -> None:
    registry = Registry({"club": venue("club", "dedicated")}, credited_sources())
    store.record_success("own", [event("1", "Pat Doe Quartet")])
    store.record_success("tm", [event("2", "Lee Roe Trio", hours=30)])
    feed, _ = pipeline.build(registry, store, NOW)
    ics = icalendar.Calendar.from_ical(to_ics(feed))
    described = {
        str(v["summary"]): (str(v["uid"]), str(v["description"])) for v in ics.walk("VEVENT")
    }
    by_title = {e.title: e for e in feed.events}
    uid, description = described["Lee Roe Trio @ Club"]
    assert uid == f"{by_title['Lee Roe Trio'].id}@bostonjazzcalendar.com"
    assert description.endswith("Listing via Ticketmaster: https://www.ticketmaster.com")
    assert "via" not in described["Pat Doe Quartet @ Club"][1]
