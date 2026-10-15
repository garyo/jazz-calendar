import base64
import json
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from jazzcal import notify, pipeline
from jazzcal.config import TZ, Registry
from jazzcal.models import Source
from jazzcal.store import Store

NOW = datetime(2026, 10, 15, 12, tzinfo=TZ)


@pytest.fixture
def ntfy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NTFY_USER", "bot")
    monkeypatch.setenv("NTFY_PASS", "pw")
    monkeypatch.setenv("NTFY_URL", "https://ntfy.example/")
    monkeypatch.setenv("NTFY_TOPIC", "alerts")


def test_send_publishes_json_to_the_server_root(ntfy_env: None) -> None:
    sent: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200)

    assert notify.send("Title", "Body", transport=httpx.MockTransport(handle))
    [request] = sent
    assert (request.method, request.url.host, request.url.path) == ("POST", "ntfy.example", "/")
    assert request.headers["authorization"] == "Basic " + base64.b64encode(b"bot:pw").decode()
    assert json.loads(request.content) == {
        "topic": "alerts",
        "title": "Title",
        "message": "Body",
        "tags": ["warning"],
    }


def test_send_without_credentials_does_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NTFY_USER", raising=False)
    monkeypatch.delenv("NTFY_PASS", raising=False)

    def handle(request: httpx.Request) -> httpx.Response:
        raise AssertionError("sent without credentials")

    assert not notify.send("Title", "Body", transport=httpx.MockTransport(handle))


@pytest.mark.parametrize("failure", [httpx.Response(500), httpx.ConnectError("down")])
def test_send_failures_never_raise(
    ntfy_env: None, failure: httpx.Response | httpx.ConnectError
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if isinstance(failure, Exception):
            raise failure
        return failure

    assert not notify.send("Title", "Body", transport=httpx.MockTransport(handle))


class Outbox:
    def __init__(self, delivered: bool = True) -> None:
        self.delivered = delivered
        self.sent: list[tuple[str, str]] = []

    def __call__(self, title: str, message: str) -> bool:
        self.sent.append((title, message))
        return self.delivered


@pytest.fixture
def registry() -> Registry:
    sources = [
        Source(id="a", adapter="ics", url="https://a"),
        Source(id="b", adapter="ics", url="https://b"),
        Source(id="off", adapter="ics", url="https://c", enabled=False),
    ]
    return Registry({}, sources)


def test_alert_when_sources_keep_failing(registry: Registry, tmp_path: Path) -> None:
    store = Store(tmp_path / "test.db")
    outbox = Outbox()

    def run(now: datetime = NOW, **errors: str) -> None:
        for source in ("a", "b", "off"):
            if source in errors:
                store.record_failure(source, errors[source])
            else:
                store.record_success(source, [])
        pipeline.alert_failing(registry, store, now, outbox)

    run(a="HTTP 503 for https://a?apikey=s3cret", off="HTTP 404")
    assert outbox.sent == []
    run(a="HTTP 503 for https://a?apikey=s3cret", off="HTTP 404")
    assert outbox.sent == [
        ("Boston Jazz Calendar: 1 source failing", "a (2 runs): HTTP 503 for https://a?apikey=REDACTED")
    ]  # fmt: skip
    # Not again while it keeps failing, until a week has passed...
    run(NOW + timedelta(days=1), a="HTTP 503")
    assert len(outbox.sent) == 1
    # ...or another source starts failing too; that digest lists both.
    run(NOW + timedelta(days=2), a="HTTP 503", b="0 events (had 3 upcoming last run)")
    run(NOW + timedelta(days=3), a="HTTP 503", b="0 events (had 3 upcoming last run)")
    assert outbox.sent[1:] == [
        ("Boston Jazz Calendar: 2 sources failing",
         "a (5 runs): HTTP 503\nb (2 runs): 0 events (had 3 upcoming last run)")
    ]  # fmt: skip
    run(NOW + timedelta(days=9), a="HTTP 503", b="HTTP 503")
    assert len(outbox.sent) == 2
    run(NOW + timedelta(days=10), a="HTTP 503", b="HTTP 503")
    assert len(outbox.sent) == 3
    # A success starts the count over.
    run(NOW + timedelta(days=11), b="HTTP 503")
    run(NOW + timedelta(days=12), a="HTTP 503", b="HTTP 503")
    assert len(outbox.sent) == 3
    run(NOW + timedelta(days=13), a="HTTP 503", b="HTTP 503")
    assert outbox.sent[-1][0] == "Boston Jazz Calendar: 2 sources failing"


def test_undelivered_alert_is_retried_next_run(registry: Registry, tmp_path: Path) -> None:
    store = Store(tmp_path / "test.db")
    for _ in range(2):
        store.record_failure("a", "HTTP 503")
    outbox = Outbox(delivered=False)
    pipeline.alert_failing(registry, store, NOW, outbox)
    pipeline.alert_failing(registry, store, NOW, outbox)
    assert len(outbox.sent) == 2
