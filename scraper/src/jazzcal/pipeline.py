"""Scrape sources into the store, then build the published feed from it."""

import hashlib
import itertools
import logging
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from textwrap import shorten

from rapidfuzz import fuzz

from jazzcal import notify
from jazzcal.adapters import get_adapter
from jazzcal.classify import Ruling, classify, tags
from jazzcal.config import TZ, Registry, night_of
from jazzcal.http import Http, redact
from jazzcal.llm import Classifier, Question
from jazzcal.models import Event, EventsFile, ScrapedEvent, Source, SourceCredit, StatusFile
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
ALERT_AFTER = 2
"""Consecutive failed runs after which a source is worth a notification..."""
ALERT_EVERY = timedelta(days=7)
"""...and how often to repeat it while the source keeps failing."""
KEEP_FOR = timedelta(days=30)
"""How long to remember past events their sources have dropped, and cached pages unused."""


def scrape(
    registry: Registry,
    store: Store,
    http: Http,
    only: set[str] | None = None,
    now: datetime | None = None,
) -> None:
    now = now or datetime.now(TZ)
    for source in registry.sources:
        if not source.enabled or (only and source.id not in only):
            continue
        try:
            events = get_adapter(source.adapter)(source, http)
        except Exception as e:
            # One broken source must not stop the others; its last good listings stand.
            log.exception("source %s failed", source.id)
            store.record_failure(source.id, redact(f"{type(e).__name__}: {e}"))
            continue
        events = _retitle(source, events)
        log.info("source %s: %d events", source.id, len(events))
        # Nothing at all, where the last run found shows still to come, more likely means a
        # broken page than an empty calendar: keep the last good listings.
        if not events and (had := sum(not _past(e, now) for e in store.last_found(source.id))):
            error = f"0 events (had {had} upcoming last run)"
            log.warning("source %s: %s; keeping its listings", source.id, error)
            store.record_failure(source.id, error)
            continue
        store.record_success(source.id, events)

    listings = store.prune(now - KEEP_FOR)
    pages = 0 if http.offline else http.prune_cache(KEEP_FOR)  # offline runs need the cache
    log.info("pruned %d old listings and %d cached pages", listings, pages)


def _retitle(source: Source, events: list[ScrapedEvent]) -> list[ScrapedEvent]:
    """The events with the source's title rewrites applied, less any left without a title."""
    if not (source.title_strip or source.title_replace):
        return events
    return [
        e.model_copy(update={"title": title}) for e in events if (title := source.retitle(e.title))
    ]


def _past(event: ScrapedEvent, now: datetime) -> bool:
    return (event.end or event.start + PAST_GRACE) < now


def alert_failing(
    registry: Registry,
    store: Store,
    now: datetime,
    send: Callable[[str, str], bool] = notify.send,
) -> None:
    """Send one notification listing every enabled source that has failed ALERT_AFTER runs in
    a row, when one of them has just got there or hasn't been mentioned for ALERT_EVERY."""
    enabled = {s.id for s in registry.sources if s.enabled}
    failing = [f for f in store.failing(ALERT_AFTER) if f.source in enabled]
    if not any(f.notified is None or now - f.notified >= ALERT_EVERY for f in failing):
        return
    lines = [f"{f.source} ({f.runs} runs): {shorten(redact(f.error), 120)}" for f in failing]
    sources = "source" if len(failing) == 1 else "sources"
    title = f"Boston Jazz Calendar: {len(failing)} {sources} failing"
    if send(title, "\n".join(lines)):
        store.mark_notified([f.source for f in failing], now)


@dataclass
class Candidate:
    priority: int
    source: Source
    scraped: ScrapedEvent
    venue: str
    ruling: Ruling
    first_seen: str = ""
    """When the source first listed it, as stored (ISO 8601, UTC)."""
    published_id: str | None = None
    """The id it was last published under."""
    merged: list["Candidate"] = field(default_factory=list)
    id: str = ""
    """The id to publish it under, once _assign_ids has run."""

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
        published_ids = store.published_ids(source.id)
        for scraped in store.current(source.id):
            if _past(scraped, now):
                continue
            venue_id = (
                source.venue or scraped.venue or registry.resolve_venue(scraped.venue_name or "")
            )
            if not venue_id or venue_id not in registry.venues:
                unresolved[f"{source.id}: {scraped.venue_name or venue_id}"] += 1
                continue
            ruling = classify(scraped, source, registry.venues[venue_id])
            if ruling.certain and ruling.relevance == "other":
                continue
            first_seen, published_id = published_ids[scraped.uid]
            candidates.append(
                Candidate(priority, source, scraped, venue_id, ruling, first_seen, published_id)
            )
    for name, count in unresolved.most_common():
        log.info("unknown venue (%d events) %s", count, name)
    if classifier:
        overrule(classifier, store, registry, [c for c in candidates if not c.ruling.certain])

    listed = [c for c in candidates if c.ruling.relevance != "other"]
    deduped = _dedup(listed)
    _assign_ids(deduped)
    store.save_event_ids(
        [
            (c.source.id, c.scraped.uid, group.id)
            for group in deduped
            for c in (group, *group.merged)
            if c.published_id != group.id
        ]
    )
    events = sorted((_publish(c, registry) for c in deduped), key=lambda e: e.start)
    used = {source_id for e in events for source_id in e.sources}
    return (
        EventsFile(
            generated_at=now,
            venues=[v.public() for v in registry.venues.values()],
            events=events,
            regulars=registry.regulars,
            sources=[
                SourceCredit(id=s.id, **s.credit.model_dump())
                for s in registry.sources
                if s.id in used and s.credit
            ],
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
        group = kept.setdefault((c.venue, night_of(c.scraped)), [])
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


def _assign_ids(events: list[Candidate]) -> None:
    """Give each event an id that holds as sources start and stop listing it, since calendar
    apps take a new id for a new event. Each listing remembers the id it was last published
    under; an event takes the one its longest-standing listing has, or if none has one, an
    id derived from its leading listing. Should a merged event split up, the part with the
    oldest listing keeps the id and the others get new ones."""
    taken: set[str] = set()

    def age(event: Candidate) -> tuple[str, int, str]:
        oldest = min(c.first_seen for c in (event, *event.merged))
        return oldest, event.priority, event.scraped.uid

    for event in sorted(events, key=age):
        listings = sorted((event, *event.merged), key=lambda c: c.first_seen)
        published = (c.published_id for c in listings if c.published_id)
        key = f"{event.source.id}|{event.scraped.uid}"
        derived = (_hash(key if n == 0 else f"{key}|{n}") for n in itertools.count())
        event.id = next(i for i in itertools.chain(published, derived) if i not in taken)
        taken.add(event.id)


def _hash(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def _publish(c: Candidate, registry: Registry) -> Event:
    s = c.scraped
    others = [m.scraped for m in c.merged]

    def first(attr: str) -> str | None:
        return next((v for e in (s, *others) if (v := getattr(e, attr))), None)

    venue = registry.venues[c.venue]
    return Event(
        id=c.id,
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
