"""Squarespace events collections, from the server-rendered list page.

The collection's ?format=json and ?format=ical views are disallowed by Squarespace's stock
robots.txt, so this reads the HTML. Each event's "Google Calendar" export link carries its
exact start and end in UTC; the visible date and 24-hour time are the fallback.
"""

import re
from datetime import UTC, date, datetime, time
from urllib.parse import parse_qs, urljoin, urlsplit

from selectolax.lexbor import LexborHTMLParser as HTMLParser
from selectolax.lexbor import LexborNode

from jazzcal.adapters import adapter, clean, is_cancelled, text_of, to_local
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

PRICE = re.compile(r"\$\d+(?:\.\d\d)?(?:\s*[-\u2013]\s*\$?\d+(?:\.\d\d)?)?|^\s*free\b", re.I)


@adapter("squarespace")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    return parse(http.get(source.url).text, base_url=source.url)


def parse(page: str, *, base_url: str) -> list[ScrapedEvent]:
    events = []
    for article in HTMLParser(page).css("article.eventlist-event--upcoming"):
        link = article.css_first("a.eventlist-title-link")
        title = clean(link.text()) if link else None
        if not link or not title:
            continue
        url = urljoin(base_url, link.attributes.get("href") or "")
        when = _google_dates(article) or _shown_dates(article)
        if when is None:
            continue
        start, end, all_day = when
        excerpt = clean(text_of(article, ".eventlist-excerpt"))
        events.append(
            ScrapedEvent(
                uid=urlsplit(url).path,
                title=title,
                start=start,
                end=end,
                all_day=all_day,
                venue_name=_venue(article),
                url=url,
                price=_price(excerpt),
                categories=[c for a in article.css(".eventlist-cats a") if (c := clean(a.text()))],
                text=excerpt,
                cancelled=is_cancelled(title),
            )
        )
    return events


def _google_dates(article: LexborNode) -> tuple[datetime, datetime | None, bool] | None:
    export = article.css_first("a.eventlist-meta-export-google")
    href = export.attributes.get("href") if export else None
    dates = parse_qs(urlsplit(href).query).get("dates", [""])[0] if href else ""
    start_text, _, end_text = dates.partition("/")
    if re.fullmatch(r"\d{8}T\d{6}Z", start_text):
        start = datetime.strptime(start_text, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        end = (
            datetime.strptime(end_text, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            if re.fullmatch(r"\d{8}T\d{6}Z", end_text)
            else None
        )
        return to_local(start)[0], to_local(end)[0] if end else None, False
    if re.fullmatch(r"\d{8}", start_text):
        return to_local(datetime.strptime(start_text, "%Y%m%d").date())[0], None, True
    return None


def _shown_dates(article: LexborNode) -> tuple[datetime, datetime | None, bool] | None:
    day = article.css_first("time.event-date")
    iso = day.attributes.get("datetime") if day else None
    if not iso:
        return None
    start_day = date.fromisoformat(iso)
    shown = text_of(article, ".event-time-24hr-start")
    if shown and re.fullmatch(r"\d{1,2}:\d\d", shown.strip()):
        return (
            to_local(datetime.combine(start_day, time.fromisoformat(shown.strip())))[0],
            None,
            False,
        )
    return to_local(start_day)[0], None, True


def _price(excerpt: str | None) -> str | None:
    found = PRICE.search(excerpt or "")
    if not found:
        return None
    return "Free" if found.group().strip().lower() == "free" else found.group()


def _venue(article: LexborNode) -> str | None:
    address = article.css_first(".eventlist-meta-address")
    if not address:
        return None
    return clean(address.text(deep=False))
