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


SERIES = """
<h2>Thursdays at 6pm</h2>
<p><strong>Dec 3\t</strong><a href="#">Pat Doe</a> &amp; Friends<strong><br>Dec 17\t</strong>
<a href="#">Sam Roe'</a>s Holiday Show<br><strong>Dec 31</strong> <strong> </strong>New Year's
Eve: <a href="#">Lee Poe Band</a> (7\u201310pm)<br><strong>Fed 11 </strong>Kim Moe Trio<br>
<strong>Mark 2</strong> paragraphs of prose</p>
<p>Jan 7 Kim Moe Quartet</p>
<p>Hours<br>Mon 3pm - 10pm</p>
"""


def test_dated_lines_in_one_paragraph() -> None:
    text = textschedule._lines(SERIES, "p")
    times = textschedule.parse_times("6\u20139 pm")
    events = textschedule.parse(
        text, page_url="https://club.example/", today=date(2026, 11, 24), times=times
    )
    assert [e.title for e in events] == [
        "Pat Doe & Friends",
        "Sam Roe's Holiday Show",
        "New Year's Eve",
        "Kim Moe Quartet",
    ]
    friends, holiday, nye, _ = events
    assert friends.start == datetime(2026, 12, 3, 18, 0, tzinfo=TZ)
    assert friends.end == datetime(2026, 12, 3, 21, 0, tzinfo=TZ)
    assert holiday.start.date() == date(2026, 12, 17)
    assert nye.start == datetime(2026, 12, 31, 19, 0, tzinfo=TZ)
    assert nye.end == datetime(2026, 12, 31, 22, 0, tzinfo=TZ)
    assert nye.artists == ["Lee Poe Band"]


def test_dated_lines_need_a_time() -> None:
    assert (
        textschedule.parse(
            "Dec 3 Pat Doe Trio", page_url="https://club.example/", today=date(2026, 11, 24)
        )
        == []
    )
