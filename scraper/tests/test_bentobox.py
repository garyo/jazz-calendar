from datetime import datetime

from jazzcal.adapters import bentobox
from jazzcal.config import TZ

BASE = "https://club.example/jazz-schedule/"

LIST_PAGE = """<html><head>
<script type="application/ld+json">{"@type": "Organization"}</script>
<script type="application/ld+json">{"@context": "https://schema.org", "@graph": [
  {"@type": "Event", "url": "https://club.example/event/1016-pat-doe-trio/"},
  {"@type": "Event", "url": "https://club.example/event/1017-midnight-set-12-1am/"}
]}</script></head><body>
<a href="/event/1016-pat-doe-trio">Pat Doe Trio</a>
<a href="/event/1018-late-jam/">Late Jam</a>
</body></html>"""

EVENT_PAGE = """<html><head>
<script type="application/ld+json">{"@type": "Event", "name": "10/16 Pat Doe Trio",
 "startDate": "2026-10-16", "description": "<p>A jazz trio.</p>"}</script></head><body>
<header><a href="https://www.exploretock.com/club">Reserve</a></header>
<div><h1>10/16 Pat Doe Trio</h1>
<p><strong>October 16, 2026 07:00 PM until October 16, 2026 10:00 PM</strong></p></div>
<div><p>Book <a href="https://www.exploretock.com/club/experience/1/jazz-room">here</a></p></div>
</body></html>"""

MIDNIGHT_PAGE = """<html><body><h1>10/16 The Midnight Hour</h1>
<p>October 17, 2026 12:00 AM until October 17, 2026 01:00 AM</p></body></html>"""

OPTIONS = {
    "title_strip": r"^\d{1,2}/\d{1,2}\s+",
    "ticket_link": 'a[href*="exploretock.com"][href*="/experience/"]',
}


def test_event_urls_from_json_ld_and_links() -> None:
    assert bentobox.event_urls(LIST_PAGE, base_url=BASE) == [
        "https://club.example/event/1016-pat-doe-trio/",
        "https://club.example/event/1017-midnight-set-12-1am/",
        "https://club.example/event/1018-late-jam/",
    ]


def test_parse_event_page() -> None:
    url = "https://club.example/event/1016-pat-doe-trio/"
    event = bentobox.parse_event_page(EVENT_PAGE, url=url, options=OPTIONS)
    assert event is not None
    assert event.title == "Pat Doe Trio"
    assert event.start == datetime(2026, 10, 16, 19, 0, tzinfo=TZ)
    assert event.end == datetime(2026, 10, 16, 22, 0, tzinfo=TZ)
    assert event.ticket_url == "https://www.exploretock.com/club/experience/1/jazz-room"
    assert event.url == url
    assert event.text == "A jazz trio."


def test_midnight_set_keeps_its_own_date() -> None:
    event = bentobox.parse_event_page(MIDNIGHT_PAGE, url="https://club.example/e", options=OPTIONS)
    assert event is not None
    assert event.start == datetime(2026, 10, 17, 0, 0, tzinfo=TZ)
    assert event.ticket_url is None


def test_page_without_schedule_is_skipped() -> None:
    page = "<html><body><h1>Gift cards</h1><p>Give the gift of jazz</p></body></html>"
    assert bentobox.parse_event_page(page, url="https://club.example/e", options={}) is None
