"""Dates and clock times written the way venues write them: '7pm', '4-6p', '8:30pm:',
'Shows at 7 & 9pm', 'OCTOBER', 'Oct'."""

import re
from collections.abc import Sequence
from datetime import date, datetime, time, timedelta

from jazzcal.adapters import to_local

MONTHS = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)  # fmt: skip

_TOKEN = re.compile(
    r"\b(?:(noon)|(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?)?)(?=$|[^a-z0-9])", re.IGNORECASE
)


def month_number(name: str) -> int | None:
    """1-12 for a month's name or its first three letters, in any case; None otherwise."""
    abbreviation = name.strip().lower()[:3]
    return next((n for n, month in enumerate(MONTHS, 1) if month[:3] == abbreviation), None)


def parse_times(text: str, *, require_meridiem: bool = False) -> list[time]:
    """Every clock time in the text, in order.

    A time without am/pm takes the next stated one ('7 & 9pm', '4-6p'), else pm. A range
    start that would then come after its end ('10-1a') is flipped to pm. With
    `require_meridiem`, only times stating am or pm (or noon) count, for text that also holds
    dates ('October 5, 2026 7:00 PM').
    """
    tokens: list[tuple[int, int, str | None]] = []
    for noon, hour, minute, meridiem in _TOKEN.findall(text):
        if noon:
            tokens.append((12, 0, "p"))
        elif (meridiem or not require_meridiem) and 1 <= int(hour) <= 12 and int(minute or 0) < 60:
            tokens.append((int(hour), int(minute or 0), meridiem.lower() or None))
    times = []
    for i, (hour, minute, meridiem) in enumerate(tokens):
        stated = meridiem or next((m for _, _, m in tokens[i + 1 :] if m), "p")
        t = _to_time(hour, minute, stated)
        if not meridiem and i + 1 < len(tokens) and t > _to_time(*_resolved(tokens[i + 1])):
            t = _to_time(hour, minute, "p")
        times.append(t)
    return times


def schedule(day: date, times: Sequence[time]) -> tuple[datetime, datetime | None, bool]:
    """Boston-local start, end and all-day flag of a show on `day` at the given times: the
    first is the start, a second the end. No times means all day. An end at or before the
    start is after midnight."""
    if not times:
        return to_local(day)[0], None, True
    start = to_local(datetime.combine(day, times[0]))[0]
    if len(times) < 2:
        return start, None, False
    end_day = day + timedelta(days=1) if times[1] <= times[0] else day
    return start, to_local(datetime.combine(end_day, times[1]))[0], False


def _resolved(token: tuple[int, int, str | None]) -> tuple[int, int, str]:
    hour, minute, meridiem = token
    return hour, minute, meridiem or "p"


def _to_time(hour: int, minute: int, meridiem: str) -> time:
    return time(hour % 12 + (12 if meridiem == "p" else 0), minute)
