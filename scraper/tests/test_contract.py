"""The contracts between the scraper, its data and the site."""

import json
import re
from pathlib import Path

from jazzcal.adapters.submissions import ApprovedGig
from jazzcal.config import ROOT, Registry
from jazzcal.models import EventsFile, feed_schema

SCHEMA = ROOT / "schema"
SITE_SOURCE = ROOT / "site" / "src"


def test_published_schema_is_current() -> None:
    written = json.loads((SCHEMA / "events.schema.json").read_text())
    assert written == feed_schema(), (
        "schema/events.schema.json is stale: run `uv run jazzcal schema`"
    )


def test_sample_feed_is_valid() -> None:
    EventsFile.model_validate_json((SCHEMA / "sample-events.json").read_text())


def test_registry_in_data_loads() -> None:
    registry = Registry.load()
    assert registry.sources and registry.venues


def _ts_interface_fields(path: Path, name: str) -> list[str]:
    match = re.search(rf"interface {name} \{{(.*?)\n\}}", path.read_text(), re.DOTALL)
    assert match, f"no interface {name} in {path}"
    return re.findall(r"^\s*(\w+)\??:", match[1], re.MULTILINE)


def _public_columns() -> list[str]:
    for path in sorted(SITE_SOURCE.glob("*.ts")):
        if match := re.search(r"PUBLIC_COLUMNS\s*=\s*\"([^\"]*)\"", path.read_text()):
            return [c.strip() for c in match[1].split(",")]
    raise AssertionError(f"no PUBLIC_COLUMNS in {SITE_SOURCE}")


def test_approved_gig_matches_the_site() -> None:
    fields = list(ApprovedGig.model_fields)
    assert _ts_interface_fields(SITE_SOURCE / "submission.ts", "ApprovedGig") == fields
    assert _public_columns() == fields
