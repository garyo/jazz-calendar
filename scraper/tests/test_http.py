import ipaddress
import os
from collections.abc import Callable, Collection
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from jazzcal import http as http_module
from jazzcal.http import Disallowed, FetchError, Http, Response

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


PRIVATE_NAMES = {"intranet.example": "10.0.0.5", "metadata.example": "169.254.169.254"}


@pytest.fixture(autouse=True)
def dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve names without the network: every name is public but a few private ones."""

    def resolve(host: str) -> list[http_module.Address]:
        try:
            return [ipaddress.ip_address(host)]
        except ValueError:
            return [ipaddress.ip_address(PRIVATE_NAMES.get(host, "93.184.215.14"))]

    monkeypatch.setattr(http_module, "resolve", resolve)


def client(
    server: Server, tmp_path: Path, *, offline: bool = False, trusted_hosts: Collection[str] = ()
) -> Http:
    return Http(
        tmp_path / "cache",
        offline=offline,
        max_age=timedelta(hours=6),
        trusted_hosts=trusted_hosts,
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


def test_prune_cache_drops_pages_unused_for_a_while(
    server: Server, tmp_path: Path, today: list[datetime]
) -> None:
    for name in ("old", "new"):
        server.routes[f"https://club.example/{name}"] = httpx.Response(200, text=name)
    with client(server, tmp_path) as http:
        http.get("https://club.example/old")
        http.get("https://club.example/new")
        long_ago = (today[0] - timedelta(days=31)).timestamp()
        for path in http.cache_dir.glob(f"{http._cache_path('https://club.example/old').name}.*"):
            os.utime(path, (long_ago, long_ago))
        assert http.prune_cache(timedelta(days=30)) == 1
        today[0] += timedelta(hours=1)
        assert http.get("https://club.example/new").from_cache
        assert not http.get("https://club.example/old").from_cache


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


def responses(*items: httpx.Response | Exception) -> Handler:
    """A route answering with each item in turn (raising the exceptions), then the last again."""
    queue = list(items)

    def answer(request: httpx.Request) -> httpx.Response:
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    return answer


def test_server_errors_are_retried(
    server: Server, clock: Clock, tmp_path: Path, today: object
) -> None:
    url = "https://club.example/events"
    server.routes[url] = responses(
        httpx.Response(503, headers={"Retry-After": "30"}),
        httpx.ConnectError("reset"),
        httpx.Response(200, text="ok"),
    )
    with client(server, tmp_path) as http:
        assert http.get(url).text == "ok"
    times = [t for t, r in server.requests if str(r.url) == url]
    assert len(times) == 3
    assert times[1] - times[0] == 30
    assert times[2] - times[1] == 2 * http_module.RETRY_BACKOFF


def test_retries_give_up(server: Server, tmp_path: Path, today: object) -> None:
    server.routes["https://club.example/down"] = httpx.Response(502)
    server.routes["https://club.example/busy"] = httpx.Response(
        503, headers={"Retry-After": "3600"}
    )
    server.routes["https://club.example/gone"] = responses(httpx.ReadTimeout("slow"))
    with client(server, tmp_path) as http:
        with pytest.raises(FetchError, match="HTTP 502"):
            http.get("https://club.example/down")
        with pytest.raises(FetchError, match="HTTP 503"):
            http.get("https://club.example/busy")
        with pytest.raises(FetchError, match="ReadTimeout"):
            http.get("https://club.example/gone")
    attempts = server.urls()
    assert attempts.count("https://club.example/down") == 1 + http_module.RETRIES
    assert attempts.count("https://club.example/busy") == 1
    assert attempts.count("https://club.example/gone") == 1 + http_module.RETRIES


def test_robots_server_error_blocks_the_host_for_this_run_only(
    server: Server, tmp_path: Path, today: object
) -> None:
    robots = "https://club.example/robots.txt"
    server.routes[robots] = httpx.Response(500)
    server.routes["https://club.example/events"] = httpx.Response(200, text="ok")
    with client(server, tmp_path) as http:
        with pytest.raises(Disallowed):
            http.get("https://club.example/events")
        with pytest.raises(Disallowed):
            http.get("https://club.example/events")
    assert server.urls().count(robots) == 1 + http_module.RETRIES
    server.routes[robots] = httpx.Response(404)
    with client(server, tmp_path) as http:
        assert http.get("https://club.example/events").text == "ok"


def redirect(location: str) -> httpx.Response:
    return httpx.Response(302, headers={"Location": location})


@pytest.mark.parametrize(
    "target",
    [
        "http://127.0.0.1:8080/admin",
        "http://[::1]/admin",
        "http://[::ffff:192.168.1.1]/",
        "http://intranet.example/",
        "http://metadata.example/latest/meta-data/",
        "ftp://club.example/file",
        "file:///etc/passwd",
    ],
)
def test_redirects_only_to_public_web_addresses(
    server: Server, tmp_path: Path, today: object, target: str
) -> None:
    server.routes["https://club.example/events"] = redirect(target)
    with client(server, tmp_path) as http, pytest.raises(FetchError, match="refusing"):
        http.get("https://club.example/events")
    assert all(r.url.host == "club.example" for _, r in server.requests)


def test_refuses_private_addresses_unless_trusted(
    server: Server, tmp_path: Path, today: object
) -> None:
    url = "http://127.0.0.1:8787/api/submissions/approved"
    server.routes[url] = httpx.Response(200, text="{}")
    with client(server, tmp_path) as http, pytest.raises(FetchError, match="not public"):
        http.get(url)
    assert server.requests == []
    with client(server, tmp_path, trusted_hosts={"127.0.0.1"}) as http:
        assert http.get(url).text == "{}"


def test_redirects_are_limited(server: Server, tmp_path: Path, today: object) -> None:
    for n in range(10):
        server.routes[f"https://club.example/{n}"] = redirect(f"/{n + 1}")
    with client(server, tmp_path) as http, pytest.raises(FetchError, match="redirects"):
        http.get("https://club.example/0")
    assert server.urls()[-1] == f"https://club.example/{http_module.MAX_REDIRECTS}"


def test_redirect_to_another_host_checks_its_robots(
    server: Server, tmp_path: Path, today: object
) -> None:
    server.routes["https://club.example/tickets"] = redirect("https://tix.example/club")
    server.routes["https://club.example/events"] = redirect("https://cal.example/club")
    server.routes["https://tix.example/robots.txt"] = httpx.Response(
        200, text="User-agent: *\nDisallow: /\n"
    )
    server.routes["https://cal.example/club"] = httpx.Response(200, text="cal")
    with client(server, tmp_path) as http:
        with pytest.raises(Disallowed):
            http.get("https://club.example/tickets")
        page = http.get("https://club.example/events", headers={"Authorization": "Bearer t"})
        assert page.text == "cal"
        # The redirect's target is cached under the URL asked for.
        assert http.get("https://club.example/events").from_cache
    assert "https://tix.example/club" not in server.urls()
    followed = next(r for _, r in server.requests if str(r.url) == "https://cal.example/club")
    assert "authorization" not in followed.headers


def test_responses_are_capped(
    server: Server, tmp_path: Path, today: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(http_module, "MAX_BYTES", 100)
    server.routes["https://club.example/small"] = httpx.Response(200, content=b"x" * 100)
    server.routes["https://club.example/huge"] = httpx.Response(200, content=b"x" * 101)
    with client(server, tmp_path) as http:
        assert len(http.get("https://club.example/small").text) == 100
        with pytest.raises(FetchError, match="over 100 bytes"):
            http.get("https://club.example/huge")


def test_json_of_the_expected_kind() -> None:
    def response(text: str) -> Response:
        return Response("https://api.example/events?apikey=s3cret", text, from_cache=False)

    assert response('{"events": []}').json_dict() == {"events": []}
    assert response("[1, 2]").json_list() == [1, 2]
    with pytest.raises(FetchError, match=r"expected a JSON object from .*apikey=REDACTED"):
        response("[1, 2]").json_dict()
    with pytest.raises(FetchError, match="expected a JSON array"):
        response("{}").json_list()
    with pytest.raises(FetchError, match="not JSON"):
        response("<html>").json_dict()
