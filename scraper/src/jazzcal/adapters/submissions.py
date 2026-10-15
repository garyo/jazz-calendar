"""Gigs musicians and venues submit on the site, once the editor approves them.

The site serves upcoming approved submissions at /api/submissions/approved, behind the same
token the scraper publishes with (JAZZCAL_PUBLISH_TOKEN), on $JAZZCAL_SITE or the production
site. Only publishable fields come back. The editor picks a listed venue and rules on
relevance when approving, so each event carries both; `url` is the page the submitter gave
to confirm the gig.
"""

import logging
import os
from datetime import date, time, timedelta

from jazzcal.adapters import adapter, clean
from jazzcal.adapters.times import schedule
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
    times = [time.fromisoformat(item["start_time"])] if item.get("start_time") else []
    if times and item.get("end_time"):
        times.append(time.fromisoformat(item["end_time"]))
    start, end, all_day = schedule(date.fromisoformat(item["date"]), times)
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
