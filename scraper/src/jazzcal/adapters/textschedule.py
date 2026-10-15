"""Schedules written as plain text: a day heading, then one line per set.

    Friday 9/4
    7:30 PM The Cleaners
    8:30 PM The Jazz Situation: Pat Doe trumpet, Sam Roe piano, Lee Poe bass

Each set becomes an event, ending when the next set that night starts. Text after a colon is
the lineup: names followed by instruments, comma-separated. Dates carry no year; the next
occurrence on or after a few weeks ago is used.
"""

import re
from datetime import date, datetime, time, timedelta

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import adapter, clean, to_local
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

DAY = re.compile(r"^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(\d{1,2})/(\d{1,2})\b", re.IGNORECASE)
SET = re.compile(r"^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s+(.+)$", re.IGNORECASE)
LAST_SET = timedelta(hours=1)
"""Length assumed for a night's last set."""


@adapter("textschedule")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    tree = HTMLParser(http.get(source.url).text)
    for node in tree.css("script, style, noscript, svg"):
        node.decompose()
    text = tree.body.text(separator="\n") if tree.body else ""
    return parse(text, page_url=source.url, today=datetime.now(TZ).date())


def parse(text: str, *, page_url: str, today: date) -> list[ScrapedEvent]:
    nights: list[tuple[date, list[tuple[time, str]]]] = []
    for raw in text.splitlines():
        line = clean(raw)
        if not line:
            continue
        if m := DAY.match(line):
            nights.append((_date(int(m[1]), int(m[2]), today), []))
        elif (m := SET.match(line)) and nights:
            hour = int(m[1]) % 12 + (12 if m[3].lower() == "p" else 0)
            nights[-1][1].append((time(hour, int(m[2] or 0)), m[4]))
    events = []
    for day, sets in nights:
        starts = [to_local(datetime.combine(day, t))[0] for t, _ in sets]
        for i, (start, (_, text)) in enumerate(zip(starts, sets, strict=True)):
            title, _, lineup = text.partition(":")
            events.append(
                ScrapedEvent(
                    uid=f"{start.isoformat()}/{title.strip()}",
                    title=title.strip(),
                    start=start,
                    end=starts[i + 1] if i + 1 < len(starts) else start + LAST_SET,
                    url=page_url,
                    artists=_names(lineup),
                    text=lineup.strip() or None,
                )
            )
    return events


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
