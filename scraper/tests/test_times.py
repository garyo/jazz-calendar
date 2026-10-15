from datetime import time

import pytest

from jazzcal.adapters.times import parse_times


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
