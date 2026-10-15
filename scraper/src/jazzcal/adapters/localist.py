"""Localist calendars (MIT, Northeastern, many universities), via /api/2/events.

`url` is the calendar root. Options:
  params: extra query parameters, e.g. {"type[]": [103224]} for an event type, or
          {"keyword": "jazz"}. Without a filter the whole calendar comes back, so set one.
"""

from datetime import datetime
from typing import Any
from urllib.parse import urlencode

from jazzcal.adapters import HORIZON, adapter, clean, html_to_text, to_local
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

MAX_PAGES = 10


@adapter("localist")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    params: dict[str, Any] = {"days": HORIZON.days, "pp": 100, **source.options.get("params", {})}
    events = []
    for page in range(1, MAX_PAGES + 1):
        query = urlencode({**params, "page": page}, doseq=True)
        data = http.get(f"{source.url.rstrip('/')}/api/2/events?{query}").json_dict()
        events += parse_page(data)
        if not data.get("page", {}).get("next_page"):
            break
    return events


def parse_page(data: dict) -> list[ScrapedEvent]:
    return [e for item in data.get("events", []) for e in _parse_event(item["event"])]


def _parse_event(event: dict) -> list[ScrapedEvent]:
    title = clean(event.get("title"))
    if not title:
        return []
    filters = event.get("filters") or {}
    categories = [
        *(event.get("tags") or []),
        *(f["name"] for f in filters.get("event_types", [])),
    ]
    price = clean(event.get("ticket_cost")) or ("Free" if event.get("free") else None)
    common: dict[str, Any] = {
        "title": title,
        "venue_name": clean(event.get("location_name")),
        "url": event.get("localist_url"),
        "ticket_url": event.get("ticket_url") or None,
        "price": price,
        "categories": [name for c in categories if (name := clean(c))],
        "text": html_to_text(event.get("description") or ""),
        "cancelled": "cancel" in str(event.get("status", "")).lower(),
    }
    events = []
    for wrapper in event.get("event_instances", []):
        instance = wrapper["event_instance"]
        all_day = bool(instance.get("all_day"))
        start = datetime.fromisoformat(instance["start"])
        start = to_local(start.date() if all_day else start)[0]
        end = (
            to_local(datetime.fromisoformat(instance["end"]))[0]
            if instance.get("end") and not all_day
            else None
        )
        events.append(
            ScrapedEvent(
                uid=str(instance["id"]),
                start=start,
                end=end if end and end > start else None,
                all_day=all_day,
                **common,
            )
        )
    return events
