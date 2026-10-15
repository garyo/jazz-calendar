from datetime import datetime
from pathlib import Path

from jazzcal.adapters import musicidb
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_scullers() -> None:
    events = [
        e for n in (0, 1) for e in musicidb.parse((FIXTURES / f"scullers-{n}.html").read_text())
    ]
    assert len(events) == 21  # 17 listings, four with two shows
    first = events[0]
    assert first.title == "Gengis Don"
    assert first.start == datetime(2026, 10, 16, 19, 0, tzinfo=TZ)
    assert first.categories == ["Hip-Hop", "Jazz"]
    assert first.ticket_url and first.ticket_url.startswith("https://www.ticketweb.com/")
    chestnut = [e for e in events if e.title == "Cyrus Chestnut Trio"]
    assert [e.start.hour for e in chestnut] == [19, 21]
    assert len({e.uid for e in events}) == len(events)
    assert all("'S " not in e.title for e in events)
