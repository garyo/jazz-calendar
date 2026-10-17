"""Venues and regulars added on the site's review page.

The site serves them at /api/registry, behind the token the scraper publishes with
(JAZZCAL_PUBLISH_TOKEN). Each scrape saves a copy (`sync`), so builds and offline runs use the
last one, and a run that can't reach the site keeps it. `Registry.load` lists them after
data/venues.yaml and data/regulars.yaml, whose entries win on a shared venue id.
"""

import logging
import os
from datetime import timedelta
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from jazzcal.export import site_url
from jazzcal.http import FetchError, Http
from jazzcal.models import Regular, Venue

log = logging.getLogger(__name__)

PATH = "/api/registry"


class SiteRegistry(BaseModel):
    """What /api/registry serves: in site/src/worker-submissions.ts."""

    venues: list[Venue] = Field(default_factory=list)
    regulars: list[Regular] = Field(default_factory=list)


def load(path: Path) -> SiteRegistry:
    """The last copy saved, or nothing before the first."""
    if not path.exists():
        return SiteRegistry()
    return SiteRegistry.model_validate_json(path.read_text())


def sync(http: Http, path: Path) -> None:
    """Save the site's current venues and regulars to `path`, keeping the last copy when the
    site can't be reached or answers with something unexpected."""
    token = os.environ.get("JAZZCAL_PUBLISH_TOKEN")
    if not token:
        log.warning("JAZZCAL_PUBLISH_TOKEN is not set; using the saved venues and regulars")
        return
    try:
        response = http.get(
            f"{site_url()}{PATH}",
            max_age=timedelta(0),
            headers={"Authorization": f"Bearer {token}"},
        )
        added = SiteRegistry.model_validate(response.json_dict())
    except (FetchError, ValidationError) as e:
        log.warning("couldn't update the site's venues and regulars; keeping the last copy: %s", e)
        return
    log.info("site registry: %d venues, %d regulars", len(added.venues), len(added.regulars))
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".tmp")
    partial.write_text(added.model_dump_json(indent=2))
    partial.replace(path)
