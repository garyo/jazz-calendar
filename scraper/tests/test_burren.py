from datetime import date, datetime
from pathlib import Path

from jazzcal.adapters import burren
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_burren() -> None:
    events = burren.parse(
        (FIXTURES / "burren.html").read_text(),
        page_url="https://www.burren.com/music.html",
        today=date(2026, 10, 15),
    )
    django = next(e for e in events if e.title == "The Django Cadre")
    assert django.start == datetime(2026, 10, 13, 19, 0, tzinfo=TZ)
    assert django.categories == ["Gypsy jazz"]
    assert django.venue_name == "The Burren, The Front Room"
    assert all(e.start.year == 2026 for e in events)
    assert len({e.uid for e in events}) == len(events)
