"""A polite HTTP client: identifies itself, honors robots.txt and Crawl-delay, spaces requests
to each host, and caches responses on disk so reruns don't refetch.

Pages fetched within `max_age` come straight from the cache; older ones are revalidated with
a conditional GET. Offline mode serves only from the cache, for working on parsers.
"""

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
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
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.cache_dir = cache_dir
        self.offline = offline
        self.max_age = max_age
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"},
            follow_redirects=True,
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
        robots = self._robots_for(url)
        if robots and not robots.can_fetch(url, BOT_NAME):
            raise Disallowed(f"robots.txt disallows {redact(url)}")

        headers = dict(headers or {})
        if cached:
            if etag := cached.meta.get("etag"):
                headers["If-None-Match"] = etag
            if last_modified := cached.meta.get("last_modified"):
                headers["If-Modified-Since"] = last_modified
        resp = self._request(url, headers, robots)
        if resp.status_code == 304 and cached:
            self._write_cache(url, cached.meta | {"fetched_at": _now().isoformat()}, cached.body)
            return Response(url, cached.body, from_cache=True)
        if resp.status_code >= 400:
            raise FetchError(f"HTTP {resp.status_code} for {redact(url)}")
        meta = {"url": url, "fetched_at": _now().isoformat()}
        if etag := resp.headers.get("etag"):
            meta["etag"] = etag
        if last_modified := resp.headers.get("last-modified"):
            meta["last_modified"] = last_modified
        self._write_cache(url, meta, resp.text)
        return Response(url, resp.text, from_cache=False)

    def _request(self, url: str, headers: dict[str, str], robots: Protego | None) -> httpx.Response:
        """GET, retrying server errors and failed connections a couple of times."""
        host = urlsplit(url).netloc
        delay = max(MIN_INTERVAL, (robots.crawl_delay(BOT_NAME) or 0) if robots else 0)
        attempt = 0
        while True:
            wait = self._last_request.get(host, 0) + delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            log.info("GET %s", redact(url))
            try:
                resp = self._client.get(url, headers=headers)
            except httpx.HTTPError as e:
                if not isinstance(e, httpx.TransportError) or attempt == RETRIES:
                    raise FetchError(redact(f"{type(e).__name__} fetching {url}: {e}")) from e
                problem, pause = type(e).__name__, _backoff(attempt)
            else:
                pause = _retry_pause(resp, attempt)
                if resp.status_code < 500 or attempt == RETRIES or pause is None:
                    return resp
                problem = f"HTTP {resp.status_code}"
            finally:
                self._last_request[host] = time.monotonic()
            log.warning("%s for %s; retrying in %.0f s", problem, redact(url), pause)
            time.sleep(pause)
            attempt += 1

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
            resp = self._request(robots_url, {}, None)
            # RFC 9309: a server error disallows everything, a missing robots.txt nothing. The
            # former holds for this run only: caching it would shut the host out for a day.
            if resp.status_code >= 500:
                log.warning("HTTP %d for %s; skipping the host", resp.status_code, robots_url)
                return Protego.parse("User-agent: *\nDisallow: /")
            text = "" if resp.status_code >= 400 else resp.text
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


def _backoff(attempt: int) -> float:
    return RETRY_BACKOFF * 2**attempt


def _retry_pause(resp: httpx.Response, attempt: int) -> float | None:
    """Seconds to wait before retrying, honoring Retry-After; None when it asks for too long."""
    backoff = _backoff(attempt)
    value = resp.headers.get("retry-after")
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
