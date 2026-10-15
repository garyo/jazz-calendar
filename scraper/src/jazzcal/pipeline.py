"""Scrape sources into the store, then build the published feed from it."""

import hashlib
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from rapidfuzz import fuzz

from jazzcal.adapters import get_adapter
from jazzcal.classify import Ruling, classify, tags
from jazzcal.config import TZ, Registry
from jazzcal.http import Http
from jazzcal.llm import Classifier, Question
from jazzcal.models import Event, EventsFile, ScrapedEvent, Source, StatusFile
from jazzcal.store import Store

log = logging.getLogger(__name__)

STALE_AFTER = timedelta(days=7)
"""Stop publishing a failing source's events this long after its last success."""
PAST_GRACE = timedelta(hours=3)
"""Keep events without an end time this long after they start."""
SAME_EVENT_WINDOW = timedelta(minutes=60)
SAME_TITLE_SCORE = 85
DROP_CONFIDENCE = 0.85
"""A classifier may drop a listing the rules kept only when at least this sure."""
ADD_CONFIDENCE = 0.5
"""...and add one the rules left out only when at least this sure."""
DESCRIPTION_LIMIT = 1200
"""Characters of description a classifier sees; enough to identify the act."""
VENUE_PROFILES = {
    "dedicated": "a jazz club",
    "regular": "books jazz regularly among other music",
    "occasional": "mostly non-jazz; books jazz occasionally",
}


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
class Candidate:
    priority: int
    source: Source
    scraped: ScrapedEvent
    venue: str
    ruling: Ruling
    merged: list["Candidate"] = field(default_factory=list)

    @property
    def sources(self) -> list[str]:
        return [self.source.id, *(m.source.id for m in self.merged)]


def build(
    registry: Registry, store: Store, now: datetime, classifier: Classifier | None = None
) -> tuple[EventsFile, StatusFile]:
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
            ruling = classify(scraped, source, registry.venues[venue_id])
            if ruling.certain and ruling.relevance == "other":
                continue
            candidates.append(Candidate(priority, source, scraped, venue_id, ruling))
    for name, count in unresolved.most_common():
        log.info("unknown venue (%d events) %s", count, name)
    if classifier:
        overrule(classifier, store, registry, [c for c in candidates if not c.ruling.certain])

    listed = [c for c in candidates if c.ruling.relevance != "other"]
    events = sorted((_publish(c, registry) for c in _dedup(listed)), key=lambda e: e.start)
    return (
        EventsFile(
            generated_at=now,
            venues=[v.public() for v in registry.venues.values()],
            events=events,
        ),
        StatusFile(generated_at=now, sources=statuses),
    )


def overrule(
    classifier: Classifier, store: Store, registry: Registry, candidates: list[Candidate]
) -> None:
    """Replace uncertain rulings with the classifier's verdicts, asking only about new listings."""
    keyed: dict[str, tuple[Question, list[Candidate]]] = {}
    for c in candidates:
        venue = registry.venues[c.venue]
        q = Question(
            id=str(len(keyed)),
            title=c.scraped.title,
            venue=f"{venue.name}, {venue.town}",
            venue_profile=VENUE_PROFILES[venue.jazz_level],
            tags=c.scraped.categories,
            description=(c.scraped.text or "")[:DESCRIPTION_LIMIT] or None,
        )
        keyed.setdefault(q.cache_key(classifier.name), (q, []))[1].append(c)
    verdicts = store.verdicts(list(keyed))
    missing = {key: q for key, (q, _) in keyed.items() if key not in verdicts}
    if missing:
        log.info("asking %s about %d listings", classifier.name, len(missing))
        answers = classifier.classify(list(missing.values()))
        fresh = {key: answers[q.id] for key, q in missing.items() if q.id in answers}
        store.save_verdicts(fresh)
        verdicts |= fresh
    # Missing a local gig is worse than listing a stray show, so "unknown" changes nothing and
    # dropping a listing the rules kept takes a confident verdict.
    for key, (q, group) in keyed.items():
        verdict = verdicts.get(key)
        if verdict is None or verdict.relevance == "unknown":
            continue
        relevance = verdict.relevance
        for c in group:
            ruled = c.ruling.relevance
            if relevance == "other" and ruled != "other" and verdict.confidence < DROP_CONFIDENCE:
                continue
            if ruled == "other" and relevance != "other" and verdict.confidence < ADD_CONFIDENCE:
                continue
            if ruled != relevance:
                log.info(
                    "%s: %r at %s: %s -> %s (%.2f, %s)", classifier.name, q.title, c.venue,
                    ruled, relevance, verdict.confidence, verdict.reason,
                )  # fmt: skip
            c.ruling = Ruling(relevance, True)


def _dedup(candidates: list[Candidate]) -> list[Candidate]:
    """Merge listings of one event from several sources into the highest-priority one."""
    kept: dict[tuple[str, object], list[Candidate]] = {}
    for c in sorted(candidates, key=lambda c: c.priority):
        group = kept.setdefault((c.venue, c.scraped.start.astimezone(TZ).date()), [])
        match = next((k for k in group if _same_event(k, c)), None)
        if match:
            match.merged.append(c)
        else:
            group.append(c)
    return [c for group in kept.values() for c in group]


def _same_event(a: Candidate, b: Candidate) -> bool:
    return (
        b.source.id not in a.sources
        and abs(a.scraped.start - b.scraped.start) <= SAME_EVENT_WINDOW
        and fuzz.token_set_ratio(_norm(a.scraped.title), _norm(b.scraped.title)) >= SAME_TITLE_SCORE
    )


def _norm(title: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", title.lower())


def _publish(c: Candidate, registry: Registry) -> Event:
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
        if "jazz" in (c.ruling.relevance, *(m.ruling.relevance for m in c.merged))
        else "adjacent",
        tags=tags(s),
        cancelled=s.cancelled,
        sources=c.sources,
    )
