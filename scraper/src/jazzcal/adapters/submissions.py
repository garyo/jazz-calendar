"""Gigs musicians and venues submit on the site, once the editor approves them.

The site serves upcoming approved submissions at /api/submissions/approved, behind the same
token the scraper publishes with (JAZZCAL_PUBLISH_TOKEN), on $JAZZCAL_SITE or the production
site. Only publishable fields come back. The editor picks a listed venue and rules on
relevance when approving, so each event carries both; `url` is the page the submitter gave
to confirm the gig.
"""

import logging
import os
from datetime import date, datetime, time, timedelta

from jazzcal.adapters import adapter, clean, to_local
from jazzcal.export import site_url
from jazzcal.http import FetchError, Http
from jazzcal.models import ScrapedEvent, Source

log = logging.getLogger(__name__)

PATH = "/api/submissions/approved"


@adapter("submissions")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    token = os.environ.get("JAZZCAL_PUBLISH_TOKEN")
    if not token:
        raise FetchError("JAZZCAL_PUBLISH_TOKEN is not set")
    # Revalidate every run, so a gig approved today goes out with today's feed.
    response = http.get(
        f"{site_url()}{PATH}",
        max_age=timedelta(0),
        headers={"Authorization": f"Bearer {token}"},
    )
    return parse(response.json_dict())


def parse(data: dict) -> list[ScrapedEvent]:
    events = []
    for item in data.get("submissions", []):
        try:
            events.append(_event(item))
        except (KeyError, TypeError, ValueError) as e:
            log.warning("skipping submission %s: %s", item.get("id"), e)
    return events


def _event(item: dict) -> ScrapedEvent:
    title = clean(item["title"])
    if not title:
        raise ValueError("no title")
    day = date.fromisoformat(item["date"])
    start, all_day = to_local(day)
    end = None
    if starts := item.get("start_time"):
        start_time = time.fromisoformat(starts)
        start, all_day = to_local(datetime.combine(day, start_time))
        if ends := item.get("end_time"):
            end_time = time.fromisoformat(ends)
            # An end before the start is after midnight.
            end_day = day + timedelta(days=1) if end_time <= start_time else day
            end = to_local(datetime.combine(end_day, end_time))[0]
    return ScrapedEvent(
        uid=item["id"],
        title=title,
        start=start,
        end=end,
        all_day=all_day,
        venue=item["venue"],
        url=item["url"],
        price=clean(item.get("price")),
        relevance=item["relevance"],
    )
