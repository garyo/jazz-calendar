"""MusicIDB venue calendars (Scullers), via the list widget the venue embeds.

`url` is the widget's upcoming-events URL without `page`; the adapter adds page=0, 1, ...
until a page comes back short. Show times are only in the subtitle ("Shows at 7 & 9pm"),
so each listed show becomes its own event.
"""

import re
import string
from datetime import date, datetime

from selectolax.lexbor import LexborHTMLParser as HTMLParser
from selectolax.lexbor import LexborNode

from jazzcal.adapters import adapter, clean, html_to_text, to_local
from jazzcal.adapters.times import parse_times
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

PAGE_SIZE = 15
MAX_PAGES = 10
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


@adapter("musicidb")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    events = []
    for page in range(MAX_PAGES):
        html = http.get(f"{source.url}&page={page}").text
        events += parse(html)
        if html.count('<li id="event-') < PAGE_SIZE:
            break
    return events


def parse(page: str) -> list[ScrapedEvent]:
    events = []
    for item in HTMLParser(page).css("li.listEvent"):
        event_id = (item.attributes.get("id") or "").removeprefix("event-")
        title_node = item.css_first(".titleofevent a")
        title = clean(title_node.text()) if title_node else None
        day = _date(item)
        if not event_id or not title or day is None:
            continue
        subtitle = clean(_text(item, ".subtitleEvent")) or ""
        ticket = item.css_first("a.TicketLink")
        ticket_url = ticket.attributes.get("href") if ticket else None
        genres = (_text(item, ".genresOnEvent") or "").replace("Genres:", "")
        description = item.css_first(".eventDescription")
        listing = ScrapedEvent(
            uid=event_id,
            title=string.capwords(title) if title.isupper() else title,
            start=to_local(day)[0],
            all_day=True,
            url=ticket_url,
            ticket_url=ticket_url,
            categories=[g for part in genres.split(",") if (g := clean(part))],
            text=html_to_text(description.html or "") if description else None,
            cancelled=bool(re.search(r"\bcancel+ed\b", f"{title} {subtitle}", re.I)),
        )
        times = parse_times(subtitle)
        if not times:
            events.append(listing)
        for t in times:
            show = {"uid": f"{event_id}/{t:%H%M}", "all_day": False}
            show["start"] = to_local(datetime.combine(day, t))[0]
            events.append(listing.model_copy(update=show))
    return events


def _date(item: LexborNode) -> date | None:
    month = (_text(item, "h3.date .monthName:not(.dayNameAbb)") or "").strip().lower()[:3]
    day = (_text(item, "h3.date .dayNum") or "").strip()
    year = (_text(item, "h3.date .yearNum") or "").strip()
    if month not in MONTHS or not day.isdigit() or not year.isdigit():
        return None
    return date(int(year), MONTHS.index(month) + 1, int(day))


def _text(node: LexborNode, selector: str) -> str | None:
    found = node.css_first(selector)
    return found.text(separator=" ") if found else None
