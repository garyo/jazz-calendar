"""Adapters turn one source into ScrapedEvents. Each handles a platform, not a venue.

An adapter fetches what it needs through the polite client and hands the text to a pure
parse function, which the tests exercise against saved fixtures.
"""

import html
import importlib
import pkgutil
import re
from collections.abc import Callable
from datetime import date, datetime, time, timedelta

from selectolax.lexbor import LexborHTMLParser as HTMLParser

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
