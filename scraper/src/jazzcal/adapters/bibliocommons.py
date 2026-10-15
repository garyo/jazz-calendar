"""BiblioCommons library event calendars (Boston Public Library), via their public RSS feeds.

BiblioCommons' terms permit automated use only through its RSS/XML feeds, so this reads
`url`, e.g. https://gateway.bibliocommons.com/v2/libraries/bpl/rss/events, with a search.

Only concerts and performances not aimed solely at children or teens are kept. Branch names
go in the title, since the registry holds the library as one venue.
"""

import xml.etree.ElementTree as ET
from datetime import datetime
from urllib.parse import urlencode

from pydantic import Field

from jazzcal.adapters import HORIZON, Options, adapter, clean, html_to_text, to_local
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

BC = "{http://bibliocommons.com/rss/1.0/modules/event/}"
PERFORMANCE_TYPES = {"Concerts", "Performing Arts"}
AUDIENCES = ("Children", "Families", "Teens", "Adults", "Older Adults", "All Ages", "Young Adults")
YOUTH = ("Children", "Families", "Teens")


class BiblioCommonsOptions(Options):
    query: str = Field("jazz", description="Search terms")


@adapter("bibliocommons", options=BiblioCommonsOptions)
def scrape(source: Source, http: Http, options: BiblioCommonsOptions) -> list[ScrapedEvent]:
    query = urlencode({"q": options.query})
    return parse(http.get(f"{source.url}?{query}").text, now=datetime.now(TZ))


def parse(xml: str, *, now: datetime) -> list[ScrapedEvent]:
    events = []
    for item in ET.fromstring(xml).iter("item"):
        categories = [c.text.strip() for c in item.findall("category") if c.text]
        audiences = [c for c in categories if c.startswith(AUDIENCES)]
        if not PERFORMANCE_TYPES & set(categories):
            continue
        if audiences and all(a.startswith(YOUTH) for a in audiences):
            continue
        title = clean(item.findtext("title"))
        start_text = item.findtext(f"{BC}start_date")
        if not title or not start_text:
            continue
        start = to_local(datetime.fromisoformat(start_text))[0]
        if start > now + HORIZON:
            continue
        end_text = item.findtext(f"{BC}end_date")
        end = to_local(datetime.fromisoformat(end_text))[0] if end_text else None
        branch = clean(item.findtext(f"{BC}location/{BC}name"))
        link = item.findtext("link") or item.findtext("guid") or ""
        events.append(
            ScrapedEvent(
                uid=link.rsplit("/", 1)[-1] or title,
                title=f"{title} ({branch} branch)" if branch else title,
                start=start,
                end=end,
                venue_name=branch,
                url=link or None,
                categories=[c for c in categories if c in PERFORMANCE_TYPES],
                text=html_to_text(item.findtext("description") or ""),
                cancelled=item.findtext(f"{BC}is_cancelled") == "true",
            )
        )
    return events
