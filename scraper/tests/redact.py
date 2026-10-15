"""Redact saved pages and feeds before committing them as test fixtures.

Fixtures keep the facts and structure the parsers need (titles, dates, times, prices, links,
categories) and lose what belongs to the venues: descriptions, bios, images, and page chrome.

    uv run python tests/redact.py [--keep SELECTOR] tests/fixtures/new-page.html ...

Rewrites each file in place. For HTML, --keep reduces the page to the elements the parser
reads (e.g. 'li.listEvent'). Check the result by eye, then rerun the tests.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

import icalendar
from selectolax.lexbor import LexborHTMLParser

# JSON keys holding prose or media, at any depth.
PROSE_KEY = re.compile(
    r"description|excerpt|content|summary|bio|body|image|photo|thumbnail|media|html|"
    r"featured|banner|poster|video|logo|details|notes?\b",
    re.IGNORECASE,
)
# ICS properties worth keeping; Trumba custom fields are kept only for these names.
ICS_KEEP = {
    "UID", "SUMMARY", "DTSTART", "DTEND", "DURATION", "LOCATION", "URL", "CATEGORIES",
    "STATUS", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "DTSTAMP", "X-TRUMBA-LINK",
}  # fmt: skip
TRUMBA_KEEP = {"Event Type", "Category", "Cost", "Tickets"}
# Page elements that are never event data.
HTML_DROP = (
    "style, noscript, svg, img, picture, source, video, audio, iframe, link, header, footer, "
    "nav, form, button, script:not([type='application/ld+json'])"
)
# Elements holding event descriptions on the sites we parse. Prices in them are kept.
HTML_PROSE = (
    ".eventlist-excerpt, .eventlist-description, .event-description, .description, "
    ".eventDescription"
)
PRICE = re.compile(r"\$\s?\d+(?:\.\d\d)?(?:\s*(?:-|\u2013|to|/)\s*\$?\d+(?:\.\d\d)?)?")
LONG_TEXT = 60
"""Runs of text longer than this, outside headings and links, are prose, not listing data."""
KEEP_LONG = {"h1", "h2", "h3", "h4", "h5", "h6", "title", "a", "script", "time"}


def redact_json(data: Any) -> Any:
    if isinstance(data, dict):
        return {k: redact_json(v) for k, v in data.items() if not PROSE_KEY.search(k)}
    if isinstance(data, list):
        return [redact_json(v) for v in data]
    return data


def redact_ics(text: str) -> bytes:
    calendar = icalendar.Calendar.from_ical(text)
    for vevent in calendar.walk("VEVENT"):
        for name in list(vevent):
            if name == "X-TRUMBA-CUSTOMFIELD":
                value: Any = vevent[name]
                fields = value if isinstance(value, list) else [value]
                kept = [f for f in fields if f.params.get("NAME") in TRUMBA_KEEP]
                del vevent[name]
                for field in kept:
                    vevent.add(name, field, parameters=field.params, encode=False)
            elif name not in ICS_KEEP:
                del vevent[name]
    return calendar.to_ical()


def redact_html(text: str, keep: str | None = None) -> str:
    tree = LexborHTMLParser(text)
    if keep:
        kept = "\n".join(node.html or "" for node in tree.css(keep))
        tree = LexborHTMLParser(f"<!doctype html><html><body>\n{kept}\n</body></html>")
    for node in tree.css(HTML_DROP):
        node.decompose()
    for node in tree.css(HTML_PROSE):
        prices = " ".join(PRICE.findall(node.text()))
        if prices:
            classes = node.attributes.get("class") or ""
            replacement = LexborHTMLParser(f'<div class="{classes}">{prices}</div>').css_first(
                "div"
            )
            if replacement:
                node.replace_with(replacement)
                continue
        node.decompose()
    for node in tree.css("*"):
        for name in [a for a in node.attributes if a.startswith("data-") or a == "style"]:
            del node.attrs[name]
    for node in tree.css("meta"):
        if node.attributes.get("property") != "og:title":
            node.decompose()
    if tree.body:
        for node in list(tree.body.traverse(include_text=True)):
            parent = node.parent
            if (
                node.tag == "-text"
                and len(" ".join((node.text_content or "").split())) > LONG_TEXT
                and parent is not None
                and parent.tag not in KEEP_LONG
            ):
                node.decompose()
    for node in tree.css("script[type='application/ld+json']"):
        try:
            data = json.loads(node.text(strip=False))
        except json.JSONDecodeError:
            node.decompose()
            continue
        replacement = LexborHTMLParser(
            '<script type="application/ld+json">'
            f"{json.dumps(redact_json(data), ensure_ascii=False)}</script>"
        ).css_first("script")
        if replacement:
            node.replace_with(replacement)
    html = tree.html or ""
    html = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)
    return re.sub(r"\n\s*\n+", "\n", html)


def main() -> None:
    args = sys.argv[1:]
    keep = None
    if args[:1] == ["--keep"]:
        keep, args = args[1], args[2:]
    for name in args:
        path = Path(name)
        text = path.read_text()
        match path.suffix:
            case ".json":
                path.write_text(json.dumps(redact_json(json.loads(text)), indent=1) + "\n")
            case ".ics":
                path.write_bytes(redact_ics(text))
            case ".html":
                path.write_text(redact_html(text, keep))
            case _:
                raise SystemExit(f"don't know how to redact {path}")
        print(f"{path}: {len(text)} -> {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
