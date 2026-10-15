"""The Burren's static music page: day headers, then room / time / act / blurb per listing.

Day headers have no year ("TUESDAY OCTOBER 13"); the year is whichever of this year or next
puts that date on that weekday. Short blurbs are genres ("Gypsy jazz"), so they double as
categories for the classifier.
"""

import re
from datetime import date, datetime, timedelta

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import adapter, clean, to_local
from jazzcal.adapters.times import parse_times
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
MONTHS = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
]  # fmt: skip
HEADER = re.compile(rf"({'|'.join(DAYS)})\s+({'|'.join(MONTHS)})\s+(\d{{1,2}})\b")
GENRE_MAX = 30


@adapter("burren")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    return parse(http.get(source.url).text, page_url=source.url, today=datetime.now(TZ).date())


def parse(page: str, *, page_url: str, today: date) -> list[ScrapedEvent]:
    events: list[ScrapedEvent] = []
    day: date | None = None
    room = time_text = None
    for node in HTMLParser(page).css(".HEADER, .Room, .Time, span.BAND, .Text"):
        text = clean(node.text(separator=" ")) or ""
        kind = node.attributes.get("class")
        if kind == "HEADER":
            day = _day(text, today)
        elif kind == "Room":
            room = text
        elif kind == "Time":
            time_text = text
        elif kind == "BAND" and day and text:
            events.append(_event(day, room, time_text, text, page_url))
            time_text = None
        elif kind == "Text" and events and text and not events[-1].text:
            last = events[-1]
            last.text = text
            if len(text) <= GENRE_MAX:
                last.categories = [text]
    return events


def _event(on: date, room: str | None, time_text: str | None, act: str, url: str) -> ScrapedEvent:
    times = parse_times(time_text or "")
    start, all_day = to_local(datetime.combine(on, times[0]) if times else on)
    end = to_local(datetime.combine(on, times[1]))[0] if len(times) > 1 else None
    if end and end <= start:
        end += timedelta(days=1)
    return ScrapedEvent(
        uid=f"{on.isoformat()}/{room}/{act}",
        title=act.title() if act.isupper() else act,
        start=start,
        end=end,
        all_day=all_day,
        venue_name=f"The Burren, {room.title()}" if room else None,
        url=url,
    )


def _day(header: str, today: date) -> date | None:
    m = HEADER.search(header.upper())
    if not m:
        return None
    weekday, month, day = DAYS.index(m.group(1)), MONTHS.index(m.group(2)) + 1, int(m.group(3))
    candidates = []
    for year in (today.year, today.year + 1):
        try:
            candidates.append(date(year, month, day))
        except ValueError:
            continue
    return next((d for d in candidates if d.weekday() == weekday), None)
