"""WordPress sites running The Events Calendar ("Tribe"), via its REST API.

`url` is the site root; the adapter pages through /wp-json/tribe/events/v1/events.
"""

from datetime import UTC, datetime
from urllib.parse import urlencode

from jazzcal.adapters import HORIZON, adapter, clean, html_to_text, is_cancelled, to_local
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

MAX_PAGES = 10


@adapter("tribe")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    today = datetime.now(TZ).date()
    query = urlencode(
        {
            "start_date": today.isoformat(),
            "end_date": (today + HORIZON).isoformat(),
            "per_page": 50,
        }
    )
    url: str | None = f"{source.url.rstrip('/')}/wp-json/tribe/events/v1/events?{query}"
    events = []
    for _ in range(MAX_PAGES):
        if not url:
            break
        page = http.get(url).json_dict()
        events += parse_page(page)
        url = page.get("next_rest_url")
    return events


def parse_page(page: dict) -> list[ScrapedEvent]:
    return [e for item in page.get("events", []) if (e := _parse_event(item))]


def _parse_event(item: dict) -> ScrapedEvent | None:
    title = clean(item.get("title"))
    if not title:
        return None
    all_day = item.get("all_day") in (True, "True", "true", "1")
    start = _utc(item["utc_start_date"])
    end = _utc(item["utc_end_date"]) if item.get("utc_end_date") else None
    if all_day:
        start = to_local(start.date())[0]
    venue = item.get("venue")
    terms = [t["name"] for key in ("categories", "tags") for t in item.get(key) or []]
    return ScrapedEvent(
        uid=str(item["id"]),
        title=title,
        start=start,
        end=end,
        all_day=all_day,
        venue_name=clean(venue.get("venue")) if isinstance(venue, dict) else None,
        url=item.get("url"),
        ticket_url=item.get("website") or None,
        price=clean(item.get("cost")),
        categories=[c for t in terms if (c := clean(t))],
        text=html_to_text(item.get("description") or ""),
        cancelled=is_cancelled(title),
    )


def _utc(value: str) -> datetime:
    """Tribe's utc_* fields are 'YYYY-MM-DD HH:MM:SS' in UTC."""
    return datetime.fromisoformat(value).replace(tzinfo=UTC).astimezone(TZ)
