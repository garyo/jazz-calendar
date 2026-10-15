from datetime import date, datetime
from pathlib import Path

from jazzcal.adapters import ploughandstars
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_plough_month_grid() -> None:
    url = "https://calendar.ploughandstars.com/events/calendar?month=10&year=2026"
    events = ploughandstars.parse((FIXTURES / "plough.html").read_text(), page_url=url)
    b3 = next(e for e in events if e.start.date() == date(2026, 10, 13))
    assert b3.title == "Johnny Trama and The B3 Kings"
    assert b3.start == datetime(2026, 10, 13, 22, 0, tzinfo=TZ)
    assert b3.url == url
    matinee = next(e for e in events if e.title == "Tom Hagerty Band")
    assert (matinee.start.hour, matinee.end and matinee.end.hour) == (16, 18)
    assert len({e.uid for e in events}) == len(events)
