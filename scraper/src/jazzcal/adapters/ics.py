"""iCalendar feeds: Trumba, Google Calendar, Events Manager, The Events Calendar's ?ical=1..."""

from datetime import datetime, timedelta

import icalendar
import recurring_ical_events

from jazzcal.adapters import HORIZON, adapter, clean, html_to_text, to_local
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source


@adapter("ics")
def scrape(source: Source, http: Http) -> list[ScrapedEvent]:
    return parse(http.get(source.url).text, now=datetime.now(TZ))


def parse(text: str, *, now: datetime) -> list[ScrapedEvent]:
    calendar = icalendar.Calendar.from_ical(text)
    occurrences = recurring_ical_events.of(calendar).between(now - timedelta(days=1), now + HORIZON)
    events = []
    for vevent in occurrences:
        start, all_day = to_local(vevent.decoded("DTSTART"))
        end = to_local(vevent.decoded("DTEND"))[0] if "DTEND" in vevent else None
        title = clean(str(vevent.get("SUMMARY", "")))
        if not title:
            continue
        description = str(vevent.get("DESCRIPTION", ""))
        fields = _trumba_fields(vevent)
        events.append(
            ScrapedEvent(
                # Occurrences of a repeating event share a UID, so add the start.
                uid=f"{vevent.get('UID', title)}/{start.isoformat()}",
                title=title,
                start=start,
                end=end,
                all_day=all_day,
                # Some feeds append links or an address after a semicolon.
                venue_name=clean(str(vevent.get("LOCATION", "")).split(";")[0]),
                url=clean(str(vevent.get("URL") or vevent.get("X-TRUMBA-LINK") or "")),
                ticket_url=clean(fields.get("Tickets")),
                price=clean(fields.get("Cost")),
                categories=_categories(vevent) + _split(fields, "Event Type", "Category"),
                text=html_to_text(description) if "<" in description else clean(description),
                cancelled=str(vevent.get("STATUS", "")).upper() == "CANCELLED",
            )
        )
    return events


def _categories(vevent: icalendar.Event) -> list[str]:
    categories = vevent.get("CATEGORIES")
    if categories is None:
        return []
    groups = categories if isinstance(categories, list) else [categories]
    return [str(c) for group in groups for c in group.cats]


def _trumba_fields(vevent: icalendar.Event) -> dict[str, str]:
    """Trumba's X-TRUMBA-CUSTOMFIELD properties by NAME; repeated names are comma-joined."""
    props = vevent.get("X-TRUMBA-CUSTOMFIELD")
    if props is None:
        return {}
    fields: dict[str, str] = {}
    for prop in props if isinstance(props, list) else [props]:
        name = prop.params.get("NAME")
        value = str(prop).replace("\\,", ",").replace("\\;", ";").strip()
        if name and value:
            fields[name] = f"{fields[name]},{value}" if name in fields else value
    return fields


def _split(fields: dict[str, str], *names: str) -> list[str]:
    return [v.strip() for n in names for v in fields.get(n, "").split(",") if v.strip()]
