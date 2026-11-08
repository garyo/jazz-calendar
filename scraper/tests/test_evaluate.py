from datetime import datetime, timedelta
from pathlib import Path

import pytest
import yaml

from jazzcal import evaluate
from jazzcal.config import TZ, Registry, VenueConfig
from jazzcal.models import ScrapedEvent, Source
from jazzcal.site_registry import act_key
from jazzcal.store import Store

NOW = datetime(2026, 11, 7, 12, tzinfo=TZ)


def event(uid: str, title: str, days: float) -> ScrapedEvent:
    return ScrapedEvent(uid=uid, title=title, start=NOW + timedelta(days=days))


def test_labels_outlive_their_listings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    labels = tmp_path / "labels.yaml"
    labels.write_text(
        yaml.safe_dump(
            [
                {"source": "s", "title": "Pat Doe", "label": "jazz"},
                {"source": "s", "title": "Never Seen", "label": "jazz"},
            ]
        )
    )
    monkeypatch.setattr(evaluate, "LABELS", labels)
    room = VenueConfig.model_validate(
        {"id": "room", "name": "Room", "town": "Boston", "jazz_level": "occasional"}
    )
    registry = Registry(
        {"room": room}, [Source(id="s", adapter="ics", url="https://a", venue="room")]
    )
    registry.rulings[act_key("room", "Lee Roe")] = "other"
    store = Store(tmp_path / "test.db")
    store.record_success("s", [event("1", "Pat Doe", -40), event("2", "Lee Roe", 3)])
    store.save_labeled("s", "room", event("2", "Lee Roe", 3))  # as a build does for rulings

    first, missing = evaluate._cases(registry, store)
    assert sorted(c.title for c in first) == ["Lee Roe", "Pat Doe"]
    assert missing == ["Never Seen"]

    # The source drops both and the store prunes them; their copies still count.
    for _ in range(3):
        store.record_success("s", [])
    store.prune(NOW)
    assert store.current("s") == []
    later, _ = evaluate._cases(registry, store)
    assert [(c.title, c.label) for c in later] == [("Pat Doe", "jazz"), ("Lee Roe", "other")]
