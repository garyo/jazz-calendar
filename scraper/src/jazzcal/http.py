"""A polite HTTP client: identifies itself, honors robots.txt and Crawl-delay, spaces requests
to each host, and caches responses on disk so reruns don't refetch.

Pages fetched within `max_age` come straight from the cache; older ones are revalidated with
a conditional GET. Offline mode serves only from the cache, for working on parsers.
"""

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from protego import Protego

log = logging.getLogger(__name__)

BOT_NAME = "BostonJazzCalendarBot"
USER_AGENT = f"Mozilla/5.0 (compatible; {BOT_NAME}/0.1; +https://bostonjazzcalendar.com/#about)"
MIN_INTERVAL = 3.0
ROBOTS_MAX_AGE = timedelta(hours=24)


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
    def __init__(self, cache_dir: Path, *, offline: bool = False, max_age: timedelta) -> None:
        self.cache_dir = cache_dir
        self.offline = offline
        self.max_age = max_age
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"},
            follow_redirects=True,
            timeout=30,
        )
        self._robots: dict[str, Protego | None] = {}
        self._last_request: dict[str, float] = {}

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Http":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def get(self, url: str, *, max_age: timedelta | None = None) -> Response:
        max_age = self.max_age if max_age is None else max_age
        cached = self._read_cache(url)
        if cached and (self.offline or _now() - cached.fetched_at < max_age):
            return Response(url, cached.body, from_cache=True)
        if self.offline:
            raise FetchError(f"not cached (offline): {url}")
        robots = self._robots_for(url)
        if robots and not robots.can_fetch(url, BOT_NAME):
            raise Disallowed(f"robots.txt disallows {url}")

        headers = {}
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
            raise FetchError(f"HTTP {resp.status_code} for {url}")
        meta = {"url": url, "fetched_at": _now().isoformat()}
        if etag := resp.headers.get("etag"):
            meta["etag"] = etag
        if last_modified := resp.headers.get("last-modified"):
            meta["last_modified"] = last_modified
        self._write_cache(url, meta, resp.text)
        return Response(url, resp.text, from_cache=False)

    def _request(self, url: str, headers: dict[str, str], robots: Protego | None) -> httpx.Response:
        host = urlsplit(url).netloc
        delay = max(MIN_INTERVAL, (robots.crawl_delay(BOT_NAME) or 0) if robots else 0)
        wait = self._last_request.get(host, 0) + delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        log.info("GET %s", url)
        try:
            return self._client.get(url, headers=headers)
        except httpx.HTTPError as e:
            raise FetchError(f"{type(e).__name__} fetching {url}: {e}") from e
        finally:
            self._last_request[host] = time.monotonic()

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
            # RFC 9309: a missing robots.txt allows everything; a server error disallows all.
            if 400 <= resp.status_code < 500:
                text = ""
            elif resp.status_code >= 500:
                text = "User-agent: *\nDisallow: /"
            else:
                text = resp.text
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


def _now() -> datetime:
    return datetime.now(UTC)
