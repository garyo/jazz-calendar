import threading
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from jazzcal import cli, export, runlock, site_registry
from jazzcal import http as http_module
from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import EventsFile

SITE = "https://jazz.test"
LAST_FULL_BUILD = datetime(2026, 10, 17, 5, 41, tzinfo=TZ)


class Site:
    """The site's registry and approved gigs, counting requests for each."""

    def __init__(self) -> None:
        self.revision: int | None = 3
        self.run: dict[str, object] | None = None
        self.requests: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/robots.txt":
            return httpx.Response(404)
        self.requests.append(path)
        if path == "/api/registry":
            if self.revision is None:
                return httpx.Response(401)
            return httpx.Response(200, json={"revision": self.revision, "run": self.run})
        gig = {
            "id": "0b6f2d1e-8a3c-4f5e-9d7a-1c2b3a4d5e6f",
            "title": "The Fictional Quartet",
            "date": (date.today() + timedelta(days=5)).isoformat(),
            "start_time": "20:00",
            "end_time": None,
            "venue": "lilypad",
            "price": None,
            "url": "https://example.com/gig",
            "relevance": "jazz",
        }
        return httpx.Response(200, json={"submissions": [gig]})


@pytest.fixture
def site(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Site:
    monkeypatch.setenv("JAZZCAL_SITE", SITE)
    monkeypatch.setenv("JAZZCAL_PUBLISH_TOKEN", "t0k")
    monkeypatch.setattr(http_module, "MIN_INTERVAL", 0)
    for name in ("SITE_REGISTRY", "PUBLISHED", "DB"):
        monkeypatch.setattr(cli, name, tmp_path / name.lower())
    monkeypatch.setattr(cli, "OUT_DIR", tmp_path / "out")
    (tmp_path / "out").mkdir()
    feed = EventsFile(generated_at=LAST_FULL_BUILD, venues=[], events=[])
    (tmp_path / "out" / "events.json").write_text(feed.model_dump_json())
    return Site()


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[tuple[list[str], bool]]:
    calls: list[tuple[list[str], bool]] = []

    def publish(out_dir: Path, names: list[str], *, ping: bool = True) -> None:
        calls.append((list(names), ping))

    monkeypatch.setattr(export, "publish", publish)
    return calls


def mock_http(site: Site, tmp_path: Path) -> Http:
    return Http(
        tmp_path / "cache",
        max_age=timedelta(hours=6),
        trusted_hosts={"jazz.test"},
        transport=httpx.MockTransport(site.handle),
    )


def refresh(site: Site, tmp_path: Path) -> bool:
    with mock_http(site, tmp_path) as http:
        return cli.refresh(http, classifier=None, lookup=None)


@pytest.fixture
def reports(
    site: Site, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> list[tuple[int, str, str | None]]:
    """What `jazzcal requested` tells the site, which says the run is its to take."""
    calls: list[tuple[int, str, str | None]] = []

    def report(run: site_registry.RunRequest, status: str, error: str | None = None) -> bool:
        calls.append((run.id, status, error))
        return True

    monkeypatch.setattr(site_registry, "report", report)
    monkeypatch.setattr(cli, "_http", lambda offline, max_age_hours: mock_http(site, tmp_path))
    return calls


def test_refresh_publishes_each_revision_once(
    site: Site, published: list[tuple[list[str], bool]], tmp_path: Path
) -> None:
    refresh(site, tmp_path)
    assert site.requests == ["/api/registry", "/api/submissions/approved"]
    assert published == [(["events.json"], False)]
    feed = EventsFile.model_validate_json((cli.OUT_DIR / "events.json").read_text())
    assert [e.title for e in feed.events] == ["The Fictional Quartet"]
    assert feed.generated_at == LAST_FULL_BUILD

    site.requests.clear()
    refresh(site, tmp_path)
    assert site.requests == ["/api/registry"]
    assert len(published) == 1

    site.revision = 4
    refresh(site, tmp_path)
    assert len(published) == 2


def test_refresh_after_a_full_run_does_nothing(
    site: Site, published: list[tuple[list[str], bool]], tmp_path: Path
) -> None:
    cli.PUBLISHED.write_text("3\n")  # as `jazzcal run --publish` leaves it
    refresh(site, tmp_path)
    assert site.requests == ["/api/registry"]
    assert published == []


def test_refresh_does_nothing_without_the_site(
    site: Site, published: list[tuple[list[str], bool]], tmp_path: Path
) -> None:
    site.revision = None
    refresh(site, tmp_path)
    assert published == []
    assert not cli.PUBLISHED.exists()


def test_a_second_run_waits_for_the_lock(tmp_path: Path) -> None:
    lock = tmp_path / "jazzcal.lock"
    order: list[str] = []
    entered = threading.Event()

    def second() -> None:
        entered.set()
        with runlock.held(lock):
            order.append("second")

    with runlock.held(lock):
        thread = threading.Thread(target=second)
        thread.start()
        entered.wait()
        thread.join(timeout=0.2)
        assert thread.is_alive()  # still waiting
        order.append("first")
    thread.join(timeout=5)
    assert order == ["first", "second"]


def test_refresh_leaves_a_requested_run_to_jazzcal_requested(
    site: Site, published: list[tuple[list[str], bool]], tmp_path: Path
) -> None:
    site.run = {"id": 7, "kind": "rebuild", "source": None}
    assert refresh(site, tmp_path)
    assert published == []
    assert not cli.PUBLISHED.exists()


def test_a_requested_rebuild_republishes_and_reports(
    site: Site,
    published: list[tuple[list[str], bool]],
    reports: list[tuple[int, str, str | None]],
    tmp_path: Path,
) -> None:
    site.revision = 3
    cli.PUBLISHED.write_text("3\n")  # nothing new: a rebuild republishes all the same
    site.run = {"id": 7, "kind": "rebuild", "source": None}
    refresh(site, tmp_path)
    site.run = None
    cli.requested(classifier=None, lookup=None)
    assert reports == [(7, "running", None), (7, "done", None)]
    assert published == [(["events.json"], False)]


def test_a_requested_run_that_fails_says_why(
    site: Site,
    published: list[tuple[list[str], bool]],
    reports: list[tuple[int, str, str | None]],
    tmp_path: Path,
) -> None:
    site.run = {"id": 8, "kind": "source", "source": "nowhere"}
    refresh(site, tmp_path)
    with pytest.raises(KeyError):
        cli.requested(classifier=None, lookup=None)
    assert reports == [(8, "running", None), (8, "failed", "KeyError: \"no source 'nowhere'\"")]
    assert published == []


def test_a_run_another_process_took_is_left_alone(
    site: Site,
    published: list[tuple[list[str], bool]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    site.run = {"id": 9, "kind": "full", "source": None}
    refresh(site, tmp_path)
    monkeypatch.setattr(site_registry, "report", lambda run, status, error=None: False)
    cli.requested(classifier=None, lookup=None)
    assert published == []
