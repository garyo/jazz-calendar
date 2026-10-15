"""A polite HTTP client: identifies itself, honors robots.txt and Crawl-delay, spaces requests
to each host, and caches responses on disk so reruns don't refetch.

Pages fetched within `max_age` come straight from the cache; older ones are revalidated with
a conditional GET. Offline mode serves only from the cache, for working on parsers.

It's careful too: it follows redirects itself, checking robots.txt for every host along the
way and refusing anything but http(s) to public addresses, so a venue page can't point it at
the local network. Responses are capped at MAX_BYTES.
"""

import hashlib
import ipaddress
import json
import logging
import re
import socket
import time
from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from protego import Protego

log = logging.getLogger(__name__)

BOT_NAME = "BostonJazzCalendarBot"
USER_AGENT = f"Mozilla/5.0 (compatible; {BOT_NAME}/0.1; +https://bostonjazzcalendar.com/#about)"
MIN_INTERVAL = 3.0
ROBOTS_MAX_AGE = timedelta(hours=24)
RETRIES = 2
"""Further attempts after a server error, timeout or failed connection."""
RETRY_BACKOFF = 5.0
"""Seconds before the first retry; doubled for each one after."""
RETRY_AFTER_MAX = 60.0
"""The longest Retry-After we wait out; asked for longer, we give up on the URL for this run."""
MAX_REDIRECTS = 5
MAX_BYTES = 10_000_000
"""Largest response body we accept, after decompression."""


SECRET_PARAM = re.compile(
    r"(?i)\b(api[_-]?key|apikey|key|token|secret|password|sig|signature)=[^&\s#\"']+"
)


def redact(text: str) -> str:
    """Text with the values of secret-looking URL parameters (apikey=, token=...) hidden, for
    anything logged or published: errors land in the public status.json."""
    return SECRET_PARAM.sub(r"\1=REDACTED", text)


class FetchError(Exception):
    pass


class Disallowed(FetchError):
    """robots.txt forbids the URL."""


@dataclass
class Response:
    url: str
    text: str
    from_cache: bool

    def json(self) -> object:
        return json.loads(self.text)

    def json_dict(self) -> dict[str, Any]:
        """The body as a JSON object; FetchError when it's anything else."""
        return self._json_as(dict, "a JSON object")

    def json_list(self) -> list[Any]:
        """The body as a JSON array; FetchError when it's anything else."""
        return self._json_as(list, "a JSON array")

    def _json_as[T](self, kind: type[T], expected: str) -> T:
        try:
            data = self.json()
        except json.JSONDecodeError as e:
            raise FetchError(f"not JSON from {redact(self.url)}: {e}") from e
        if not isinstance(data, kind):
            raise FetchError(f"expected {expected} from {redact(self.url)}")
        return data


@dataclass
class _Reply:
    """One response: a redirect (with the request to follow it) or a page."""

    status: int
    headers: httpx.Headers
    text: str = ""
    redirect: httpx.Request | None = None


@dataclass
class _CacheEntry:
    meta: dict[str, str]
    body: str

    @property
    def fetched_at(self) -> datetime:
        return datetime.fromisoformat(self.meta["fetched_at"])


