from datetime import date, datetime

from jazzcal.adapters import textschedule
from jazzcal.config import TZ

PAGE = """
Free Admission, Free Junk Food!
September 2026 Schedule
Friday 9/4
7:30 PM The Openers
8:30 PM The Jazz Situation: Pat Doe trumpet, Sam Roe tenor sax, Lee Poe piano
9:30 PM House Band: Kim Moe vibes,  Ray Low bass
Friday 10/2 Wildcard Night
7:30 PM The Flat Fives
Saturday, October 3rd is Student Night!
Schedule TBA
"""


def test_sets_and_lineups() -> None:
    events = textschedule.parse(PAGE, page_url="https://club.example/", today=date(2026, 9, 1))
    assert [e.title for e in events] == [
        "The Openers",
        "The Jazz Situation",
        "House Band",
        "The Flat Fives",
    ]
    openers, situation, house, nines = events
    assert openers.start == datetime(2026, 9, 4, 19, 30, tzinfo=TZ)
    assert openers.end == situation.start
    assert house.end == datetime(2026, 9, 4, 22, 30, tzinfo=TZ)
    assert situation.artists == ["Pat Doe", "Sam Roe", "Lee Poe"]
    assert house.artists == ["Kim Moe", "Ray Low"]
    assert nines.start == datetime(2026, 10, 2, 19, 30, tzinfo=TZ)


def test_year_rolls_over() -> None:
    [event] = textschedule.parse(
        "Friday 1/8\n7:30 PM New Year Band",
        page_url="https://club.example/",
        today=date(2026, 12, 20),
    )
    assert event.start.date() == date(2027, 1, 8)
