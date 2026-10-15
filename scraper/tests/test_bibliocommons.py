import json
from datetime import datetime
from pathlib import Path

from jazzcal.adapters import bibliocommons
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_bibliocommons_keeps_adult_performances() -> None:
    data = json.loads((FIXTURES / "bpl-events.json").read_text())
    events = bibliocommons.parse(
        data, site="https://bpl.bibliocommons.com", now=datetime(2026, 10, 15, 6, tzinfo=TZ)
    )
    titles = [e.title for e in events]
    # Story times, kids' music and "Puzzles & Jazz" (a games event) are dropped.
    assert titles == ["Just Guitar with Chris Lee-Rodriguez (South Boston branch)"]
    guitar = events[0]
    assert guitar.start == datetime(2026, 10, 17, 13, 0, tzinfo=TZ)
    assert guitar.venue_name == "South Boston"
    assert guitar.url == "https://bpl.bibliocommons.com/events/6aba8c91901b02002cbe764c"
    assert "Concerts" in guitar.categories
