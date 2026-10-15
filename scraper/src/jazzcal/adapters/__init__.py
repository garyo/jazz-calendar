"""Adapters turn one source into ScrapedEvents. Each handles a platform, not a venue.

An adapter fetches what it needs through the polite client and hands the text to a pure
parse function, which the tests exercise against saved fixtures.
"""

import html
import importlib
import json
import pkgutil
import re
from collections.abc import Callable, Iterable, Iterator
from datetime import date, datetime, time, timedelta
from typing import Any
from urllib.parse import urljoin

from selectolax.lexbor import LexborHTMLParser as HTMLParser
from selectolax.lexbor import LexborNode

from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

Adapter = Callable[[Source, Http], list[ScrapedEvent]]

HORIZON = timedelta(days=180)
"""How far ahead to collect events."""
DETAIL_MAX_AGE = timedelta(days=5)
"""How long to reuse a cached event detail page. List pages still refresh every run, so new
events turn up the same day; details rarely change once posted."""

_registry: dict[str, Adapter] = {}


def adapter(name: str) -> Callable[[Adapter], Adapter]:
    def register(fn: Adapter) -> Adapter:
        _registry[name] = fn
        return fn

    return register


def get_adapter(name: str) -> Adapter:
    if not _registry:
        for module in pkgutil.iter_modules(__path__):
            importlib.import_module(f"{__name__}.{module.name}")
    try:
        return _registry[name]
    except KeyError:
        raise KeyError(f"no adapter {name!r}; known: {sorted(_registry)}") from None


def html_to_text(fragment: str) -> str:
    text = HTMLParser(fragment).text(separator=" ")
    return re.sub(r"\s+", " ", text).strip()


def clean(value: str | None) -> str | None:
    """Unescape entities and collapse whitespace; empty becomes None."""
    if not value:
        return None
    # Windows-1252 punctuation mis-decoded as Latin-1 shows up as C1 control characters.
    value = re.sub(
        r"[\x80-\x9f]", lambda m: m[0].encode("latin-1").decode("cp1252", "ignore"), value
    )
    value = re.sub(r"\s+", " ", html.unescape(value)).strip()
    return value or None


def to_local(value: datetime | date) -> tuple[datetime, bool]:
    """Boston-local aware datetime, and whether the value was a bare date (all day).

    Naive datetimes are floating times, taken as Boston local.
    """
    if not isinstance(value, datetime):
        return datetime.combine(value, time(0), TZ), True
    if value.tzinfo is None:
        return value.replace(tzinfo=TZ), False
    return value.astimezone(TZ), False


def uncaps(title: str) -> str:
    """An all-caps title in title case ("JIMMY'S COUNT-OFF" -> "Jimmy's Count-Off"); any other
    title as given."""
    if not title.isupper():
        return title
    return re.sub(r"(?<![\w'\u2019])\w", lambda m: m[0].upper(), title.lower())


CANCELLED = re.compile(r"\bcancel+ed\b", re.IGNORECASE)


def is_cancelled(*texts: str) -> bool:
    """Whether any of the texts (a title, a subtitle) says the show is cancelled."""
    return any(CANCELLED.search(text) for text in texts)


def text_of(node: LexborNode, selector: str) -> str | None:
    """The text of the first element matching the selector, words space-separated."""
    found = node.css_first(selector)
    return found.text(separator=" ") if found else None


def json_ld(tree: HTMLParser) -> Iterator[Any]:
    """Each JSON-LD block in the page, parsed; blocks that aren't valid JSON are skipped."""
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            yield json.loads(node.text(strip=False))
        except json.JSONDecodeError:
            continue


def unique_urls(urls: Iterable[str], *, base_url: str) -> list[str]:
    """Absolute URLs in order, without duplicates. Sites link some pages both with and without
    a trailing slash, so those count as the same page."""
    seen: dict[str, str] = {}
    for url in urls:
        url = urljoin(base_url, url)
        seen.setdefault(url.rstrip("/"), url)
    return list(seen.values())
