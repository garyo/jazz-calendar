"""schema.org Event JSON-LD embedded in pages, on the source's page or the event pages it
links to. Some sites' JSON-LD is incomplete; options can fill the gaps from the page itself.
"""

import logging
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, time
from typing import Any
from urllib.parse import urljoin

from dateutil.parser import ParserError, isoparse
from dateutil.parser import parse as parse_date
from pydantic import Field
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from jazzcal.adapters import (
    DETAIL_MAX_AGE,
    Options,
    Selector,
    adapter,
    clean,
    html_to_text,
    json_ld,
    to_local,
    unique_urls,
)
from jazzcal.adapters.times import parse_times
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

log = logging.getLogger(__name__)


class JsonLdOptions(Options):
    follow: Selector | None = Field(
        None,
        description="CSS selector for links to event pages, for sites whose list page lacks "
        "JSON-LD but whose event pages have it. Event pages are cached for 5 days.",
    )
    max_follow: int = Field(60, description="Most event pages fetched per run")
    time_selector: Selector | None = Field(
        None,
        description="CSS selector for an element giving the time ('7:00 PM until 11:00 PM'), "
        "used when startDate is a bare date: the first time is the start, a second the end",
    )
    venue_selector: Selector | None = Field(
        None,
        description="CSS selector for the venue, used when the location has no name: a meta "
        "tag's content, or else the element's text",
    )
    venue_pattern: re.Pattern[str] | None = Field(
        None, description="A regex applied to that, whose first group is the venue name"
    )
    no_price: bool = Field(False, description="True when offers carry a placeholder price")


@adapter("jsonld", options=JsonLdOptions)
def scrape(source: Source, http: Http, options: JsonLdOptions) -> list[ScrapedEvent]:
    page = http.get(source.url).text
    if not options.follow:
        return parse(page, base_url=source.url, options=options)
    tree = HTMLParser(page)
    hrefs = [href for a in tree.css(options.follow) if (href := a.attributes.get("href"))]
    events = []
    for link in unique_urls(hrefs, base_url=source.url)[: options.max_follow]:
        detail = http.get(link, max_age=DETAIL_MAX_AGE).text
        events += parse(detail, base_url=link, options=options)
    return events


@dataclass
class _PageHints:
    """What the page itself says, for gaps in its JSON-LD."""

    times: list[time] = field(default_factory=list)
    venue: str | None = None
    no_price: bool = False


def parse(page: str, *, base_url: str, options: JsonLdOptions | None = None) -> list[ScrapedEvent]:
    tree = HTMLParser(page)
    hints = _hints(tree, options or JsonLdOptions())
    events = {}
    for data in json_ld(tree):
        for item in _event_items(data):
            try:
                event = _parse_event(item, base_url, hints)
            except (ValueError, OverflowError) as e:
                log.warning("skipping unparseable event on %s: %s", base_url, e)
                continue
            if event:
                events[event.uid] = event
    return list(events.values())


def _hints(tree: HTMLParser, options: JsonLdOptions) -> _PageHints:
    hints = _PageHints(no_price=options.no_price)
    if options.time_selector and (node := tree.css_first(options.time_selector)):
        hints.times = parse_times(node.text(), require_meridiem=True)
    if options.venue_selector and (node := tree.css_first(options.venue_selector)):
        venue = node.attributes.get("content") or node.text()
        if venue and options.venue_pattern:
            match = options.venue_pattern.search(venue)
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
    title = _string(item.get("name"))
    title = html_to_text(title) if title and "<" in title else clean(title)
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
        end=end,
        all_day=all_day,
        venue_name=clean(_string(_first(item.get("location"), "name"))) or hints.venue,
        url=url,
        ticket_url=offers.get("url") if isinstance(offers, dict) else None,
        price=_price(offers) if isinstance(offers, dict) and not hints.no_price else None,
        artists=[
            name
            for p in (performers if isinstance(performers, list) else [performers])
            if (name := clean(_string(p.get("name") if isinstance(p, dict) else p)))
        ],
        text=html_to_text(_string(item.get("description")) or ""),
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


def _string(value: Any) -> str | None:
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
