"""BiblioCommons library event calendars (Boston Public Library), via the gateway API.

`url` is the library's events search endpoint, e.g.
https://gateway.bibliocommons.com/v2/libraries/bpl/events/search. Options:
  query: search terms (default "jazz")
  site:  public events site for links (default https://<library>.bibliocommons.com)

Only concerts and performances for adult or general audiences are kept; story times and
children's music sessions are not. Branch names go in the title, since the registry holds
the library as one venue.
"""

from datetime import datetime
from urllib.parse import urlencode, urlsplit

from jazzcal.adapters import HORIZON, adapter, clean, html_to_text, to_local
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

MAX_PAGES = 10
PERFORMANCE_TYPES = {"Concerts", "Performing Arts"}


@adapter("bibliocommons")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    library = urlsplit(source.url).path.split("/libraries/")[1].split("/")[0]
    site = source.options.get("site", f"https://{library}.bibliocommons.com")
    events = []
    for page in range(1, MAX_PAGES + 1):
        query = urlencode({"q": source.options.get("query", "jazz"), "limit": 50, "page": page})
        data = http.get(f"{source.url}?{query}").json()
        assert isinstance(data, dict)
        events += parse(data, site=site, now=datetime.now(TZ))
        if page >= data["events"]["pagination"]["pages"]:
            break
    return events


def parse(data: dict, *, site: str, now: datetime) -> list[ScrapedEvent]:
    entities = data["entities"]
    names = {
        kind: {k: v["name"] for k, v in entities.get(kind, {}).items()}
        for kind in ("eventTypes", "eventAudiences", "locations")
    }
    events = []
    for event_id in data["events"]["results"]:
        event = entities["events"][event_id]
        d = event["definition"]
        types = {names["eventTypes"].get(t, "") for t in d.get("typeIds", [])}
        audiences = [names["eventAudiences"].get(a, "") for a in d.get("audienceIds", [])]
        if not types & PERFORMANCE_TYPES:
            continue
        if audiences and all(a.startswith(("Children", "Families", "Teens")) for a in audiences):
            continue
        start = to_local(datetime.fromisoformat(d["start"]))[0]
        if start > now + HORIZON:
            continue
        end = to_local(datetime.fromisoformat(d["end"]))[0] if d.get("end") else None
        branch = names["locations"].get(d.get("branchLocationId") or "")
        title = clean(d.get("title"))
        if not title:
            continue
        events.append(
            ScrapedEvent(
                uid=event["id"],
                title=f"{title} ({branch} branch)" if branch else title,
                start=start,
                end=end if end and end > start else None,
                venue_name=branch,
                url=f"{site}/events/{event['id']}",
                categories=sorted(types),
                text=html_to_text(d.get("description") or ""),
                cancelled=bool(d.get("isCancelled")),
            )
        )
    return events
