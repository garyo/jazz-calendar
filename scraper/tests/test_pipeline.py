import hashlib
import re
from collections.abc import Iterator
from datetime import date, datetime, timedelta
from pathlib import Path

import icalendar
import pytest
import yaml
from pydantic import ValidationError

from jazzcal import pipeline
from jazzcal import store as store_module
from jazzcal.classify import Ruling, classify, tags
from jazzcal.config import TZ, Registry, VenueConfig, address_key, night_of
from jazzcal.export import to_ics
from jazzcal.http import Http, redact
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
        ("The Outskirts", "dedicated", "jazz"),
        ("Big Band Monday", "occasional", "jazz"),
        ("Dub Collective: funk night", "occasional", "adjacent"),
        ("Indie Rock Showcase", "occasional", "other"),
    ],
)
def test_classify(title: str, level: str, expected: str) -> None:
    source = Source(id="s", adapter="ics", url="https://x")
    assert classify(event("1", title), source, venue("v", level)).relevance == expected


def test_classify_include_pattern() -> None:
    source = Source(id="s", adapter="ics", url="https://x", include="Jazz")
    v = venue("v")
    assert classify(event("1", "Recital", categories=["Piano"]), source, v).relevance == "other"
    assert classify(event("2", "Recital", categories=["Jazz"]), source, v).relevance == "jazz"


def test_classify_descriptions() -> None:
    source = Source(id="s", adapter="ics", url="https://x")
    trusting = Source(id="t", adapter="ics", url="https://x", trust_text=True)
    gig = event("1", "Kim Doe", text="The jazz vocalist returns")
    assert classify(gig, source, venue("v")).relevance == "other"
    assert classify(gig, trusting, venue("v")).relevance == "jazz"
    assert classify(gig, source, venue("v", "regular")).relevance == "jazz"
    late = event("2", "Late Night Set", text="Funk and soul till close")
    assert classify(late, source, venue("v", "regular")).relevance == "adjacent"
    assert classify(event("3", "Brunch & Jam"), source, venue("v", "regular")).relevance == "jazz"
    assert classify(event("4", "Lee Poe Trio"), source, venue("v", "regular")).relevance == "jazz"
    assert (
        classify(event("5", "Fictional String Quartet"), source, venue("v", "regular")).relevance
        == "other"
    )


def test_unknown_option() -> None:
    source = Source(id="s", adapter="ics", url="https://x", unknown="adjacent")
    ruling = classify(event("1", "Dana Moe"), source, venue("v", "regular"))
    assert ruling == Ruling("adjacent", False)


def test_classify_certainty() -> None:
    source = Source(id="s", adapter="ics", url="https://x")
    assert classify(event("1", "Big Band Monday"), source, venue("v")).certain
    assert classify(event("2", "Trivia"), source, venue("v")).certain
    assert classify(event("3", "Anyone"), source, venue("v", "dedicated")).certain
    assert not classify(event("4", "Jean-Luc Poe"), source, venue("v")).certain
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


def at(text: str, **kw: object) -> ScrapedEvent:
    return ScrapedEvent.model_validate({"uid": "x", "title": "Set", "start": text, **kw})


@pytest.mark.parametrize(
    ("start", "night"),
    [
        ("2026-10-16T23:30:00-04:00", "2026-10-16"),
        ("2026-10-17T00:00:00-04:00", "2026-10-16"),  # "12a": Friday's late set
        ("2026-10-17T03:59:00-04:00", "2026-10-16"),
        ("2026-10-17T04:00:00-04:00", "2026-10-17"),  # the cutoff starts a new night
        ("2026-10-17T07:30:00Z", "2026-10-16"),  # 3:30 am local
        # The end of DST: 1:30 am comes twice, and 4 am is still the cutoff.
        ("2026-11-01T01:30:00-04:00", "2026-10-31"),
        ("2026-11-01T01:30:00-05:00", "2026-10-31"),
        ("2026-11-01T03:30:00-05:00", "2026-10-31"),
        ("2026-11-01T04:00:00-05:00", "2026-11-01"),
        # The start of DST: 2-3 am is skipped.
        ("2027-03-14T03:30:00-04:00", "2027-03-13"),
        ("2027-03-14T04:00:00-04:00", "2027-03-14"),
    ],
)
def test_night_of(start: str, night: str) -> None:
    assert night_of(at(start)) == date.fromisoformat(night)


