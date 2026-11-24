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

A series that always runs at one time may list only dates and acts, which the source's
`time` option then times; a time in parentheses after the act overrides it:

    Dec 3  Pat Doe & Friends
    Dec 31 New Year's Eve: Sam Roe Band (7-10pm)
"""

import re
from datetime import date, datetime, time, timedelta

from pydantic import Field
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import Options, Selector, adapter, clean, page_text
from jazzcal.adapters.times import MONTHS, month_number, parse_times, schedule
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

_DATE = r"(?:(\d{1,2})/(\d{1,2})|([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?)\b[\s,:-]*"
DAY = re.compile(rf"^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+{_DATE}(.*)$", re.IGNORECASE)
DATED = re.compile(rf"^{_DATE}(.+)$", re.IGNORECASE)
"""A date and an act on one line, with no weekday: 'Dec 3 Pat Doe & Friends'."""
OWN_TIME = re.compile(r"\s*\(([^)]*\d[^)]*)\)$")
"""A dated act's own time, in parentheses at the end: '(7-10pm)'."""
_TIME = r"\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?"
SET = re.compile(rf"^({_TIME}):?\s+(.+)$", re.IGNORECASE)
"""A set on one line: '7:30 PM The Cleaners', '7 PM: …'."""
BARE_TIME = re.compile(rf"^({_TIME}):?$", re.IGNORECASE)
"""A set's time on a line of its own, its act on the next."""
SENTENCE = 60
"""Set text longer than this, with no lineup, is a description rather than a name."""
LAST_SET = timedelta(hours=1)
"""Length assumed for a night's last set."""

BREAK = "\u2028"
"""Stands in for a <br> while the HTML source's own newlines become spaces."""

type Set = tuple[list[time], str]
"""A set's start (and end, if stated) and its act."""


class TextScheduleOptions(Options):
    selector: Selector | None = Field(
        None,
        description="The elements holding the schedule, read with only their <br>s breaking "
        "lines, for markup that splits an act's name (default: the whole page's text)",
    )
    time: str | None = Field(
        None,
        description="When every set runs, e.g. '6-9 pm', for schedules that give only a date "
        "and an act on each line",
    )


@adapter("textschedule", options=TextScheduleOptions)
def scrape(source: Source, http: Http, options: TextScheduleOptions) -> list[ScrapedEvent]:
    page = http.get(source.url).text
    text = _lines(page, options.selector) if options.selector else page_text(page)
    times = parse_times(options.time) if options.time else []
    return parse(text, page_url=source.url, today=datetime.now(TZ).date(), times=times)


def _lines(page: str, selector: str) -> str:
    """The text of the elements the selector matches, broken only at their <br>s."""
    tree = HTMLParser(page)
    for br in tree.css("br"):
        br.replace_with(BREAK)
    text = BREAK.join(node.text(separator="") for node in tree.css(selector))
    return re.sub(r"[\r\n]+", " ", text).replace(BREAK, "\n")  # source newlines are spaces


def parse(
    text: str, *, page_url: str, today: date, times: list[time] | None = None
) -> list[ScrapedEvent]:
    """Events from a schedule's text; `times` time the lines that give only a date and an act."""
    events = []
    for day, heading, sets in _nights(text, today, times or []):
        events.extend(_events(day, heading, sets, page_url))
    return events


def _nights(text: str, today: date, times: list[time]) -> list[tuple[date, str, list[Set]]]:
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
        if times and (m := DATED.match(line)) and (day := _dated(m, today)):
            act, own = m[5], None
            if (t := OWN_TIME.search(act)) and (own := parse_times(t[1])):
                act = act[: t.start()]
            nights.append((day, act, [(own or times, act)]))
            pending, lineup_next = None, False
            continue
        if not nights:
            continue
        sets = nights[-1][2]
        if (m := BARE_TIME.match(line)) and (clock := parse_times(m[1])):
            pending, lineup_next = clock[0], False
        elif (m := SET.match(line)) and (clock := parse_times(m[1])):
            sets.append(([clock[0]], m[2]))
            pending, lineup_next = None, m[2].endswith(":")
        elif pending is not None:
            sets.append(([pending], line))
            pending, lineup_next = None, line.endswith(":")
        elif lineup_next and sets:
            clock, act = sets[-1]
            sets[-1] = (clock, f"{act} {line}")
            lineup_next = False
    return nights


def _events(day: date, heading: str, sets: list[Set], page_url: str) -> list[ScrapedEvent]:
    timed = [schedule(day, clock)[:2] for clock, _ in sets]
    starts = [start for start, _ in timed]
    nexts = [*starts[1:], starts[-1] + LAST_SET] if starts else []
    events: list[ScrapedEvent] = []
    for (start, stated), following, (_, text) in zip(timed, nexts, sets, strict=True):
        end = stated or following
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


def _dated(m: re.Match[str], today: date) -> date | None:
    """A dated line's date. With no weekday to mark it as one, the month must be a month's
    name or a prefix of it ('Sept'), not merely start like one ('Mark')."""
    if m[3] and not any(month.startswith(m[3].lower()) for month in MONTHS):
        return None
    return _heading_date(m, today)


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
