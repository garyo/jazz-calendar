"""Schedules written as plain text: a day heading, then each set, on one line or several.

    Friday 9/4                       Friday, November 6th
    7:30 PM The Cleaners             7:30
    8:30 PM The Jazz Situation: …    The Jazz Situation:
                                     Pat Doe trumpet, Sam Roe piano, Lee Poe bass

Each set becomes an event, ending when the next set that night starts. Text after a colon is
the lineup: names followed by instruments, comma-separated. A set given as a sentence rather
than a name ("7 PM: The orchestra performs …") takes its title from the day heading's own
text, and sets in a row with one title become one event. Dates carry no year; the next
occurrence on or after a few weeks ago is used.
"""

import re
from datetime import date, datetime, time, timedelta

from jazzcal.adapters import adapter, clean, page_text, to_local
from jazzcal.adapters.times import month_number, parse_times
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

DAY = re.compile(
    r"^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+"
    r"(?:(\d{1,2})/(\d{1,2})|([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?)\b[\s,:-]*(.*)$",
    re.IGNORECASE,
)
_TIME = r"\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?"
SET = re.compile(rf"^({_TIME}):?\s+(.+)$", re.IGNORECASE)
"""A set on one line: '7:30 PM The Cleaners', '7 PM: …'."""
BARE_TIME = re.compile(rf"^({_TIME}):?$", re.IGNORECASE)
"""A set's time on a line of its own, its act on the next."""
SENTENCE = 60
"""Set text longer than this, with no lineup, is a description rather than a name."""
LAST_SET = timedelta(hours=1)
"""Length assumed for a night's last set."""

type Set = tuple[time, str]


@adapter("textschedule")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    text = page_text(http.get(source.url).text)
    return parse(text, page_url=source.url, today=datetime.now(TZ).date())


def parse(text: str, *, page_url: str, today: date) -> list[ScrapedEvent]:
    events = []
    for day, heading, sets in _nights(text, today):
        events.extend(_events(day, heading, sets, page_url))
    return events


def _nights(text: str, today: date) -> list[tuple[date, str, list[Set]]]:
    """Each day heading's date, its own text, and the sets under it."""
    nights: list[tuple[date, str, list[Set]]] = []
    pending: time | None = None  # a time on its own line, waiting for its act
    lineup_next = False  # the last act ended with a colon, so its lineup follows
    for raw in text.splitlines():
        line = clean(raw)
        if not line:
            continue
        if (m := DAY.match(line)) and (day := _heading_date(m, today)):
            nights.append((day, m[5].rstrip("!. "), []))
            pending, lineup_next = None, False
            continue
        if not nights:
            continue
        sets = nights[-1][2]
        if (m := BARE_TIME.match(line)) and (times := parse_times(m[1])):
            pending, lineup_next = times[0], False
        elif (m := SET.match(line)) and (times := parse_times(m[1])):
            sets.append((times[0], m[2]))
            pending, lineup_next = None, m[2].endswith(":")
        elif pending is not None:
            sets.append((pending, line))
            pending, lineup_next = None, line.endswith(":")
        elif lineup_next and sets:
            start, act = sets[-1]
            sets[-1] = (start, f"{act} {line}")
            lineup_next = False
    return nights


def _events(day: date, heading: str, sets: list[Set], page_url: str) -> list[ScrapedEvent]:
    starts = [to_local(datetime.combine(day, t))[0] for t, _ in sets]
    ends = [*starts[1:], starts[-1] + LAST_SET] if starts else []
    events: list[ScrapedEvent] = []
    for start, end, (_, text) in zip(starts, ends, sets, strict=True):
        title, _, lineup = (part.strip() for part in text.partition(":"))
        artists = _names(lineup)
        if not lineup and len(title) > SENTENCE:
            title, lineup, artists = heading, title, []
        if not title:
            continue
        if events and events[-1].title == title:
            events[-1] = events[-1].model_copy(update={"end": end})
            continue
        events.append(
            ScrapedEvent(
                uid=f"{start.isoformat()}/{title}",
                title=title,
                start=start,
                end=end,
                url=page_url,
                artists=artists,
                text=lineup or None,
            )
        )
    return events


def _heading_date(m: re.Match[str], today: date) -> date | None:
    if m[1]:
        return _date(int(m[1]), int(m[2]), today)
    month = month_number(m[3])
    return _date(month, int(m[4]), today) if month else None


def _date(month: int, day: int, today: date) -> date:
    """The occurrence of month/day nearest after a few weeks ago."""
    for year in (today.year - 1, today.year, today.year + 1):
        candidate = date(year, month, day)
        if candidate >= today - timedelta(weeks=4):
            return candidate
    return date(today.year + 1, month, day)


def _names(lineup: str) -> list[str]:
    """'Pat Doe trumpet, Sam Roe tenor sax' -> ['Pat Doe', 'Sam Roe']: leading capitalized words."""
    names = []
    for part in lineup.split(","):
        words = []
        for word in part.split():
            if not word[:1].isupper():
                break
            words.append(word)
        if words:
            names.append(" ".join(words))
    return names
