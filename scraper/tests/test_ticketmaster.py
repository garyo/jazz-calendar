from datetime import datetime

from jazzcal.adapters import ticketmaster
from jazzcal.config import TZ

PAGE = {
    "_embedded": {
        "events": [
            {
                "id": "ev1",
                "name": "PAT DOE QUARTET",
                "url": "https://tickets.example/ev1",
                "dates": {
                    "start": {"dateTime": "2026-10-16T23:00:00Z"},
                    "status": {"code": "onsale"},
                },
                "priceRanges": [{"min": 30.15, "max": 45.0}],
                "classifications": [{"genre": {"name": "Jazz"}, "subGenre": {"name": "Undefined"}}],
                "_embedded": {"venues": [{"name": "The Club"}]},
            },
            {
                "id": "ev2",
                "name": "Brunch Set",
                "dates": {
                    "start": {"localDate": "2026-11-08", "localTime": "11:00:00"},
                    "status": {"code": "cancelled"},
                },
            },
            {"id": "ev3", "name": "No Date", "dates": {"start": {}}},
        ]
    },
    "page": {"totalPages": 1},
}


def test_parse() -> None:
    quartet, brunch = ticketmaster.parse(PAGE)
    assert quartet.title == "Pat Doe Quartet"
    assert quartet.start == datetime(2026, 10, 16, 19, 0, tzinfo=TZ)
    assert quartet.ticket_url == "https://tickets.example/ev1"
    assert quartet.url is None  # the site links to the venue; tickets go to ticket_url
    assert quartet.price == "From $30"
    assert quartet.categories == ["Jazz"]
    assert quartet.venue_name == "The Club"
    assert brunch.start == datetime(2026, 11, 8, 11, 0, tzinfo=TZ)
    assert brunch.cancelled
