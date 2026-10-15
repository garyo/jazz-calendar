"""Write the published files, and upload them to the site."""

import logging
import os
import time
from datetime import timedelta
from pathlib import Path

import httpx
import icalendar

from jazzcal.config import TZ
from jazzcal.models import Event, EventsFile, SourceCredit, StatusFile

log = logging.getLogger(__name__)

SITE = "https://bostonjazzcalendar.com"
FILES = {
    "calendar.ics": "text/calendar; charset=utf-8",
    "events.json": "application/json",
    "status.json": "application/json",
}
"""Uploaded in this order: status.json last, so it describes a publish that completed."""
PUT_RETRIES = 3
PUT_BACKOFF = 2.0
"""Seconds before the first retry of an upload; doubled for each one after."""


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


def publish(out_dir: Path, transport: httpx.BaseTransport | None = None) -> None:
    """Upload the written files through the site's publish API."""
    site = site_url()
    token = os.environ.get("JAZZCAL_PUBLISH_TOKEN")
    if not token:
        raise SystemExit("set JAZZCAL_PUBLISH_TOKEN to publish")
    with httpx.Client(timeout=60, transport=transport) as client:
        for name, content_type in FILES.items():
            _put(
                client,
                f"{site}/api/publish/{name}",
                (out_dir / name).read_bytes(),
                {"Authorization": f"Bearer {token}", "Content-Type": content_type},
            )
            log.info("published %s", name)
        if healthcheck := os.environ.get("JAZZCAL_HEALTHCHECK_URL"):
            # The publish went through; a monitoring hiccup mustn't fail the run.
            try:
                client.get(healthcheck).raise_for_status()
            except httpx.HTTPError as e:
                log.warning("healthcheck ping failed: %s", e)


def _put(client: httpx.Client, url: str, content: bytes, headers: dict[str, str]) -> None:
    """PUT, retrying server errors and failed connections."""
    for attempt in range(PUT_RETRIES + 1):
        try:
            resp = client.put(url, content=content, headers=headers)
        except httpx.TransportError as e:
            if attempt == PUT_RETRIES:
                raise
            problem = type(e).__name__
        else:
            if resp.status_code < 500 or attempt == PUT_RETRIES:
                resp.raise_for_status()
                return
            problem = f"HTTP {resp.status_code}"
        pause = PUT_BACKOFF * 2**attempt
        log.warning("%s uploading %s; retrying in %.0f s", problem, url, pause)
        time.sleep(pause)
