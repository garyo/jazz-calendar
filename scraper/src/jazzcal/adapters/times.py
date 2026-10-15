"""Clock times written the way venues write them: '7pm', '4-6p', '8:30pm:', 'Shows at 7 & 9pm'."""

import re
from datetime import time

_TOKEN = re.compile(
    r"\b(?:(noon)|(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?)?)(?=$|[^a-z0-9])", re.IGNORECASE
)


def parse_times(text: str) -> list[time]:
    """Every clock time in the text, in order.

    A time without am/pm takes the next stated one ('7 & 9pm', '4-6p'), else pm. A range
    start that would then come after its end ('10-1a') is flipped to pm.
    """
    tokens: list[tuple[int, int, str | None]] = []
    for noon, hour, minute, meridiem in _TOKEN.findall(text):
        if noon:
            tokens.append((12, 0, "p"))
        elif hour and 1 <= int(hour) <= 12 and int(minute or 0) < 60:
            tokens.append((int(hour), int(minute or 0), meridiem.lower() or None))
    times = []
    for i, (hour, minute, meridiem) in enumerate(tokens):
        stated = meridiem or next((m for _, _, m in tokens[i + 1 :] if m), "p")
        t = _to_time(hour, minute, stated)
        if not meridiem and i + 1 < len(tokens) and t > _to_time(*_resolved(tokens[i + 1])):
            t = _to_time(hour, minute, "p")
        times.append(t)
    return times


def _resolved(token: tuple[int, int, str | None]) -> tuple[int, int, str]:
    hour, minute, meridiem = token
    return hour, minute, meridiem or "p"


def _to_time(hour: int, minute: int, meridiem: str) -> time:
    return time(hour % 12 + (12 if meridiem == "p" else 0), minute)
