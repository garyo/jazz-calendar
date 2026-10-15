"""Scrape sources into the store, then build the published feed from it."""

import hashlib
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from rapidfuzz import fuzz

from jazzcal.adapters import get_adapter
from jazzcal.classify import classify, tags
from jazzcal.config import TZ, Registry
from jazzcal.http import Http
from jazzcal.models import Event, EventsFile, Listed, ScrapedEvent, Source, StatusFile
from jazzcal.store import Store

log = logging.getLogger(__name__)

STALE_AFTER = timedelta(days=7)
"""Stop publishing a failing source's events this long after its last success."""
PAST_GRACE = timedelta(hours=3)
"""Keep events without an end time this long after they start."""
SAME_EVENT_WINDOW = timedelta(minutes=60)
SAME_TITLE_SCORE = 85


def scrape(registry: Registry, store: Store, http: Http, only: set[str] | None = None) -> None:
    for source in registry.sources:
        if not source.enabled or (only and source.id not in only):
            continue
        try:
            events = get_adapter(source.adapter)(source, http)
        except Exception as e:
            # One broken source must not stop the others; its last good listings stand.
            log.exception("source %s failed", source.id)
            store.record_failure(source.id, f"{type(e).__name__}: {e}")
            continue
        log.info("source %s: %d events", source.id, len(events))
        store.record_success(source.id, events)


@dataclass
class _Candidate:
    priority: int
    source: Source
    scraped: ScrapedEvent
    venue: str
    relevance: Listed
    merged: list["_Candidate"] = field(default_factory=list)

    @property
    def sources(self) -> list[str]:
        return [self.source.id, *(m.source.id for m in self.merged)]


def build(registry: Registry, store: Store, now: datetime) -> tuple[EventsFile, StatusFile]:
    candidates = []
    unresolved: Counter[str] = Counter()
    statuses = []
    for priority, source in enumerate(registry.sources):
        status = store.status(source.id)
        if status:
            statuses.append(status)
        if not (source.enabled and status and status.last_success):
            continue
        if now - status.last_success > STALE_AFTER:
            log.warning("source %s stale since %s; skipping it", source.id, status.last_success)
            continue
        for scraped in store.current(source.id):
            if (scraped.end or scraped.start + PAST_GRACE) < now:
                continue
            venue_id = (
                source.venue or scraped.venue or registry.resolve_venue(scraped.venue_name or "")
            )
            if not venue_id:
                unresolved[f"{source.id}: {scraped.venue_name}"] += 1
                continue
            relevance = classify(scraped, source, registry.venues[venue_id])
            if relevance == "other":
                continue
            candidates.append(_Candidate(priority, source, scraped, venue_id, relevance))
    for name, count in unresolved.most_common():
        log.info("unknown venue (%d events) %s", count, name)

    events = sorted((_publish(c, registry) for c in _dedup(candidates)), key=lambda e: e.start)
    return (
        EventsFile(
            generated_at=now,
            venues=[v.public() for v in registry.venues.values()],
            events=events,
        ),
        StatusFile(generated_at=now, sources=statuses),
    )


def _dedup(candidates: list[_Candidate]) -> list[_Candidate]:
    """Merge listings of one event from several sources into the highest-priority one."""
    kept: dict[tuple[str, object], list[_Candidate]] = {}
    for c in sorted(candidates, key=lambda c: c.priority):
        group = kept.setdefault((c.venue, c.scraped.start.astimezone(TZ).date()), [])
        match = next((k for k in group if _same_event(k, c)), None)
        if match:
            match.merged.append(c)
        else:
            group.append(c)
    return [c for group in kept.values() for c in group]


def _same_event(a: _Candidate, b: _Candidate) -> bool:
    return (
        b.source.id not in a.sources
        and abs(a.scraped.start - b.scraped.start) <= SAME_EVENT_WINDOW
        and fuzz.token_set_ratio(_norm(a.scraped.title), _norm(b.scraped.title)) >= SAME_TITLE_SCORE
    )


def _norm(title: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", title.lower())


def _publish(c: _Candidate, registry: Registry) -> Event:
    s = c.scraped
    others = [m.scraped for m in c.merged]

    def first(attr: str) -> str | None:
        return next((v for e in (s, *others) if (v := getattr(e, attr))), None)

    venue = registry.venues[c.venue]
    return Event(
        id=hashlib.sha1(f"{c.source.id}|{s.uid}".encode()).hexdigest()[:12],
        title=s.title,
        start=s.start,
        end=s.end,
        all_day=s.all_day,
        venue=c.venue,
        url=first("url") or venue.url or c.source.url,
        ticket_url=first("ticket_url"),
        price=first("price"),
        artists=s.artists or next((e.artists for e in others if e.artists), []),
        # A jazz-only source listing the same show outranks a mixed one's guess.
        relevance="jazz"
        if "jazz" in (c.relevance, *(m.relevance for m in c.merged))
        else "adjacent",
        tags=tags(s),
        cancelled=s.cancelled,
        sources=c.sources,
    )
