"""Venues, regulars and hidden listings managed on the site's review page.

Hidden listings live there, not in data/, so the public repo never records who asked to be
left out. The site serves all three at /api/registry, behind the token the scraper publishes
with (JAZZCAL_PUBLISH_TOKEN), with the feed's revision: a count of the changes to what the feed
shows, so a run can tell whether anything changed since the last publish. Each scrape saves a
copy (`sync`), so builds and offline runs use the last one, and a run that can't reach the site
keeps it. `Registry.load` lists them after data/venues.yaml and data/regulars.yaml, whose
entries win on a shared venue id.
"""

import logging
import os
import re
from datetime import date, timedelta
from functools import cache
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError, model_validator

from jazzcal.export import site_url
from jazzcal.http import FetchError, Http
from jazzcal.models import Regular, Venue

log = logging.getLogger(__name__)

PATH = "/api/registry"


class Hidden(BaseModel):
    """A listing left out on request: `Hidden` in site/src/submission.ts. Every field given
    must match."""

    title: str | None = Field(None, description="Words in the title: whole words, any case")
    venue: str | None = Field(None, description="Venue id")
    night: date | None = Field(
        None, description="The night it's listed under (a set after midnight is the night before)"
    )
    requested: date

    @model_validator(mode="after")
    def _specific(self) -> "Hidden":
        if not (self.title or (self.venue and self.night)):
            raise ValueError("a hidden listing needs a title, or a venue and a night")
        return self

    def matches(self, venue: str, title: str, night: date | None) -> bool:
        """Whether this hides a listing; a weekly regular has no `night`."""
        return (
            (self.venue is None or self.venue == venue)
            and (self.night is None or self.night == night)
            and (self.title is None or _words(self.title).search(title) is not None)
        )


@cache
def _words(text: str) -> re.Pattern[str]:
    """Matches the words as whole words, ignoring case and spacing."""
    words = r"\s+".join(re.escape(word) for word in text.split())
    return re.compile(rf"(?<!\w){words}(?!\w)", re.IGNORECASE)


class SiteRegistry(BaseModel):
    """What /api/registry serves: in site/src/worker-submissions.ts."""

    revision: int | None = None
    venues: list[Venue] = Field(default_factory=list)
    regulars: list[Regular] = Field(default_factory=list)
    hidden: list[Hidden] = Field(default_factory=list)


def load(path: Path) -> SiteRegistry:
    """The last copy saved, or nothing before the first."""
    if not path.exists():
        return SiteRegistry()
    return SiteRegistry.model_validate_json(path.read_text())


def sync(http: Http, path: Path) -> SiteRegistry | None:
    """Save the site's current venues and regulars to `path` and return them. None, keeping the
    last copy, when the site can't be reached or answers with something unexpected."""
    token = os.environ.get("JAZZCAL_PUBLISH_TOKEN")
    if not token:
        log.warning("JAZZCAL_PUBLISH_TOKEN is not set; using the saved venues and regulars")
        return None
    try:
        response = http.get(
            f"{site_url()}{PATH}",
            max_age=timedelta(0),
            headers={"Authorization": f"Bearer {token}"},
        )
        added = SiteRegistry.model_validate(response.json_dict())
    except (FetchError, ValidationError) as e:
        log.warning("couldn't update the site's venues and regulars; keeping the last copy: %s", e)
        return None
    log.info("site registry: %d venues, %d regulars", len(added.venues), len(added.regulars))
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".tmp")
    partial.write_text(added.model_dump_json(indent=2))
    partial.replace(path)
    return added
