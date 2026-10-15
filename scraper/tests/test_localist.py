import json
from datetime import datetime
from pathlib import Path

from jazzcal.adapters import localist
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_localist_mit() -> None:
    events = localist.parse_page(json.loads((FIXTURES / "mit-localist.json").read_text()))
    assert len(events) == 22
    fje = next(e for e in events if e.title == "Festival Jazz Ensemble's Fall Concert")
    assert fje.start == datetime(2026, 11, 13, 20, 0, tzinfo=TZ)
    assert fje.venue_name == "Building W18"
    assert fje.url == "https://calendar.mit.edu/event/festival-jazz-ensembles-fall-concert"
    assert "Jazz Music" in fje.categories
    assert "Performing Arts" in fje.categories
    assert all(e.start.tzinfo is not None for e in events)
    assert len({e.uid for e in events}) == len(events)
