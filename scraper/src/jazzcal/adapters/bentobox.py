"""Restaurant sites built on BentoBox (getbento.com), via their event pages.

The events list page carries JSON-LD stubs with each event's URL, though it may show only
some of them as links. Each event page has the title as its <h1> and, just below it, the
full schedule: "October 16, 2026 07:00 PM until October 16, 2026 10:00 PM".

Options:
  title_strip: regex removed from titles, e.g. a leading date "10/16 ".
  ticket_link: CSS selector for a booking link on the event page, e.g.
          a[href*="exploretock.com"][href*="/experience/"].
  max_follow: cap on event pages fetched per run (default 40). They're cached for 24 hours.
"""

import json
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urljoin

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import adapter, clean, html_to_text
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

DETAIL_MAX_AGE = timedelta(hours=24)
WHEN = re.compile(r"([A-Z][a-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)")


@adapter("bentobox")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    urls = event_urls(http.get(source.url).text, base_url=source.url)
    events = []
    for url in urls[: source.options.get("max_follow", 40)]:
        page = http.get(url, max_age=DETAIL_MAX_AGE).text
        if event := parse_event_page(page, url=url, options=source.options):
            events.append(event)
    return events


def event_urls(page: str, *, base_url: str) -> list[str]:
    """Event page URLs from the list page's JSON-LD, then its links, without duplicates."""
    tree = HTMLParser(page)
    urls: list[str] = []
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            urls += _event_urls(json.loads(node.text(strip=False)))
        except json.JSONDecodeError:
            continue
    urls += [href for a in tree.css('a[href*="/event/"]') if (href := a.attributes.get("href"))]
    seen: dict[str, str] = {}
    for url in urls:
        url = urljoin(base_url, url)
        seen.setdefault(url.rstrip("/"), url)
    return list(seen.values())


def _event_urls(data: Any) -> list[str]:
    if isinstance(data, list):
        return [u for d in data for u in _event_urls(d)]
    if not isinstance(data, dict):
        return []
    found = [data["url"]] if data.get("@type") == "Event" and data.get("url") else []
    return found + _event_urls(data.get("@graph", []))


def parse_event_page(page: str, *, url: str, options: dict[str, Any]) -> ScrapedEvent | None:
    tree = HTMLParser(page)
    heading = tree.css_first("h1")
    title = clean(heading.text()) if heading else None
    if title and (strip := options.get("title_strip")):
        title = clean(re.sub(strip, "", title))
    schedule = tree.css_first("h1 + p")
    times = [
        datetime.strptime(t, "%B %d, %Y %I:%M %p").replace(tzinfo=TZ)
        for t in WHEN.findall(schedule.text() if schedule else "")
    ]
    if not title or not times:
        return None
    start, end = times[0], times[1] if len(times) > 1 and times[1] > times[0] else None
    link = tree.css_first(options["ticket_link"]) if options.get("ticket_link") else None
    return ScrapedEvent(
        uid=url,
        title=title,
        start=start,
        end=end,
        url=url,
        ticket_url=link.attributes.get("href") if link else None,
        text=_description(tree),
    )


def _description(tree: HTMLParser) -> str | None:
    """The event's JSON-LD description, used only for classification."""
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text(strip=False))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("@type") == "Event":
            return html_to_text(str(data.get("description") or "")) or None
    return None
