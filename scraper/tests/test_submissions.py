import json
from datetime import datetime
from pathlib import Path

from jazzcal.adapters import submissions
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse() -> None:
    data = json.loads((FIXTURES / "submissions.json").read_text())
    quartet, late, brunch = submissions.parse(data)  # the bad date is skipped

    assert quartet.uid == "0b6f2d1e-8a3c-4f5e-9d7a-1c2b3a4d5e6f"
    assert quartet.title == "The Fictional Quartet"
    assert quartet.start == datetime(2026, 10, 22, 20, 0, tzinfo=TZ)
    assert quartet.end == datetime(2026, 10, 22, 23, 0, tzinfo=TZ)
    assert not quartet.all_day
    assert quartet.venue == "lilypad"
    assert quartet.url == "https://example.com/gigs/fictional-quartet"
    assert quartet.price == "$15"
    assert quartet.relevance == "jazz"

    assert late.title == "Late Set: Example Organ Trio"
    # Ends after midnight, across the end of daylight saving time.
    assert late.end is not None
    assert late.end == datetime(2026, 11, 1, 3, 0, tzinfo=TZ)
    assert late.end.timestamp() - late.start.timestamp() == 5.5 * 3600
    assert late.relevance == "adjacent"
    assert late.price is None

    assert brunch.all_day
    assert brunch.start == datetime(2026, 10, 25, tzinfo=TZ)
    assert brunch.end is None
