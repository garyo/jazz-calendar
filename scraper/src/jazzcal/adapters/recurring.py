"""Residencies that venues don't list by date: weekly jams, jazz brunches, house bands.

Nothing is fetched; occurrences come from the schedule in the source's options:
  title:  event title
  days:   weekdays, e.g. [tue, wed]
  start:  "19:00";  end: "21:00" (optional)
  nth:    only these weeks of the month, e.g. [1, 3] for first and third (optional)
  price:  (optional)
  until:  last date, YYYY-MM-DD (optional)
  weeks:  how far ahead to generate (default 6)
"""

from datetime import date, datetime, time, timedelta

from jazzcal.adapters import adapter
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


@adapter("recurring")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    return occurrences(source, datetime.now(TZ).date())


def occurrences(source: Source, today: date) -> list[ScrapedEvent]:
    o = source.options
    weekdays = {DAYS.index(d.lower()[:3]) for d in o["days"]}
    start_time = time.fromisoformat(o["start"])
    end_time = time.fromisoformat(o["end"]) if o.get("end") else None
    last = min(
        today + timedelta(weeks=o.get("weeks", 6)),
        date.fromisoformat(str(o["until"])) if o.get("until") else date.max,
    )
    events = []
    day = today
    while day <= last:
        if day.weekday() in weekdays and (not o.get("nth") or (day.day - 1) // 7 + 1 in o["nth"]):
            start = datetime.combine(day, start_time, TZ)
            end = datetime.combine(day, end_time, TZ) if end_time else None
            if end and end <= start:
                end += timedelta(days=1)
            events.append(
                ScrapedEvent(
                    uid=day.isoformat(),
                    title=o["title"],
                    start=start,
                    end=end,
                    url=source.url,
                    price=o.get("price"),
                )
            )
        day += timedelta(days=1)
    return events
