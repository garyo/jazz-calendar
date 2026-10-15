"""Adapters turn one source into ScrapedEvents. Each handles a platform, not a venue.

An adapter fetches what it needs through the polite client and hands the text to a pure
parse function, which the tests exercise against saved fixtures. One that takes settings
declares them as an `Options` model, which checks a source's `options` when the registry
loads and reaches the adapter as its third argument:

    @adapter("jsonld", options=JsonLdOptions)
    def scrape(source: Source, http: Http, options: JsonLdOptions) -> list[ScrapedEvent]: ...
"""

import html
import importlib
import json
import pkgutil
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Annotated, Any, overload
from urllib.parse import urljoin

from pydantic import AfterValidator, BaseModel, ConfigDict
from selectolax.lexbor import LexborHTMLParser as HTMLParser
from selectolax.lexbor import LexborNode, SelectolaxError

from jazzcal.config import TZ
from jazzcal.http import Http
from jazzcal.models import ScrapedEvent, Source

Adapter = Callable[[Source, Http], list[ScrapedEvent]]
type AdapterWith[O] = Callable[[Source, Http, O], list[ScrapedEvent]]
"""An adapter taking its options as a third argument."""

HORIZON = timedelta(days=180)
"""How far ahead to collect events."""
DETAIL_MAX_AGE = timedelta(days=5)
"""How long to reuse a cached event detail page. List pages still refresh every run, so new
events turn up the same day; details rarely change once posted."""


class Options(BaseModel):
    """An adapter's settings, from its sources' `options`. This one has none."""

    model_config = ConfigDict(extra="forbid", frozen=True)


def _selector(value: str) -> str:
    try:
        HTMLParser("").css(value)
    except SelectolaxError as e:
        raise ValueError(f"bad CSS selector {value!r}") from e
    return value


Selector = Annotated[str, AfterValidator(_selector)]
"""A CSS selector, checked when the options load."""


@dataclass(frozen=True)
class _Registered:
    scrape: Adapter
    options: type[Options]


_registry: dict[str, _Registered] = {}


@overload
def adapter(name: str) -> Callable[[Adapter], Adapter]: ...


@overload
def adapter[O: Options](
    name: str, *, options: type[O]
) -> Callable[[AdapterWith[O]], AdapterWith[O]]: ...


def adapter(name: str, *, options: type[Options] | None = None) -> Callable[[Any], Any]:
    """Register a scrape function under `name`, with the model of its options if it has any."""

    def register(fn: Callable[..., list[ScrapedEvent]]) -> Callable[..., list[ScrapedEvent]]:
        if options is None:
            _registry[name] = _Registered(fn, Options)
        else:
            model = options
            _registry[name] = _Registered(
                lambda source, http: fn(source, http, model.model_validate(source.options)), model
            )
        return fn

    return register


def adapters() -> dict[str, type[Options]]:
    """Every adapter's name, with the model of its options."""
    if not _registry:
        for module in pkgutil.iter_modules(__path__):
            importlib.import_module(f"{__name__}.{module.name}")
    return {name: r.options for name, r in sorted(_registry.items())}


def _registered(name: str) -> _Registered:
    if name not in adapters():
        raise KeyError(f"no adapter {name!r}; known: {', '.join(adapters())}")
    return _registry[name]


def get_adapter(name: str) -> Adapter:
    return _registered(name).scrape


def check_options(source: Source) -> None:
    """Raise ValueError unless the source names an adapter and suits its options."""
    try:
        _registered(source.adapter).options.model_validate(source.options)
    except KeyError as e:
        raise ValueError(f"source {source.id!r}: {e.args[0]}") from None
    except ValueError as e:
        raise ValueError(f"source {source.id!r} options: {e}") from None


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
