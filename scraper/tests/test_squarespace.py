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
