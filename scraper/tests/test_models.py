from datetime import datetime

import pytest
from pydantic import ValidationError

from jazzcal.config import TZ
from jazzcal.models import Event, ScrapedEvent

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


def test_event_needs_a_web_url() -> None:
    assert published(ticket_url="javascript:void(0)").ticket_url is None
    with pytest.raises(ValidationError):
        published(url="javascript:void(0)")
