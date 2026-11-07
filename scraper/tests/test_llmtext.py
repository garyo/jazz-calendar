from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from jazzcal.adapters import llmtext
from jazzcal.adapters.llmtext import Listing
from jazzcal.config import TZ
from jazzcal.http import FetchError, Http

PAGE = """\
Free Admission, Free Junk Food!
Friday, November 6th
7:30
The Fictional Five:
Pat Doe trumpet, Sam Roe piano
8:30\u201310:00 PM
Imaginary Quartet
Sunday, November 8th SONGBOOK NIGHT with Kim Moe!
7 PM: The house orchestra plays a wild array of compositions."""
TODAY = date(2026, 11, 1)


def listing(**kw: object) -> Listing:
    fields: dict[str, object] = {
        "title": "The Fictional Five",
        "date": "2026-11-06",
        "start_time": "19:30",
        "date_text": "Friday, November 6th",
        "time_text": "7:30",
    }
    return Listing.model_validate(fields | kw)


def test_accept_keeps_what_the_page_bears_out() -> None:
    listings = [
        listing(lineup=["Pat Doe", "Sam Roe", "Lee Invented"]),
        listing(
            title="Imaginary Quartet",
            start_time="20:30",
            end_time="22:00",
            time_text="8:30\u201310:00 PM",
        ),
        listing(
            title="Songbook Night with Kim Moe",
            date="2026-11-08",
            start_time="19:00",
            date_text="Sunday, November 8th",
            time_text="7 PM",
        ),
    ]
    five, quartet, songbook = llmtext.accept(listings, PAGE, page_url="https://x/", today=TODAY)
    assert five.start == datetime(2026, 11, 6, 19, 30, tzinfo=TZ)
    assert five.end is None
    assert five.artists == ["Pat Doe", "Sam Roe"]  # the page has no Lee Invented
    assert quartet.end == datetime(2026, 11, 6, 22, 0, tzinfo=TZ)
    assert songbook.title == "Songbook Night with Kim Moe"  # case aside, it's on the page


@pytest.mark.parametrize(
    "bad",
    [
        {"title": "The Invented Trio"},  # not on the page
        {"title": "The house orchestra plays a wild array of compositions, a sentence"},
        {"date": "2026-11-07"},  # the quote says the 6th
        {"date": "2027-11-06"},  # too far ahead
        {"start_time": "20:30"},  # the quote says 7:30
        {"date_text": "Saturday, November 7th"},  # not on the page
        {"start_time": "half past seven"},
    ],
)
def test_accept_drops_what_it_cannot_check(bad: dict[str, object]) -> None:
    assert llmtext.accept([listing(**bad)], PAGE, page_url="https://x/", today=TODAY) == []


def test_answers_are_cached_by_page(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []

    def ask(text: str, today: date, model: str) -> list[Listing]:
        asked.append(text)
        return [listing()]

    monkeypatch.setattr(llmtext, "_ask", ask)
    http = Http(tmp_path, max_age=timedelta(hours=1))
    assert llmtext._listings(PAGE, TODAY, "m", http) == [listing()]
    assert llmtext._listings(PAGE, TODAY, "m", http) == [listing()]
    assert len(asked) == 1
    llmtext._listings(PAGE + "\nA new line", TODAY, "m", http)
    assert len(asked) == 2
    offline = Http(tmp_path, max_age=timedelta(hours=1), offline=True)
    with pytest.raises(FetchError, match="offline"):
        llmtext._listings("A page never seen", TODAY, "m", offline)
