"""Ticketmaster Discovery API, which also carries TicketWeb venues (Regattabar, Scullers).

This is Ticketmaster's sanctioned route to its listings; TicketWeb's own pages forbid robots.
Needs TICKETMASTER_API_KEY (a free developer key).

API terms: no revenue from the API, cache only for reasonable periods, and remove content on
request. The site links each show to its venue's page, with the ticket link as given, and
credits the listing "via Ticketmaster" (the source's credit in sources.yaml).
"""

import os
from datetime import datetime
from urllib.parse import urlencode

from pydantic import Field

from jazzcal.adapters import HORIZON, Options, adapter, clean, to_local, uncaps
from jazzcal.config import TZ
from jazzcal.http import FetchError, Http
from jazzcal.models import ScrapedEvent, Source

API = "https://app.ticketmaster.com/discovery/v2/events.json"
PAGE_SIZE = 100
MAX_PAGES = 5


class TicketmasterOptions(Options):
    venue_id: str = Field(
        description="Discovery venue id (find it with /discovery/v2/venues.json?keyword=...)"
    )


@adapter("ticketmaster", options=TicketmasterOptions)
def scrape(source: Source, http: Http, options: TicketmasterOptions) -> list[ScrapedEvent]:
    key = os.environ.get("TICKETMASTER_API_KEY")
    if not key:
        raise FetchError("TICKETMASTER_API_KEY is not set")
    now = datetime.now(TZ)
    events = []
    for page in range(MAX_PAGES):
        query = urlencode({
            "venueId": options.venue_id,
            "size": PAGE_SIZE,
            "page": page,
            "sort": "date,asc",
            "endDateTime": f"{(now + HORIZON):%Y-%m-%dT%H:%M:%SZ}",
            "apikey": key,
        })  # fmt: skip
        data = http.get(f"{API}?{query}").json_dict()
        events += parse(data)
        if page + 1 >= data.get("page", {}).get("totalPages", 0):
            break
    return events


def parse(data: dict) -> list[ScrapedEvent]:
    events = []
    for item in data.get("_embedded", {}).get("events", []):
        title = clean(item.get("name"))
        start = _start(item.get("dates", {}).get("start", {}))
        if not title or start is None:
            continue
        ranges = item.get("priceRanges") or []
        genres = [
            name
            for c in item.get("classifications", [])
            for kind in ("genre", "subGenre")
            if (name := c.get(kind, {}).get("name")) and name != "Undefined"
        ]
        venues = item.get("_embedded", {}).get("venues", [])
        events.append(
            ScrapedEvent(
                uid=item["id"],
                title=uncaps(title),
                start=start[0],
                all_day=start[1],
                venue_name=venues[0].get("name") if venues else None,
                ticket_url=item.get("url"),
                price=f"From ${ranges[0]['min']:.0f}" if ranges and "min" in ranges[0] else None,
                categories=genres,
                cancelled=item.get("dates", {}).get("status", {}).get("code") == "cancelled",
            )
        )
    return events


def _start(start: dict) -> tuple[datetime, bool] | None:
    if when := start.get("dateTime"):
        return to_local(datetime.fromisoformat(when))
    if day := start.get("localDate"):
        if clock := start.get("localTime"):
            return to_local(datetime.fromisoformat(f"{day}T{clock}"))
        return to_local(datetime.fromisoformat(day).date())
    return None
