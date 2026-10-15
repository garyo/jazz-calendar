"""Spektrix ticketing (The Cabot, Beverly), via its public API v3.

`url` is the client's API root, e.g. https://tickets.thecabot.org/thecabot/api/v3. The genre
attributes become categories for the classifier.
"""

from datetime import datetime

from pydantic import Field

from jazzcal.adapters import Options, adapter, clean, to_local
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

GENRE_ATTRIBUTES = (
    "attribute_Genre",
    "attribute_LiveEventGenre",
    "attribute_LiveEventGenre2",
    "attribute_LiveEventGenre3",
)


class SpektrixOptions(Options):
    page_url: str | None = Field(
        None,
        description="Where to link events, since Spektrix events usually have no web page of "
        "their own (default: the venue's site)",
    )


@adapter("spektrix", options=SpektrixOptions)
def scrape(source: Source, http: Http, options: SpektrixOptions) -> list[ScrapedEvent]:
    root = source.url.rstrip("/")
    today = datetime.now(TZ).date().isoformat()
    events = http.get(f"{root}/events?instanceStart_from={today}").json_list()
    # Most events have one performance; fetch the instance list only for runs.
    instances: dict[str, list[dict]] = {}
    for e in events:
        if e["firstInstanceDateTime"] != e["lastInstanceDateTime"]:
            instances[e["id"]] = http.get(f"{root}/events/{e['id']}/instances").json_list()
    return parse(
        events,
        instances,
        page_url=options.page_url,
        today=today,
    )


def parse(
    events: list[dict],
    instances: dict[str, list[dict]],
    *,
    page_url: str | None,
    today: str,
) -> list[ScrapedEvent]:
    scraped = []
    for event in events:
        title = clean(event.get("name"))
        if not title:
            continue
        runs = instances.get(event["id"]) or [
            {"id": event["id"], "start": event["firstInstanceDateTime"], "cancelled": False}
        ]
        categories = [g for a in GENRE_ATTRIBUTES if (g := clean(event.get(a))) and g != "N/A"]
        for run in runs:
            if run["start"][:10] < today:
                continue
            start = to_local(datetime.fromisoformat(run["start"]))[0]
            scraped.append(
                ScrapedEvent(
                    uid=f"{run['id']}/{run['start']}",
                    title=title,
                    start=start,
                    url=event.get("webUrl") or page_url,
                    categories=categories,
                    text=clean(event.get("description")),
                    cancelled=bool(run.get("cancelled")),
                )
            )
    return scraped
