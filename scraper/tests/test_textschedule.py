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


def test_sets_over_several_lines() -> None:
    page = """
Our Run Begins THIS Friday, November 6th!
Friday, November 6th
7:30
First Feature:
(new here) Pat Doe saxophone, Sam Roe drums
8:30
KR5
Sunday, November 8th SONGBOOK NIGHT with Kim Moe!
7 PM: The house orchestra plays a wild array of instrumental compositions from its book.
8 PM: Kim Moe, the singer from just down the street, sings standards with the orchestra.
Saturday, November 14th
Student Night
Schedule TBA!
"""
    events = textschedule.parse(page, page_url="https://club.example/", today=date(2026, 11, 1))
    assert [e.title for e in events] == ["First Feature", "KR5", "SONGBOOK NIGHT with Kim Moe"]
    feature, kr5, songbook = events
    assert feature.start == datetime(2026, 11, 6, 19, 30, tzinfo=TZ)
    assert feature.end == kr5.start
    assert feature.artists == ["Sam Roe"]
    assert kr5.artists == []
    assert songbook.start == datetime(2026, 11, 8, 19, 0, tzinfo=TZ)
    assert songbook.end == datetime(2026, 11, 8, 21, 0, tzinfo=TZ)
    assert songbook.artists == []