def test_night_of_all_day_keeps_its_date() -> None:
    assert night_of(at("2026-10-17T00:00:00-04:00", all_day=True)) == date(2026, 10, 17)


def test_build_merges_a_late_set_listed_either_side_of_midnight(store: Store) -> None:
    sources = [
        Source(id="venue-site", adapter="ics", url="https://a", venue="club"),
        Source(id="aggregator", adapter="ics", url="https://b", venue="club"),
    ]
    registry = Registry({"club": venue("club", "dedicated")}, sources)
    store.record_success("venue-site", [event("a1", "Midnight Hour", hours=12.25)])
    store.record_success("aggregator", [event("b1", "The Midnight Hour", hours=11.75)])
    feed, _ = pipeline.build(registry, store, NOW)
    assert [(e.title, e.sources) for e in feed.events] == [
        ("Midnight Hour", ["venue-site", "aggregator"])
    ]


@pytest.fixture
def ticking_store(store: Store, monkeypatch: pytest.MonkeyPatch) -> Store:
    """A store whose clock moves a minute with each reading, so first_seen orders listings."""
    minutes = iter(range(10_000))
    monkeypatch.setattr(
        store_module, "_now", lambda: (NOW + timedelta(minutes=next(minutes))).isoformat()
    )
    return store


def ids(registry: Registry, store: Store) -> dict[tuple[str, ...], str]:
    """Published event ids by the sources listing each event."""
    feed, _ = pipeline.build(registry, store, NOW)
    return {tuple(e.sources): e.id for e in feed.events}


def derived_id(source: str, uid: str) -> str:
    return hashlib.sha1(f"{source}|{uid}".encode()).hexdigest()[:12]


def club_registry() -> Registry:
    sources = [
        Source(id="venue-site", adapter="ics", url="https://a", venue="club"),
        Source(id="aggregator", adapter="ics", url="https://b", venue="club"),
    ]
    return Registry({"club": venue("club", "dedicated")}, sources)


def test_event_ids_hold_as_sources_come_and_go(ticking_store: Store) -> None:
    store, registry = ticking_store, club_registry()
    store.record_success("aggregator", [event("b1", "Pat Doe Quartet")])
    first_id = derived_id("aggregator", "b1")
    assert ids(registry, store) == {("aggregator",): first_id}
    # The venue's own listing now leads, but the event keeps its id...
    store.record_success("venue-site", [event("a1", "Pat Doe Quartet")])
    assert ids(registry, store) == {("venue-site", "aggregator"): first_id}
    # ...and keeps it when the aggregator drops it.
    for _ in range(2):
        store.record_success("aggregator", [])
    assert ids(registry, store) == {("venue-site",): first_id}


def test_split_events_get_distinct_ids(ticking_store: Store) -> None:
    store, registry = ticking_store, club_registry()
    store.record_success("aggregator", [event("b1", "Pat Doe Quartet")])
    ids(registry, store)
    store.record_success("venue-site", [event("a1", "Pat Doe Quartet")])
    assert ids(registry, store) == {("venue-site", "aggregator"): derived_id("aggregator", "b1")}
    # The listings no longer match: the older keeps the id, the other gets its own.
    store.record_success("venue-site", [event("a1", "Pat Doe Quartet", hours=10)])
    split = {
        ("venue-site",): derived_id("venue-site", "a1"),
        ("aggregator",): derived_id("aggregator", "b1"),
    }
    assert ids(registry, store) == split
    assert ids(registry, store) == split


def test_missing_listings_drop_after_two_runs(store: Store) -> None:
    source = Source(id="s", adapter="ics", url="https://a", venue="club")
    registry = Registry({"club": venue("club", "dedicated")}, [source])
    store.record_success("s", [event("1", "Gig")])
    for expected in (1, 1, 0):
        assert len(pipeline.build(registry, store, NOW)[0].events) == expected
        store.record_success("s", [])


