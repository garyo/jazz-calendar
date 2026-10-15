"""Decide whether an event is jazz, jazz-adjacent, or neither, and tag it.

In order: the event's own `relevance` (an editor's ruling on a submitted gig), then the
source's; the source's include/exclude patterns; keyword rules on the title and the source's
categories; then the venue's default (everything at a dedicated jazz room is jazz). Descriptions
count only at rooms with regular jazz, or for sources with `trust_text` (e.g. presenters whose
blurbs are about the act), since bios elsewhere mention jazz in passing. At regular-jazz rooms a
trio, quartet, etc. or a jam is jazz too.

A ruling is *certain* when it rests on something decisive: the event's or source's word, an
include or exclude pattern, an explicit genre in the title or tags, or a dedicated jazz room. The
rest are best guesses that a language model may overrule (see llm.py). A source's `unknown`
option sets the guess for listings nothing else settles, for rooms where unfamiliar acts are
usually jazz.
"""

import re
from dataclasses import dataclass

from jazzcal.config import VenueConfig
from jazzcal.models import Relevance, ScrapedEvent, Source

JAZZ = re.compile(
    r"\b(jazz|bebop|be-bop|hard bop|post-bop|big band|swing band|jam session|jazz jam|"
    r"bossa|latin jazz|afro-cuban jazz|dixieland|trad jazz|ragtime|stride|great american songbook"
    r"|scat|vibraphon\w*|organ trio|improvised music|creative music)\b",
    re.IGNORECASE,
)
ADJACENT = re.compile(
    r"\b(soul|funk|funky|blues|r&b|rhythm (and|&) blues|salsa|latin|afro-cuban|cuban|brazilian|"
    r"samba|choro|forró|gypsy|manouche|django|fusion|cabaret|songbook|torch song|lindy|"
    r"swing danc\w*|boogaloo|afrobeat|groove|neo-soul|avant-garde|avant garde|experimental|"
    r"free improv\w*|b3|hammond)\b",
    re.IGNORECASE,
)
JAM = re.compile(r"\bjams?\b", re.IGNORECASE)
COMBO = re.compile(
    r"(?<!string )(?<!piano )(?<!wind )(?<!brass )\b(trio|quartet|quintet|sextet|septet|octet|"
    r"nonet|combo)\b",
    re.IGNORECASE,
)
NOT_MUSIC = re.compile(
    r"\b(karaoke|trivia|comedy|stand-up|improv night|bingo|drag|podcast|lecture|"
    r"book club|market|yoga|workshop for kids|closed|no event tonight|private event|"
    r"dj set|dance party|open mic)\b",
    re.IGNORECASE,
)

TAGS = {
    "jam": re.compile(r"\bjam(s| session)?\b", re.IGNORECASE),
    "brunch": re.compile(r"\bbrunch\b", re.IGNORECASE),
    "big band": re.compile(r"\b(big band|jazz orchestra)\b", re.IGNORECASE),
    "latin": re.compile(r"\b(latin|salsa|afro-cuban|cuban)\b", re.IGNORECASE),
    "brazilian": re.compile(r"\b(brazilian|samba|bossa|choro|forró)\b", re.IGNORECASE),
    "blues": re.compile(r"\bblues\b", re.IGNORECASE),
    "student": re.compile(r"\bstudents?\b|'\d\d (BM|MM|DMA|GD|AD|BA|MA)\b", re.IGNORECASE),
    "free": re.compile(r"^free\b", re.IGNORECASE),
}


@dataclass(frozen=True)
class Ruling:
    relevance: Relevance
    certain: bool


def classify(event: ScrapedEvent, source: Source, venue: VenueConfig) -> Ruling:
    labels = " ".join([event.title, *event.categories])
    if event.relevance:
        return Ruling(event.relevance, True)
    if source.relevance:
        return Ruling(source.relevance, True)
    if source.include and not source.include.search(labels):
        return Ruling("other", True)
    if source.exclude and source.exclude.search(labels):
        return Ruling("other", True)
    if NOT_MUSIC.search(labels):
        return Ruling("other", True)
    if JAZZ.search(labels):
        return Ruling("jazz", True)
    if ADJACENT.search(labels):
        return Ruling("adjacent", False)
    if source.include or venue.jazz_level == "dedicated":
        return Ruling("jazz", True)
    text = event.text or ""
    # Descriptions count at rooms with regular jazz, or where a source vouches for them.
    if (venue.jazz_level == "regular" or source.trust_text) and JAZZ.search(text):
        return Ruling("jazz", False)
    if venue.jazz_level == "regular" and ADJACENT.search(text):
        return Ruling("adjacent", False)
    if venue.jazz_level == "regular" and (COMBO.search(event.title) or JAM.search(event.title)):
        return Ruling("jazz", False)
    # Rooms whose unfamiliar acts are nearly always jazz or kin say so with `unknown`.
    return Ruling(source.unknown, False)


def tags(event: ScrapedEvent) -> list[str]:
    found = [tag for tag, pattern in TAGS.items() if tag != "free" and pattern.search(event.title)]
    if event.price and TAGS["free"].search(event.price):
        found.append("free")
    return found
