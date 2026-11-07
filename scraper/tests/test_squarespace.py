from datetime import datetime
from pathlib import Path

from jazzcal.adapters import squarespace
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_lilypad() -> None:
    events = squarespace.parse(
        (FIXTURES / "lilypad.html").read_text(), base_url="https://www.lilypadinman.com/home"
    )
    assert len(events) == 121  # upcoming only; the page also shows 30 past events
    first = events[0]
    assert first.title == "Vahco Before Horses / Tall City / Mobdividual"
    assert first.start == datetime(2026, 10, 15, 22, 0, tzinfo=TZ)
    assert first.end == datetime(2026, 10, 15, 23, 59, tzinfo=TZ)
    assert first.url == "https://www.lilypadinman.com/home/2026/10/15/vahco-before-horses"
    assert first.venue_name == "The Lilypad"
    assert first.price == "$10-15"
    octet = next(e for e in events if e.title.startswith("Pablo ablanedo"))
    assert octet.categories == ["Jazz"]
    assert len({e.uid for e in events}) == len(events)


def test_calendar_view_reads_the_noscript_list() -> None:
    events = squarespace.parse(
        (FIXTURES / "bebop-calendar.html").read_text(),
        base_url="https://www.thebebopboston.com/new-events",
    )
    assert len(events) == 52  # the whole month; the pipeline drops what's past
    jam = events[0]
    assert jam.title == "Monday Jazz Jam at The Bebop"
    assert jam.start == datetime(2026, 11, 30, 20, 0, tzinfo=TZ)
    assert jam.end == datetime(2026, 11, 30, 23, 59, tzinfo=TZ)
    assert (jam.url or "").startswith("https://www.thebebopboston.com/new-events/36fk35b8wp6fpk6-")
    assert jam.venue_name == "The Bebop"
    assert events[1].venue_name is None  # this one gives no address
    assert len({e.uid for e in events}) == len(events)


def test_calendar_dates() -> None:
    dates = squarespace._calendar_dates
    assert dates("Saturday, November 7, 2026, 10:30 PM \u2013 1:00 AM") == (
        datetime(2026, 11, 7, 22, 30, tzinfo=TZ),
        datetime(2026, 11, 8, 1, 0, tzinfo=TZ),
        False,
    )
    assert dates(
        "Friday, December 4, 2026, 9:00 PM \u2013 Saturday, December 5, 2026, 2:00 AM"
    ) == (
        datetime(2026, 12, 4, 21, 0, tzinfo=TZ),
        datetime(2026, 12, 5, 2, 0, tzinfo=TZ),
        False,
    )
    assert dates("Thursday, November 26, 2026") == (datetime(2026, 11, 26, tzinfo=TZ), None, True)
    assert dates("no date here") is None
