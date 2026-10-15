from datetime import date, datetime, time

import pytest

from jazzcal.adapters.times import month_number, parse_times, schedule
from jazzcal.config import TZ


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("One Show at 7pm", [time(19)]),
        ("ONE SHOW AT 7PM", [time(19)]),
        ("Shows at 7 & 9pm", [time(19), time(21)]),
        ("4-6p", [time(16), time(18)]),
        ("10p", [time(22)]),
        ("8:30pm:", [time(20, 30)]),
        ("11:30am:", [time(11, 30)]),
        ("10-1a", [time(22), time(1)]),
        ("noon", [time(12)]),
        ("Doors at 8", [time(20)]),
        ("No times here", []),
    ],
)
def test_parse_times(text: str, expected: list[time]) -> None:
    assert parse_times(text) == expected


def test_parse_times_requiring_meridiem_skips_dates() -> None:
    text = "October 5, 2026 07:00 PM until October 5, 2026 11:00 PM"
    assert parse_times(text, require_meridiem=True) == [time(19), time(23)]
    assert parse_times("noon until 2pm", require_meridiem=True) == [time(12), time(14)]


@pytest.mark.parametrize(
    ("name", "number"),
    [("OCTOBER", 10), ("Sept", 9), ("jan", 1), (" May ", 5), ("ma", None), ("Smarch", None)],
)
def test_month_number(name: str, number: int | None) -> None:
    assert month_number(name) == number


def test_schedule() -> None:
    day = date(2026, 10, 31)
    assert schedule(day, []) == (datetime(2026, 10, 31, tzinfo=TZ), None, True)
    assert schedule(day, [time(20)]) == (datetime(2026, 10, 31, 20, tzinfo=TZ), None, False)
    start, end, all_day = schedule(day, [time(22, 30), time(3)])
    # After midnight, across the end of daylight saving time.
    assert (start, end, all_day) == (
        datetime(2026, 10, 31, 22, 30, tzinfo=TZ),
        datetime(2026, 11, 1, 3, tzinfo=TZ),
        False,
    )
    assert end is not None and end.timestamp() - start.timestamp() == 5.5 * 3600
