"""Command line: `jazzcal run` does a full scrape, build and (with --publish) upload."""

import argparse
import json
import logging
import os
from datetime import datetime, timedelta

import httpx

from jazzcal import evaluate, export, pipeline
from jazzcal.adapters import get_adapter
from jazzcal.config import ROOT, TZ, VAR_DIR, Registry
from jazzcal.http import Http
from jazzcal.llm import Classifier, ClaudeClassifier
from jazzcal.models import EventsFile
from jazzcal.store import Store

OUT_DIR = VAR_DIR / "out"


def main() -> None:
    parser = argparse.ArgumentParser(prog="jazzcal", description=__doc__)
    parser.add_argument("-v", "--verbose", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="scrape, build, and optionally publish")
    run.add_argument("--publish", action="store_true", help="upload results to the site")
    scrape = commands.add_parser("scrape", help="scrape sources into the store")
    for p in (run, scrape):
        p.add_argument("--source", action="append", help="only this source (repeatable)")
        p.add_argument("--offline", action="store_true", help="use only cached pages")
        p.add_argument(
            "--max-age", type=float, default=6, help="reuse pages fetched within this many hours"
        )
    build = commands.add_parser("build", help="build the published files from the store")
    evaluation = commands.add_parser("eval", help="score classification against eval/labels.yaml")
    for p in (run, build, evaluation):
        p.add_argument(
            "--classifier",
            default=os.environ.get("JAZZCAL_CLASSIFIER"),
            help="model for listings the rules can't settle, e.g. claude-haiku-5-5 "
            "(default: $JAZZCAL_CLASSIFIER; none if unset)",
        )
    commands.add_parser("publish", help="upload the built files")
    show = commands.add_parser("show", help="print what a source yields, without storing it")
    show.add_argument("source")
    show.add_argument("--offline", action="store_true")
    commands.add_parser("schema", help="write schema/events.schema.json")

    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)

    match args.command:
        case "run" | "scrape":
            registry = Registry.load()
            store = Store(VAR_DIR / "jazzcal.db")
            with _http(args.offline, args.max_age) as http:
                pipeline.scrape(registry, store, http, set(args.source or []) or None)
            if args.command == "run":
                _build(registry, store, _classifier(args.classifier))
                if args.publish:
                    export.publish(OUT_DIR)
        case "build":
            _build(Registry.load(), Store(VAR_DIR / "jazzcal.db"), _classifier(args.classifier))
        case "eval":
            store = Store(VAR_DIR / "jazzcal.db")
            print(evaluate.report(Registry.load(), store, _classifier(args.classifier)))
        case "publish":
            export.publish(OUT_DIR)
        case "show":
            source = Registry.load().source(args.source)
            with _http(args.offline, 6) as http:
                for e in get_adapter(source.adapter)(source, http):
                    print(e.model_dump_json(exclude={"text"}, exclude_none=True))
        case "schema":
            schema = {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                **EventsFile.model_json_schema(mode="serialization"),
            }
            (ROOT / "schema" / "events.schema.json").write_text(json.dumps(schema, indent=2) + "\n")


def _http(offline: bool, max_age_hours: float) -> Http:
    # Our own site may be a local dev server ($JAZZCAL_SITE), so it may be a private address.
    return Http(
        VAR_DIR / "cache",
        offline=offline,
        max_age=timedelta(hours=max_age_hours),
        trusted_hosts={httpx.URL(export.site_url()).host},
    )


def _classifier(model: str | None) -> Classifier | None:
    return ClaudeClassifier(model) if model and model != "none" else None


def _build(registry: Registry, store: Store, classifier: Classifier | None) -> None:
    feed, status = pipeline.build(registry, store, datetime.now(TZ), classifier)
    export.write(OUT_DIR, feed, status)
    by_relevance = {r: sum(e.relevance == r for e in feed.events) for r in ("jazz", "adjacent")}
    logging.info("built %d events %s into %s", len(feed.events), by_relevance, OUT_DIR)
