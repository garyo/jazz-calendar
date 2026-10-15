"""schema.org Event JSON-LD embedded in pages.

Options:
  follow: CSS selector for links to event detail pages, for sites whose list page lacks
          JSON-LD but whose detail pages have it. Detail pages are cached for 24 hours.
  max_follow: cap on detail pages fetched per run (default 60).

Some sites' JSON-LD is incomplete; these fill the gaps from the page itself:
  time_selector: CSS selector for an element giving the time ("7:00 PM until 11:00 PM"), used
          when startDate is a bare date. The first time is the start, a second the end.
  venue_selector: CSS selector for the venue, used when the location has no name. Reads a
          meta tag's content, or else the element's text.
  venue_pattern: regex applied to that, whose first group is the venue name.
  title_strip: regex removed from titles, e.g. a leading date "10/15 ".
  no_price: true when the site's offers carry a placeholder price.
"""

import json
import logging
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Any
from urllib.parse import urljoin

from dateutil.parser import ParserError, isoparse
from dateutil.parser import parse as parse_date
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import adapter, clean, html_to_text, to_local
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

EVENT_TYPES = {
    "Event",
    "MusicEvent",
    "TheaterEvent",
    "DanceEvent",
    "ComedyEvent",
    "Festival",
    "SocialEvent",
    "EducationEvent",
    "ExhibitionEvent",
    "LiteraryEvent",
    "PublicationEvent",
}
DETAIL_MAX_AGE = timedelta(hours=24)
TIME = re.compile(r"\b(\d{1,2})(?::(\d\d))?\s*([ap])\.?m\b", re.IGNORECASE)

log = logging.getLogger(__name__)


@adapter("jsonld")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    page = http.get(source.url).text
    selector = source.options.get("follow")
    if not selector:
        return parse(page, base_url=source.url, options=source.options)
    # Keyed without the trailing slash, which some sites use for the same page both ways.
    links: dict[str, str] = {}
    for node in HTMLParser(page).css(selector):
        if href := node.attributes.get("href"):
            url = urljoin(source.url, href)
            links.setdefault(url.rstrip("/"), url)
    events = []
    for link in list(links.values())[: source.options.get("max_follow", 60)]:
        detail = http.get(link, max_age=DETAIL_MAX_AGE).text
        events += parse(detail, base_url=link, options=source.options)
    return events


@dataclass
class _PageHints:
    """What the page itself says, for gaps in its JSON-LD."""

    times: list[time] = field(default_factory=list)
    venue: str | None = None
    title_strip: str | None = None
    no_price: bool = False


def parse(
    page: str, *, base_url: str, options: Mapping[str, Any] | None = None
) -> list[ScrapedEvent]:
    tree = HTMLParser(page)
    hints = _hints(tree, options or {})
    events = {}
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text(strip=False))
        except json.JSONDecodeError:
            continue
        for item in _event_items(data):
            try:
                event = _parse_event(item, base_url, hints)
            except (ValueError, OverflowError) as e:
                log.warning("skipping unparseable event on %s: %s", base_url, e)
                continue
            if event:
                events[event.uid] = event
    return list(events.values())


def _hints(tree: HTMLParser, options: Mapping[str, Any]) -> _PageHints:
    hints = _PageHints(
        title_strip=options.get("title_strip"), no_price=bool(options.get("no_price"))
    )
    if (selector := options.get("time_selector")) and (node := tree.css_first(selector)):
        hints.times = [
            time((int(h) % 12) + (12 if ampm.lower() == "p" else 0), int(m or 0))
            for h, m, ampm in TIME.findall(node.text())
        ]
    if (selector := options.get("venue_selector")) and (node := tree.css_first(selector)):
        venue = node.attributes.get("content") or node.text()
        if venue and (pattern := options.get("venue_pattern")):
            match = re.search(pattern, venue)
            venue = match.group(1) if match else None
        hints.venue = clean(venue)
    return hints


def _event_items(data: Any) -> Iterator[dict]:
    if isinstance(data, list):
        for d in data:
            yield from _event_items(d)
    elif isinstance(data, dict):
        types = data.get("@type")
        types = set(types) if isinstance(types, list) else {types}
        if types & EVENT_TYPES:
            yield data
        for key in ("@graph", "itemListElement", "item", "subEvent", "event", "events"):
            if key in data:
                yield from _event_items(data[key])


def _parse_event(item: dict, base_url: str, hints: _PageHints) -> ScrapedEvent | None:
    title = _text(item.get("name"))
    title = html_to_text(title) if title and "<" in title else clean(title)
    if title and hints.title_strip:
        title = clean(re.sub(hints.title_strip, "", title))
    if not title or not item.get("startDate"):
        return None
    start, all_day = _when(item["startDate"])
    end = _when(item["endDate"])[0] if item.get("endDate") else None
    if all_day and hints.times:
        day = start.date()
        start, all_day = datetime.combine(day, hints.times[0], start.tzinfo), False
        end = datetime.combine(day, hints.times[1], start.tzinfo) if len(hints.times) > 1 else None
    url = urljoin(base_url, item["url"]) if isinstance(item.get("url"), str) else base_url
    offers = _first(item.get("offers"))
    performers = item.get("performer") or []
    status = str(item.get("eventStatus", ""))
    return ScrapedEvent(
        uid=f"{url}#{start.isoformat()}",
        title=title,
        start=start,
        end=end if end and end > start and not all_day else None,
        all_day=all_day,
        venue_name=clean(_text(_first(item.get("location"), "name"))) or hints.venue,
        url=url,
        ticket_url=offers.get("url") if isinstance(offers, dict) else None,
        price=_price(offers) if isinstance(offers, dict) and not hints.no_price else None,
        artists=[
            name
            for p in (performers if isinstance(performers, list) else [performers])
            if (name := clean(_text(p.get("name") if isinstance(p, dict) else p)))
        ],
        text=html_to_text(_text(item.get("description")) or ""),
        cancelled=status.endswith("EventCancelled"),
    )


def _when(value: str) -> tuple[datetime, bool]:
    """Parse a schema.org date or datetime; tolerates non-ISO forms like '11-19-2026'."""
    try:
        parsed = isoparse(value)
    except ValueError:
        try:
            parsed = parse_date(value)
        except ParserError as e:
            raise ValueError(f"bad date {value!r}") from e
    return to_local(parsed.date() if ":" not in value else parsed)


def _first(value: Any, key: str | None = None) -> Any:
    if isinstance(value, list):
        value = value[0] if value else None
    if key is not None:
        return value.get(key) if isinstance(value, dict) else value
    return value


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _price(offers: dict) -> str | None:
    low, high = offers.get("lowPrice"), offers.get("highPrice")
    price = offers.get("price")
    if low is not None and high is not None and low != high:
        return f"${low}-{high}"
    value = price if price is not None else low
    if value in (None, ""):
        return None
    try:
        return "Free" if float(value) == 0 else f"${float(value):g}"
    except (TypeError, ValueError):
        return clean(str(value))
