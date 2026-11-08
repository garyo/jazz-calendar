"""Score classification against hand labels: scraper/eval/labels.yaml, and the owner's rulings
from the site's review page.

A label in labels.yaml names a source and a listing title; a ruling, a venue and a title. Each
gives the right answer: jazz, adjacent, other, or unsure (shown but not scored). Labeled
listings are scored from the store while their source lists them, then from the copy saved
then (Store.save_labeled), so labels outlive the shows. The report compares the keyword rules
alone with rules plus a classifier, and leads with missed shows, since dropping a real gig is
the costliest mistake.
"""

from dataclasses import dataclass
from pathlib import Path

import yaml

from jazzcal.classify import classify
from jazzcal.config import Registry
from jazzcal.llm import Classifier
from jazzcal.models import Relevance, ScrapedEvent, Source
from jazzcal.pipeline import Candidate, overrule
from jazzcal.site_registry import act_key
from jazzcal.store import Store

LABELS = Path(__file__).resolve().parents[2] / "eval" / "labels.yaml"


@dataclass
class _Case:
    title: str
    venue: str
    label: str
    rules: Relevance
    candidate: Candidate


def report(
    registry: Registry,
    store: Store,
    classifier: Classifier | None,
    lookup: Classifier | None = None,
) -> str:
    cases, missing = _cases(registry, store)
    lines = [f"{len(cases)} labeled listings found; {len(missing)} never stored"]
    if classifier:
        uncertain = [c.candidate for c in cases if not c.candidate.ruling.certain]
        overrule(classifier, store, registry, uncertain, lookup)
    modes: list[tuple[str, dict[int, Relevance]]] = [
        ("rules", {i: c.rules for i, c in enumerate(cases)})
    ]
    if classifier:
        modes.append(
            (
                f"rules + {classifier.name}" + (f" + {lookup.name}" if lookup else ""),
                {i: c.candidate.ruling.relevance for i, c in enumerate(cases)},
            )
        )
    for name, answers in modes:
        lines += ["", f"== {name}", *_score(cases, answers)]
    return "\n".join(lines)


def _cases(registry: Registry, store: Store) -> tuple[list[_Case], list[str]]:
    by_source = {s.id: s for s in registry.sources}
    found: dict[tuple[str, str], tuple[Source, ScrapedEvent, str]] = {}
    """Labelable listings by (source id, title): current ones, then saved copies."""
    for source in registry.sources:
        for scraped in store.current(source.id):
            if venue := registry.venue_for(source, scraped):
                found.setdefault((source.id, scraped.title), (source, scraped, venue))
    for source_id, venue, scraped in store.labeled():
        if (source := by_source.get(source_id)) and venue in registry.venues:
            found.setdefault((source_id, scraped.title), (source, scraped, venue))

    cases, missing, seen = [], [], set()
    for item in yaml.safe_load(LABELS.read_text()):
        hit = found.get((item["source"], item["title"]))
        if hit is None:
            missing.append(item["title"])
            continue
        source, scraped, venue = hit
        store.save_labeled(source.id, venue, scraped)
        seen.add(act_key(venue, scraped.title))
        cases.append(_case(registry, source, scraped, venue, item["label"]))
    for source, scraped, venue in found.values():
        key = act_key(venue, scraped.title)
        if key not in seen and (label := registry.rulings.get(key)):
            seen.add(key)
            cases.append(_case(registry, source, scraped, venue, label))
    return cases, missing


def _case(
    registry: Registry, source: Source, scraped: ScrapedEvent, venue: str, label: str
) -> _Case:
    ruling = classify(scraped, source, registry.venues[venue])
    candidate = Candidate(0, source, scraped, venue, ruling)
    return _Case(scraped.title, venue, label, ruling.relevance, candidate)


def _score(cases: list[_Case], answers: dict[int, Relevance]) -> list[str]:
    scored = [(c, answers[i]) for i, c in enumerate(cases) if c.label != "unsure"]
    exact = sum(c.label == a for c, a in scored)
    listed_right = sum((c.label == "other") == (a == "other") for c, a in scored)
    missed = [c for c, a in scored if c.label != "other" and a == "other"]
    strays = [c for c, a in scored if c.label == "other" and a != "other"]
    unsure_dropped = [
        c for i, c in enumerate(cases) if c.label == "unsure" and answers[i] == "other"
    ]
    lines = [
        f"exact label:        {exact}/{len(scored)}",
        f"listed or not:      {listed_right}/{len(scored)}",
        f"missed shows:       {len(missed)}",
        *(f"    {c.title!r} at {c.venue} (should be {c.label})" for c in missed),
        f"stray listings:     {len(strays)}",
        *(f"    {c.title!r} at {c.venue}" for c in strays),
        f"unsure, dropped:    {len(unsure_dropped)} (check these by hand)",
        *(f"    {c.title!r} at {c.venue}" for c in unsure_dropped),
    ]
    return lines
