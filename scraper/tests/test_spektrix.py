import json
from datetime import datetime
from pathlib import Path

from jazzcal.adapters import spektrix
from jazzcal.config import TZ

FIXTURES = Path(__file__).parent / "fixtures"
TITLE_REPLACE = [["^OC: ", "Off Cabot: "], [r"\s+'\d\d\s*$", ""]]


def parse() -> list:
    events = json.loads((FIXTURES / "cabot-events.json").read_text())
    psycho = next(e for e in events if e["name"].strip() == "Psycho")
    instances = {psycho["id"]: json.loads((FIXTURES / "cabot-instances-psycho.json").read_text())}
    return spektrix.parse(
        events,
        instances,
        page_url="https://thecabot.org/whats-on/",
        title_replace=TITLE_REPLACE,
        today="2026-10-15",
    )


def test_spektrix_genres_and_titles() -> None:
    events = parse()
    temptations = next(e for e in events if e.title.startswith("The Temptations"))
    assert temptations.title == "The Temptations"
    assert temptations.start == datetime(2026, 11, 29, 19, 0, tzinfo=TZ)
    assert set(temptations.categories) == {"Music", "Soul", "RNB", "Motown"}
    assert temptations.url == "https://thecabot.org/whats-on/"
    assert any(e.title == "Off Cabot: Barrence Whitfield" for e in events)


def test_spektrix_expands_runs_and_drops_past_instances() -> None:
    psycho = [e for e in parse() if e.title == "Psycho"]
    assert [e.start for e in psycho] == [datetime(2026, 10, 18, 18, 0, tzinfo=TZ)]
