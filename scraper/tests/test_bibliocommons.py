from datetime import datetime

from jazzcal.adapters import bibliocommons
from jazzcal.config import TZ

NOW = datetime(2026, 10, 15, 6, tzinfo=TZ)


def item(title: str, categories: list[str], start: str, cancelled: str = "false") -> str:
    cats = "".join(f"<category><![CDATA[{c}]]></category>" for c in categories)
    return f"""<item><title><![CDATA[{title}]]></title>
      <description><![CDATA[<p>A concert.</p>]]></description>
      <link>https://lib.example/events/{title.replace(" ", "")}</link>{cats}
      <bc:start_date>{start}</bc:start_date><bc:end_date>2026-10-20T23:30:00Z</bc:end_date>
      <bc:is_cancelled>{cancelled}</bc:is_cancelled>
      <bc:location><bc:name>Main Street</bc:name></bc:location></item>"""


FEED = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:bc="http://bibliocommons.com/rss/1.0/modules/event/"><channel>
{item("Pat Doe Trio", ["Concerts", "Adults"], "2026-10-20T22:00:00Z")}
{item("Music Hour", ["Story Time", "Children (Birth-Age 5)"], "2026-10-20T15:00:00Z")}
{item("Kids Jam", ["Concerts", "Children (Ages 6-12)"], "2026-10-21T15:00:00Z")}
{item("Brass Night", ["Performing Arts"], "2026-10-22T22:00:00Z", cancelled="true")}
</channel></rss>"""


def test_keeps_performances_for_adults_and_everyone() -> None:
    events = bibliocommons.parse(FEED, now=NOW)
    assert [e.title for e in events] == [
        "Pat Doe Trio (Main Street branch)",
        "Brass Night (Main Street branch)",
    ]
    trio, brass = events
    assert trio.start == datetime(2026, 10, 20, 18, 0, tzinfo=TZ)
    assert trio.end == datetime(2026, 10, 20, 19, 30, tzinfo=TZ)
    assert trio.url == "https://lib.example/events/PatDoeTrio"
    assert trio.categories == ["Concerts"]
    assert brass.cancelled
