from datetime import datetime, timedelta

import pytest
from pydantic import ValidationError

from jazzcal.config import TZ
from jazzcal.models import Event, ScrapedEvent, Source

START = datetime(2026, 10, 15, 20, tzinfo=TZ)


def scraped(**kw: object) -> ScrapedEvent:
    return ScrapedEvent.model_validate({"uid": "1", "title": "Gig", "start": START, **kw})


def published(**kw: object) -> Event:
    return Event.model_validate(
        {"id": "x", "title": "Gig", "start": START, "venue": "club", "relevance": "jazz",
         "sources": ["s"], "url": "https://club.example/gig", **kw}
    )  # fmt: skip


@pytest.mark.parametrize(
    "url", ["javascript:alert(1)", "mailto:box@club.example", "data:text/html,hi", "/relative"]
)
def test_scraped_event_drops_non_web_links(url: str) -> None:
    event = scraped(url=url, ticket_url=url)
    assert event.url is None
    assert event.ticket_url is None


def test_scraped_event_keeps_web_links() -> None:
    event = scraped(url="https://club.example/gig", ticket_url="HTTP://tix.example/1")
    assert event.url == "https://club.example/gig"
    assert event.ticket_url == "HTTP://tix.example/1"


def test_scraped_event_drops_an_end_that_is_not_after_the_start() -> None:
    later = START + timedelta(hours=2)
    assert scraped(end=later).end == later
    assert scraped(end=START).end is None
    assert scraped(end=START - timedelta(hours=1)).end is None
    assert scraped(end=later, all_day=True).end is None


def test_event_needs_a_web_url() -> None:
    assert published(ticket_url="javascript:void(0)").ticket_url is None
    with pytest.raises(ValidationError):
        published(url="javascript:void(0)")


# The title rewrites of sources in data/sources.yaml, at the time of writing.
STAGE = {"title_strip": r"^(MAIN|STUDIO|BACK) STAGE\s*[|:]\s*"}
MONKFISH = {
    "title_strip": r"^\d{1,2}/\d{1,2}\s+|\s*\(?\b\d{1,2}(:\d{2})?\s*([ap]m)?\s*-\s*\d{1,2}(:\d{2})?"
    r"\s*[ap]m\)?|\s+\d{1,2}(:\d{2})?\s*[ap]m\b|\s*\(Mad Monkfish Concert Series\)"
}
DATE = {"title_strip": r"^\d{1,2}/\d{1,2}\s+"}
ON_SALE = {"title_strip": "\\s*[-\u2013]\\s*tickets? on sale.*$"}
CABOT = {
    "title_strip": r"\s+'\d\d\s*$",
    "title_replace": [{"pattern": "^OC: ", "with": "Off Cabot: "}],
}


@pytest.mark.parametrize(
    ("rewrites", "title", "expected"),
    [
        (STAGE, "MAIN STAGE | Pat Doe", "Pat Doe"),
        (STAGE, "Studio Stage: Pat Doe", "Pat Doe"),
        (MONKFISH, "10/16 Pat Doe Trio (7-10pm)", "Pat Doe Trio"),
        (MONKFISH, "Pat Doe Trio 8:30 PM", "Pat Doe Trio"),
        (MONKFISH, "Pat Doe (Mad Monkfish Concert Series)", "Pat Doe"),
        (DATE, "10/15 Pat Doe (solo piano)", "Pat Doe (solo piano)"),
        (ON_SALE, "Pat Doe - Tickets On Sale Friday", "Pat Doe"),
        (CABOT, "OC: The Fictionals '26", "Off Cabot: The Fictionals"),
        ({"title_replace": [{"pattern": r"^(\w+) Doe", "with": r"Doe, \1"}]}, "Pat Doe  Trio",
         "Doe, Pat Trio"),
        ({}, "Pat Doe Trio", "Pat Doe Trio"),
    ],
)  # fmt: skip
def test_source_retitle(rewrites: dict, title: str, expected: str) -> None:
    source = Source.model_validate({"id": "s", "adapter": "ics", "url": "https://x", **rewrites})
    assert source.retitle(title) == expected


@pytest.mark.parametrize(
    "settings",
    [
        {"include": "(unclosed"},
        {"title_replace": [{"pattern": "x"}]},
        {"unknown": "maybe"},
        {"trust_txt": True},
    ],
)
def test_source_settings_are_checked(settings: dict) -> None:
    with pytest.raises(ValidationError):
        Source.model_validate({"id": "s", "adapter": "ics", "url": "https://x", **settings})
