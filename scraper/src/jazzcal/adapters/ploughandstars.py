"""The Plough & Stars' hand-built month calendar (calendar.ploughandstars.com).

`url` is the calendar page without query; this month's and next month's grids are read.
Acts link to their own pages, not to event pages, so events link to the month grid.
"""

from datetime import date, datetime, timedelta

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import adapter, clean, to_local
from jazzcal.adapters.times import parse_times
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source


@adapter("ploughandstars")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    first = datetime.now(TZ).date().replace(day=1)
    following = (first + timedelta(days=32)).replace(day=1)
    events = []
    for month in (first, following):
        url = f"{source.url}?month={month.month}&year={month.year}"
        events += parse(http.get(url).text, page_url=url)
    return events


def parse(page: str, *, page_url: str) -> list[ScrapedEvent]:
    events = []
    for day in HTMLParser(page).css("main div.day[id]"):
        day_id = day.attributes.get("id") or ""
        if not (len(day_id) == 8 and day_id.isdigit()):
            continue
        on = date(int(day_id[:4]), int(day_id[4:6]), int(day_id[6:]))
        for row in day.css(".entries .row"):
            when = row.css_first(".flex_item_left")
            act = row.css_first(".event")
            title = clean(act.text()) if act else None
            times = parse_times(when.text()) if when else []
            if not title:
                continue
            start, all_day = to_local(datetime.combine(on, times[0]) if times else on)
            end = to_local(datetime.combine(on, times[1]))[0] if len(times) > 1 else None
            if end and end <= start:
                end += timedelta(days=1)
            events.append(
                ScrapedEvent(
                    uid=f"{on.isoformat()}/{title}",
                    title=title,
                    start=start,
                    end=end,
                    all_day=all_day,
                    url=page_url,
                )
            )
    return events