class Http:
    def __init__(
        self,
        cache_dir: Path,
        *,
        offline: bool = False,
        max_age: timedelta,
        trusted_hosts: Collection[str] = (),
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        """`trusted_hosts` may be private addresses, e.g. the site under `wrangler dev`."""
        self.cache_dir = cache_dir
        self.offline = offline
        self.max_age = max_age
        self.trusted_hosts = frozenset(trusted_hosts)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"},
            timeout=30,
            transport=transport,
        )
        self._robots: dict[str, Protego | None] = {}
        self._last_request: dict[str, float] = {}

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Http":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def get(
        self, url: str, *, max_age: timedelta | None = None, headers: dict[str, str] | None = None
    ) -> Response:
        max_age = self.max_age if max_age is None else max_age
        cached = self._read_cache(url)
        if cached and (self.offline or _now() - cached.fetched_at < max_age):
            return Response(url, cached.body, from_cache=True)
        if self.offline:
            raise FetchError(f"not cached (offline): {redact(url)}")

        headers = dict(headers or {})
        if cached:
            if etag := cached.meta.get("etag"):
                headers["If-None-Match"] = etag
            if last_modified := cached.meta.get("last_modified"):
                headers["If-Modified-Since"] = last_modified
        reply = self._fetch(url, headers)
        if reply.status == 304 and cached:
            self._write_cache(url, cached.meta | {"fetched_at": _now().isoformat()}, cached.body)
            return Response(url, cached.body, from_cache=True)
        if reply.status >= 400:
            raise FetchError(f"HTTP {reply.status} for {redact(url)}")
        meta = {"url": url, "fetched_at": _now().isoformat()}
        if etag := reply.headers.get("etag"):
            meta["etag"] = etag
        if last_modified := reply.headers.get("last-modified"):
            meta["last_modified"] = last_modified
        self._write_cache(url, meta, reply.text)
        return Response(url, reply.text, from_cache=False)

    def _fetch(self, url: str, headers: dict[str, str], *, obey_robots: bool = True) -> _Reply:
        """GET, following redirects to public http(s) addresses that robots.txt lets us fetch."""
        request = self._client.build_request("GET", url, headers=headers)
        for _ in range(MAX_REDIRECTS + 1):
            self._check_target(request.url)
            target = str(request.url)
            robots = self._robots_for(target) if obey_robots else None
            if robots and not robots.can_fetch(target, BOT_NAME):
                raise Disallowed(f"robots.txt disallows {redact(target)}")
            reply = self._send(request, robots)
            if reply.redirect is None:
                return reply
            request = reply.redirect
        raise FetchError(f"more than {MAX_REDIRECTS} redirects from {redact(url)}")

    def _check_target(self, url: httpx.URL) -> None:
        if url.scheme not in ("http", "https"):
            raise FetchError(f"refusing {redact(str(url))}: not http(s)")
        if url.host in self.trusted_hosts:
            return
        try:
            addresses = resolve(url.host)
        except OSError as e:
            raise FetchError(f"cannot resolve {url.host}: {e}") from e
        if private := next((a for a in addresses if not _is_public(a)), None):
            raise FetchError(f"refusing {redact(str(url))}: {url.host} is {private}, not public")

    def _send(self, request: httpx.Request, robots: Protego | None) -> _Reply:
        """Send one request, retrying server errors and failed connections a couple of times."""
        url, host = redact(str(request.url)), request.url.host
        delay = max(MIN_INTERVAL, (robots.crawl_delay(BOT_NAME) or 0) if robots else 0)
        attempt = 0
        while True:
            wait = self._last_request.get(host, 0) + delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            log.info("GET %s", url)
            try:
                reply = self._receive(request)
            except httpx.HTTPError as e:
                if not isinstance(e, httpx.TransportError) or attempt == RETRIES:
                    raise FetchError(redact(f"{type(e).__name__} fetching {url}: {e}")) from e
                problem, pause = type(e).__name__, _backoff(attempt)
            else:
                pause = _retry_pause(reply, attempt)
                if reply.status < 500 or attempt == RETRIES or pause is None:
                    return reply
                problem = f"HTTP {reply.status}"
            finally:
                self._last_request[host] = time.monotonic()
            log.warning("%s for %s; retrying in %.0f s", problem, url, pause)
            time.sleep(pause)
            attempt += 1

    def _receive(self, request: httpx.Request) -> _Reply:
        """The response, reading the body only of a success, and at most MAX_BYTES of it."""
        resp = self._client.send(request, stream=True)
        try:
            if resp.next_request is not None:
                return _Reply(resp.status_code, resp.headers, redirect=resp.next_request)
            if not resp.is_success:
                return _Reply(resp.status_code, resp.headers)
            body = bytearray()
            for chunk in resp.iter_bytes():
                body += chunk
                if len(body) > MAX_BYTES:
                    raise FetchError(f"over {MAX_BYTES:,} bytes: {redact(str(request.url))}")
            text = body.decode(resp.encoding or "utf-8", "replace")
            return _Reply(resp.status_code, resp.headers, text)
        finally:
            resp.close()

    def _robots_for(self, url: str) -> Protego | None:
        """Parsed robots.txt for the URL's host; None means everything is allowed."""
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            self._robots[origin] = self._load_robots(f"{origin}/robots.txt")
        return self._robots[origin]

    def _load_robots(self, robots_url: str) -> Protego | None:
        cached = self._read_cache(robots_url)
        if cached and _now() - cached.fetched_at < ROBOTS_MAX_AGE:
            text = cached.body
        else:
            reply = self._fetch(robots_url, {}, obey_robots=False)
            # RFC 9309: a server error disallows everything, a missing robots.txt nothing. The
            # former holds for this run only: caching it would shut the host out for a day.
            if reply.status >= 500:
                log.warning("HTTP %d for %s; skipping the host", reply.status, robots_url)
                return Protego.parse("User-agent: *\nDisallow: /")
            text = "" if reply.status >= 400 else reply.text
            meta = {"url": robots_url, "fetched_at": _now().isoformat()}
            self._write_cache(robots_url, meta, text)
        return Protego.parse(text) if text.strip() else None

    def _cache_path(self, url: str) -> Path:
        return self.cache_dir / hashlib.sha256(url.encode()).hexdigest()[:32]

    def _read_cache(self, url: str) -> _CacheEntry | None:
        path = self._cache_path(url)
        try:
            meta = json.loads(path.with_suffix(".json").read_text())
            return _CacheEntry(meta, path.with_suffix(".body").read_text())
        except FileNotFoundError:
            return None

    def _write_cache(self, url: str, meta: dict[str, str], body: str) -> None:
        path = self._cache_path(url)
        path.with_suffix(".body").write_text(body)
        path.with_suffix(".json").write_text(json.dumps(meta, indent=1))

    def prune_cache(self, older_than: timedelta) -> int:
        """Delete pages not fetched or revalidated within `older_than`. Returns how many."""
        cutoff = (_now() - older_than).timestamp()
        old = [m for m in self.cache_dir.glob("*.json") if m.stat().st_mtime < cutoff]
        for meta in old:
            meta.with_suffix(".body").unlink(missing_ok=True)
            meta.unlink()
        return len(old)


Address = ipaddress.IPv4Address | ipaddress.IPv6Address


def resolve(host: str) -> list[Address]:
    """The addresses a host name (or literal address) resolves to."""
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return [ipaddress.ip_address(info[4][0]) for info in infos]


def _is_public(address: Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast


def _backoff(attempt: int) -> float:
    return RETRY_BACKOFF * 2**attempt


def _retry_pause(reply: _Reply, attempt: int) -> float | None:
    """Seconds to wait before retrying, honoring Retry-After; None when it asks for too long."""
    backoff = _backoff(attempt)
    value = reply.headers.get("retry-after")
    if not value:
        return backoff
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - _now()).total_seconds()
        except (TypeError, ValueError):
            return backoff
    return None if seconds > RETRY_AFTER_MAX else max(seconds, backoff)


def _now() -> datetime:
    return datetime.now(UTC)
