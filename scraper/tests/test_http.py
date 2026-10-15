from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from jazzcal import http as http_module
from jazzcal.http import Disallowed, FetchError, Http

Handler = Callable[[httpx.Request], httpx.Response]


class Clock:
    """Stands in for the time module: sleeping only advances the clock."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class Server:
    """Canned responses by URL, recording each request and when it came."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.routes: dict[str, httpx.Response | Handler] = {}
        self.requests: list[tuple[float, httpx.Request]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((self.clock.now, request))
        route = self.routes.get(str(request.url), httpx.Response(404))
        return route if isinstance(route, httpx.Response) else route(request)

    def urls(self) -> list[str]:
        return [str(r.url) for _, r in self.requests]


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    clock = Clock()
    monkeypatch.setattr(http_module, "time", clock)
    return clock


@pytest.fixture
def server(clock: Clock) -> Server:
    return Server(clock)


@pytest.fixture
def today(monkeypatch: pytest.MonkeyPatch) -> list[datetime]:
    """The wall clock the cache sees; tests move it by replacing today[0]."""
    now = [datetime(2026, 10, 15, 12, tzinfo=UTC)]
    monkeypatch.setattr(http_module, "_now", lambda: now[0])
    return now


def client(server: Server, tmp_path: Path, *, offline: bool = False) -> Http:
    return Http(
        tmp_path / "cache",
        offline=offline,
        max_age=timedelta(hours=6),
        transport=httpx.MockTransport(server),
    )


def test_robots_disallow_with_wildcards(server: Server, tmp_path: Path, today: object) -> None:
    server.routes["https://club.example/robots.txt"] = httpx.Response(
        200, text="User-agent: *\nDisallow: /private/\nDisallow: /*.pdf$\n"
    )
    server.routes["https://club.example/events"] = httpx.Response(200, text="ok")
    with client(server, tmp_path) as http:
        assert http.get("https://club.example/events").text == "ok"
        with pytest.raises(Disallowed):
            http.get("https://club.example/private/list")
        with pytest.raises(Disallowed):
            http.get("https://club.example/files/menu.pdf")
    assert server.urls() == ["https://club.example/robots.txt", "https://club.example/events"]


def test_robots_for_our_bot(server: Server, tmp_path: Path, today: object) -> None:
    server.routes["https://club.example/robots.txt"] = httpx.Response(
        200, text="User-agent: BostonJazzCalendarBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    )
    with client(server, tmp_path) as http, pytest.raises(Disallowed):
        http.get("https://club.example/events")


def test_missing_robots_allows_everything(server: Server, tmp_path: Path, today: object) -> None:
    server.routes["https://club.example/events"] = httpx.Response(200, text="ok")
    with client(server, tmp_path) as http:
        assert http.get("https://club.example/events").text == "ok"


def test_requests_to_a_host_are_spaced_by_crawl_delay(
    server: Server, clock: Clock, tmp_path: Path, today: object
) -> None:
    server.routes["https://club.example/robots.txt"] = httpx.Response(
        200, text="User-agent: *\nCrawl-delay: 10\n"
    )
    server.routes["https://club.example/a"] = httpx.Response(200, text="a")
    server.routes["https://club.example/b"] = httpx.Response(200, text="b")
    server.routes["https://other.example/c"] = httpx.Response(200, text="c")
    with client(server, tmp_path) as http:
        for url in ("https://club.example/a", "https://club.example/b", "https://other.example/c"):
            http.get(url)
    times = {str(r.url): t for t, r in server.requests}
    assert times["https://club.example/a"] - times["https://club.example/robots.txt"] == 10
    assert times["https://club.example/b"] - times["https://club.example/a"] == 10
    # Another host isn't held up by this one's delay.
    assert times["https://other.example/robots.txt"] == times["https://club.example/b"]


def test_cache_freshness_and_conditional_get(
    server: Server, tmp_path: Path, today: list[datetime]
) -> None:
    url = "https://club.example/events"
    server.routes[url] = httpx.Response(200, text="v1", headers={"ETag": '"v1"'})
    with client(server, tmp_path) as http:
        assert not http.get(url).from_cache
        fresh = http.get(url)
        assert (fresh.text, fresh.from_cache) == ("v1", True)
        assert server.urls().count(url) == 1

        today[0] += timedelta(hours=7)
        server.routes[url] = lambda request: (
            httpx.Response(304)
            if request.headers.get("if-none-match") == '"v1"'
            else httpx.Response(200, text="v2")
        )
        revalidated = http.get(url)
        assert (revalidated.text, revalidated.from_cache) == ("v1", True)
        assert server.urls().count(url) == 2
        # The 304 renews the cache entry.
        assert http.get(url).from_cache
        assert server.urls().count(url) == 2
        # A page's own max_age overrides the client's.
        assert http.get(url, max_age=timedelta(0)).from_cache
        assert server.urls().count(url) == 3


def test_offline_serves_only_the_cache(
    server: Server, tmp_path: Path, today: list[datetime]
) -> None:
    url = "https://club.example/events"
    server.routes[url] = httpx.Response(200, text="cached")
    with client(server, tmp_path) as http:
        http.get(url)
    fetched = len(server.requests)
    today[0] += timedelta(days=30)
    with client(server, tmp_path, offline=True) as http:
        assert http.get(url).text == "cached"
        with pytest.raises(FetchError, match="not cached"):
            http.get("https://club.example/other")
    assert len(server.requests) == fetched


def test_errors_hide_secrets(server: Server, tmp_path: Path, today: object) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    server.routes["https://api.example/events?apikey=s3cret"] = httpx.Response(403)
    server.routes["https://api.example/down?token=t0k"] = refuse
    with client(server, tmp_path) as http:
        with pytest.raises(FetchError) as forbidden:
            http.get("https://api.example/events?apikey=s3cret")
        with pytest.raises(FetchError) as down:
            http.get("https://api.example/down?token=t0k")
    assert str(forbidden.value) == "HTTP 403 for https://api.example/events?apikey=REDACTED"
    assert "t0k" not in str(down.value)
    assert "token=REDACTED" in str(down.value)
