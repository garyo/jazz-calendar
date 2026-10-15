"""Score classification against hand labels in scraper/eval/labels.yaml.

Each label names a source and a listing title, with the right answer: jazz, adjacent, other,
or unsure (shown but not scored). The report compares the keyword rules alone with rules plus a
classifier, and leads with missed shows, since dropping a real gig is the costliest mistake.
"""

from dataclasses import dataclass
from pathlib import Path

import yaml

from jazzcal.classify import classify
from jazzcal.config import Registry
from jazzcal.llm import Classifier
from jazzcal.models import Relevance
from jazzcal.pipeline import Candidate, overrule
from jazzcal.store import Store

LABELS = Path(__file__).resolve().parents[2] / "eval" / "labels.yaml"


@dataclass
class _Case:
    title: str
    venue: str
    label: str
    rules: Relevance
    candidate: Candidate


def report(registry: Registry, store: Store, classifier: Classifier | None) -> str:
    cases, missing = _cases(registry, store)
    lines = [f"{len(cases)} labeled listings found; {len(missing)} not in the store"]
    if classifier:
        overrule(
            classifier,
            store,
            registry,
            [c.candidate for c in cases if not c.candidate.ruling.certain],
        )
    modes: list[tuple[str, dict[int, Relevance]]] = [
        ("rules", {i: c.rules for i, c in enumerate(cases)})
    ]
    if classifier:
        modes.append(
            (
                f"rules + {classifier.name}",
                {i: c.candidate.ruling.relevance for i, c in enumerate(cases)},
            )
        )
    for name, answers in modes:
        lines += ["", f"== {name}", *_score(cases, answers)]
    return "\n".join(lines)


def _cases(registry: Registry, store: Store) -> tuple[list[_Case], list[str]]:
    cases, missing = [], []
    by_source = {s.id: s for s in registry.sources}
    for item in yaml.safe_load(LABELS.read_text()):
        source = by_source[item["source"]]
        scraped = next((e for e in store.current(source.id) if e.title == item["title"]), None)
        if scraped is None:
            missing.append(item["title"])
            continue
        venue = source.venue or scraped.venue or registry.resolve_venue(scraped.venue_name or "")
        if not venue:
            missing.append(item["title"])
            continue
        ruling = classify(scraped, source, registry.venues[venue])
        candidate = Candidate(0, source, scraped, venue, ruling)
        cases.append(_Case(item["title"], venue, item["label"], ruling.relevance, candidate))
    return cases, missing


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