class Scraper:
    """Runs pipeline.scrape with each source yielding what `found` holds for it."""

    def __init__(self, registry: Registry, store: Store, http: Http) -> None:
        self.registry, self.store, self.http = registry, store, http
        self.found: dict[str, list[ScrapedEvent]] = {}

    def __call__(self, now: datetime = NOW, **found: list[ScrapedEvent]) -> None:
        self.found = found
        pipeline.scrape(self.registry, self.store, self.http, now=now)

    def adapter(self, source: Source, http: Http) -> list[ScrapedEvent]:
        return self.found[source.id]


@pytest.fixture
def scrape(store: Store, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Scraper]:
    sources = [Source(id=id, adapter="fake", url="https://a", venue="club") for id in ("s", "t")]
    registry = Registry({"club": venue("club", "dedicated")}, sources)
    with Http(tmp_path / "cache", offline=True, max_age=timedelta(hours=6)) as http:
        scraper = Scraper(registry, store, http)
        monkeypatch.setattr(pipeline, "get_adapter", lambda name: scraper.adapter)
        yield scraper


def test_empty_run_after_a_full_one_is_a_failure(scrape: Scraper, store: Store) -> None:
    scrape(s=[event("1", "Gig"), event("2", "Old Gig", hours=-30)], t=[])
    for _ in range(3):
        scrape(s=[], t=[])
        feed, status = pipeline.build(scrape.registry, store, NOW)
        assert [e.title for e in feed.events] == ["Gig"]
        by_id = {s.id: s for s in status.sources}
        assert not by_id["s"].ok
        assert by_id["s"].error == "0 events (had 1 upcoming last run)"
        # A source that had nothing last time either is fine.
        assert by_id["t"].ok


def test_scrape_rewrites_titles(scrape: Scraper, store: Store) -> None:
    scrape.registry.sources[0] = Source(
        id="s", adapter="fake", url="https://a", venue="club", title_strip="^10/16 |^Doors$"
    )
    scrape(s=[event("1", "10/16 Pat Doe Trio"), event("2", "Doors")], t=[])
    assert [e.title for e in store.current("s")] == ["Pat Doe Trio"]


def test_empty_run_after_past_events_is_a_success(scrape: Scraper, store: Store) -> None:
    scrape(s=[event("1", "Gig")], t=[])
    scrape(now=NOW + timedelta(days=1), s=[], t=[])
    status = store.status("s")
    assert status and status.ok


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
        days=["tue"],
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
    ("settings", "error"),
    [
        ({"adapter": "nope"}, "no adapter 'nope'; known: bentobox, "),
        ({"adapter": "jsonld", "options": {"folow": "a"}}, "folow\n  Extra inputs"),
        ({"adapter": "jsonld", "options": {"follow": "a[["}}, "bad CSS selector"),
        ({"adapter": "jsonld", "options": {"max_follow": "many"}}, "max_follow\n"),
        ({"adapter": "ticketmaster"}, "venue_id\n  Field required"),
        ({"adapter": "ics", "options": {"include": "Jazz"}}, "include\n  Extra inputs"),
        ({"adapter": "ics", "exclude": "(Jazz"}, "bad regular expression '(Jazz'"),
        ({"adapter": "ics", "unknown": "maybe"}, "unknown\n"),
    ],
)
def test_bad_sources_fail_to_load(tmp_path: Path, settings: dict, error: str) -> None:
    write_registry(tmp_path, [{"id": "s", "url": "https://a", "enabled": False, **settings}])
    with pytest.raises(ValueError, match=f"^source 's'(?s:.*){re.escape(error)}"):
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


def test_secrets_are_redacted_from_errors() -> None:
    url = "https://api.example.com/events.json?venueId=1&apikey=s3cret&size=100&token=t0k"
    assert redact(f"HTTP 504 for {url}") == (
        "HTTP 504 for https://api.example.com/events.json?venueId=1&apikey=REDACTED"
        "&size=100&token=REDACTED"
    )
    assert redact("nothing to hide?page=2") == "nothing to hide?page=2"
