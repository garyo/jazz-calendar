import json
import logging
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
import yaml

from jazzcal import site_registry
from jazzcal.config import Registry
from jazzcal.http import Http
from jazzcal.site_registry import SiteRegistry

SITE = "https://jazz.test"

ADDED = {
    "venues": [
        {"id": "example-room", "name": "The Example Room", "address": "12 Example St",
         "town": "Somerville", "neighborhood": None, "url": "https://example.com/room",
         "jazz_level": "regular"},
        {"id": "club", "name": "Club on the site", "town": "Boston", "jazz_level": "occasional"},
    ],
    "regulars": [
        {"venue": "example-room", "title": "Fictional Trio", "when": "Thursdays, 6-9 pm",
         "days": ["thu"], "nth": [], "relevance": "jazz", "url": "https://example.com/schedule",
         "checked": "2026-10-16"},
        {"venue": "gone", "title": "Orphan Jam", "when": "Mondays", "days": ["mon"], "nth": [],
         "relevance": "jazz", "url": "https://example.com/jam", "checked": "2026-10-16"},
    ],
}  # fmt: skip


def write_data(data_dir: Path) -> None:
    venues = [
        {"id": "club", "name": "Club", "town": "Cambridge", "jazz_level": "dedicated"},
    ]
    regulars = [
        {"venue": "club", "title": "Jam", "when": "Tuesdays", "days": ["tue"],
         "relevance": "jazz", "url": "https://club.example", "checked": "2026-10-01"},
    ]  # fmt: skip
    for name, items in (("venues", venues), ("sources", []), ("regulars", regulars)):
        (data_dir / f"{name}.yaml").write_text(yaml.safe_dump(items))


def test_added_venues_and_regulars_join_the_registry(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    write_data(tmp_path)
    registry = Registry.load(tmp_path, SiteRegistry.model_validate(ADDED))

    assert list(registry.venues) == ["club", "example-room"]
    assert registry.venues["club"].name == "Club"  # venues.yaml wins
    assert registry.resolve_venue("Example Room, 12 Example St") == "example-room"
    assert [r.title for r in registry.regulars] == ["Jam", "Fictional Trio"]
    assert "venue club is in venues.yaml and on the site" in caplog.text
    assert "skipping regular 'Orphan Jam': unknown venue 'gone'" in caplog.text


def test_load_before_the_first_sync(tmp_path: Path) -> None:
    assert site_registry.load(tmp_path / "missing.json") == SiteRegistry()


def http(tmp_path: Path, handle: httpx.MockTransport) -> Http:
    return Http(
        tmp_path / "cache",
        max_age=timedelta(hours=6),
        trusted_hosts={"jazz.test"},
        transport=handle,
    )


@pytest.fixture
def site(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    monkeypatch.setenv("JAZZCAL_SITE", SITE)
    monkeypatch.setenv("JAZZCAL_PUBLISH_TOKEN", "t0k")
    return []


def serve(requests: list[httpx.Request], answer: httpx.Response) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        requests.append(request)
        return answer

    return httpx.MockTransport(handle)


def test_sync_saves_what_the_site_serves(tmp_path: Path, site: list[httpx.Request]) -> None:
    path = tmp_path / "site-registry.json"
    with http(tmp_path, serve(site, httpx.Response(200, json=ADDED))) as client:
        site_registry.sync(client, path)

    assert [str(r.url) for r in site] == [f"{SITE}/api/registry"]
    assert site[0].headers["authorization"] == "Bearer t0k"
    saved = site_registry.load(path)
    assert [v.id for v in saved.venues] == ["example-room", "club"]
    assert saved.regulars[0].when == "Thursdays, 6-9 pm"


@pytest.mark.parametrize(
    "answer",
    [httpx.Response(401), httpx.Response(200, json={"venues": [{"id": "x"}]})],
)
def test_sync_keeps_the_last_copy_on_failure(
    tmp_path: Path,
    site: list[httpx.Request],
    answer: httpx.Response,
    caplog: pytest.LogCaptureFixture,
) -> None:
    path = tmp_path / "site-registry.json"
    path.write_text(json.dumps(ADDED))
    with caplog.at_level(logging.WARNING), http(tmp_path, serve(site, answer)) as client:
        site_registry.sync(client, path)

    assert json.loads(path.read_text()) == ADDED
    assert "keeping the last copy" in caplog.text


def test_sync_needs_the_token(
    tmp_path: Path, site: list[httpx.Request], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("JAZZCAL_PUBLISH_TOKEN")
    with http(tmp_path, serve(site, httpx.Response(200, json=ADDED))) as client:
        site_registry.sync(client, tmp_path / "site-registry.json")
    assert site == []
