"""Write the published files, and upload them to the site."""

import logging
import os
from datetime import timedelta
from pathlib import Path

import httpx
import icalendar

from jazzcal.config import TZ
from jazzcal.models import Event, EventsFile, SourceCredit, StatusFile

log = logging.getLogger(__name__)

SITE = "https://bostonjazzcalendar.com"
FILES = {
    "events.json": "application/json",
    "status.json": "application/json",
    "calendar.ics": "text/calendar; charset=utf-8",
}


def write(out_dir: Path, feed: EventsFile, status: StatusFile) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "events.json").write_text(feed.model_dump_json(indent=1))
    (out_dir / "status.json").write_text(status.model_dump_json(indent=1))
    (out_dir / "calendar.ics").write_bytes(to_ics(feed))


def to_ics(feed: EventsFile) -> bytes:
    cal = icalendar.Calendar()
    cal.add("prodid", "-//bostonjazzcalendar.com//jazzcal//EN")
    cal.add("version", "2.0")
    cal.add("x-wr-calname", "Boston Jazz Calendar")
    cal.add("x-wr-timezone", "America/New_York")
    cal.add("refresh-interval", timedelta(hours=12))
    venues = {v.id: v for v in feed.venues}
    credits = {s.id: s for s in feed.sources}
    for e in feed.events:
        venue = venues[e.venue]
        vevent = icalendar.Event()
        vevent.add("uid", f"{e.id}@bostonjazzcalendar.com")
        vevent.add("dtstamp", feed.generated_at)
        vevent.add("summary", f"{e.title} @ {venue.name}")
        # Times come back from JSON with bare UTC offsets; name the zone so clients get a
        # proper TZID and VTIMEZONE.
        if e.all_day:
            vevent.add("dtstart", e.start.astimezone(TZ).date())
        else:
            vevent.add("dtstart", e.start.astimezone(TZ))
            if e.end:
                vevent.add("dtend", e.end.astimezone(TZ))
        vevent.add("location", ", ".join(p for p in (venue.name, venue.address, venue.town) if p))
        vevent.add("url", e.url)
        lines = [e.price or "", f"Details: {e.url}"]
        if e.ticket_url:
            lines.append(f"Tickets: {e.ticket_url}")
        lines += [f"Listing via {c.name}: {c.url}" for c in via_credits(e, credits)]
        vevent.add("description", "\n".join(line for line in lines if line))
        if e.cancelled:
            vevent.add("status", "CANCELLED")
        cal.add_component(vevent)
    cal.add_missing_timezones()
    return cal.to_ical()


def via_credits(event: Event, credits: dict[str, SourceCredit]) -> list[SourceCredit]:
    """The third parties an event's listings came through, once each, in priority order."""
    found: dict[str, SourceCredit] = {}
    for source_id in event.sources:
        credit = credits.get(source_id)
        if credit and credit.via:
            found.setdefault(credit.name, credit)
    return list(found.values())


def site_url() -> str:
    """The site's origin: $JAZZCAL_SITE, or the production site."""
    return os.environ.get("JAZZCAL_SITE", SITE).rstrip("/")


def publish(out_dir: Path) -> None:
    """Upload the written files through the site's publish API."""
    site = site_url()
    token = os.environ.get("JAZZCAL_PUBLISH_TOKEN")
    if not token:
        raise SystemExit("set JAZZCAL_PUBLISH_TOKEN to publish")
    with httpx.Client(timeout=60) as client:
        for name, content_type in FILES.items():
            resp = client.put(
                f"{site}/api/publish/{name}",
                content=(out_dir / name).read_bytes(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": content_type},
            )
            resp.raise_for_status()
            log.info("published %s", name)
        if healthcheck := os.environ.get("JAZZCAL_HEALTHCHECK_URL"):
            client.get(healthcheck)
