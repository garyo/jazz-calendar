"""Write the published files, and upload them to the site.

The site builds its /calendar.ics feeds from events.json.
"""

import logging
import os
import time
from pathlib import Path

import httpx

from jazzcal.models import EventsFile, StatusFile

log = logging.getLogger(__name__)

SITE = "https://bostonjazzcalendar.com"
FILES = {
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
