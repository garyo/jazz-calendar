"""Paths and the venue/source registries in data/."""

import os
import re
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml
from pydantic import Field, TypeAdapter

from jazzcal.models import Regular, Source, Venue

TZ = ZoneInfo("America/New_York")

ROOT = Path(os.environ.get("JAZZCAL_ROOT", Path(__file__).resolve().parents[3]))
DATA_DIR = ROOT / "data"
VAR_DIR = Path(os.environ.get("JAZZCAL_VAR", ROOT / "scraper" / "var"))


class VenueConfig(Venue):
    aliases: list[str] = Field(
        default_factory=list, description="Other names sources use for this venue"
    )

    def public(self) -> Venue:
        return Venue.model_validate(self.model_dump(exclude={"aliases"}))


def normalize_name(name: str) -> str:
    name = name.lower().replace("&", " and ")
    name = re.sub(r"[^a-z0-9]+", " ", name)
    return re.sub(r"^the ", "", name.strip())


STREET_ABBREVIATIONS = {"massachusetts": "mass", "commonwealth": "comm", "saint": "st"}


def address_key(address: str) -> str | None:
    """House number, first word of the street, and town: '265 Mass Ave, Cambridge, MA' ->
    '265 mass cambridge'. None when the text doesn't start with a street address."""
    m = re.match(
        r"\s*(?:one|(\d+)[a-z]?(?:-\d+)?)\s+([a-z]+)\b[^,]*,\s*([a-z .]+?)(?:,|$)", address.lower()
    )
    if not m:
        return None
    number = m.group(1) or "1"
    street = STREET_ABBREVIATIONS.get(m.group(2), m.group(2))
    return f"{number} {street} {m.group(3).strip()}"


@dataclass
class Registry:
    venues: dict[str, VenueConfig]
    sources: list[Source]
    regulars: list[Regular] = field(default_factory=list)

    @classmethod
    def load(cls, data_dir: Path = DATA_DIR) -> "Registry":
        venues = TypeAdapter(list[VenueConfig]).validate_python(
            _load_yaml(data_dir / "venues.yaml")
        )
        sources = TypeAdapter(list[Source]).validate_python(_load_yaml(data_dir / "sources.yaml"))
        regulars = TypeAdapter(list[Regular]).validate_python(
            _load_yaml(data_dir / "regulars.yaml")
        )
        for ids, kind in (([v.id for v in venues], "venue"), ([s.id for s in sources], "source")):
            if dupes := {i for i in ids if ids.count(i) > 1}:
                raise ValueError(f"duplicate {kind} ids: {sorted(dupes)}")
        registry = cls({v.id: v for v in venues}, sources, regulars)
        for r in regulars:
            if r.venue not in registry.venues:
                raise ValueError(f"regular {r.title!r} refers to unknown venue {r.venue!r}")
        for s in sources:
            if s.enabled and not s.credit:
                raise ValueError(f"source {s.id!r} needs a credit: a name and an https url")
            if s.venue and s.venue not in registry.venues:
                raise ValueError(f"source {s.id!r} refers to unknown venue {s.venue!r}")
            if s.options.get("unknown", "other") not in ("jazz", "adjacent", "other"):
                raise ValueError(f"source {s.id!r}: unknown must be jazz, adjacent or other")
        return registry

    @cached_property
    def _by_name(self) -> dict[str, str]:
        index = {}
        for v in self.venues.values():
            for name in (v.name, *v.aliases):
                index[normalize_name(name)] = v.id
        return index

    @cached_property
    def _by_address(self) -> dict[str, str]:
        return {
            key: v.id
            for v in self.venues.values()
            if v.address and (key := address_key(f"{v.address}, {v.town}"))
        }

    def resolve_venue(self, name: str) -> str | None:
        """Venue id for a venue as a source gives it: by name, alias, or street address.

        Sources often append a room or address ("Jordan Hall at NEC, 30 Gainsborough St"), so a
        known name at the start of the given one also matches.
        """
        key = normalize_name(name)
        if key in self._by_name:
            return self._by_name[key]
        for known, venue_id in self._by_name.items():
            if key.startswith(known + " "):
                return venue_id
        address = address_key(name)
        return self._by_address.get(address) if address else None

    def source(self, source_id: str) -> Source:
        for s in self.sources:
            if s.id == source_id:
                return s
        raise KeyError(f"no source {source_id!r}")


def _load_yaml(path: Path) -> list[object]:
    return yaml.safe_load(path.read_text()) or []
