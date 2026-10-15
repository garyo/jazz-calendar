"""Gigs musicians and venues submit on the site, once the editor approves them.

The site serves upcoming approved submissions at /api/submissions/approved, behind the same
token the scraper publishes with (JAZZCAL_PUBLISH_TOKEN), on $JAZZCAL_SITE or the production
site. Only publishable fields come back (`ApprovedGig`). The editor picks a listed venue and
rules on relevance when approving, so each event carries both; `url` is the page the
submitter gave to confirm the gig.
"""

import logging
import os
from datetime import date, time, timedelta

from pydantic import BaseModel, ValidationError

from jazzcal.adapters import adapter, clean
from jazzcal.adapters.times import schedule
from jazzcal.export import site_url
from jazzcal.http import FetchError, Http
from jazzcal.models import Listed, ScrapedEvent, Source

log = logging.getLogger(__name__)

PATH = "/api/submissions/approved"


class ApprovedGig(BaseModel):
    """An approved gig as the site serves it: ApprovedGig in site/src/submission.ts. Fields the
    site may add later are ignored."""

    id: str
    title: str
    date: date
    start_time: time | None
    """Boston local; None when the time is TBA."""
    end_time: time | None
    """An end at or before the start is after midnight."""
    venue: str
    price: str | None
    url: str
    relevance: Listed


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
            gig = ApprovedGig.model_validate(item)
        except ValidationError as e:
            name = item.get("id") if isinstance(item, dict) else None
            log.warning("skipping submission %s: %s", name, e)
            continue
        if event := _event(gig):
            events.append(event)
        else:
            log.warning("skipping submission %s: no title", gig.id)
    return events


def _event(gig: ApprovedGig) -> ScrapedEvent | None:
    title = clean(gig.title)
    if not title:
        return None
    times = [gig.start_time] if gig.start_time else []
    if times and gig.end_time:
        times.append(gig.end_time)
    start, end, all_day = schedule(gig.date, times)
    return ScrapedEvent(
        uid=gig.id,
        title=title,
        start=start,
        end=end,
        all_day=all_day,
        venue=gig.venue,
        url=gig.url,
        price=clean(gig.price),
        relevance=gig.relevance,
    )
