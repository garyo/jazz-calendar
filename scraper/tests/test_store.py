import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from jazzcal.config import TZ
from jazzcal.models import ScrapedEvent
from jazzcal.store import MAX_MISSES, Store

NOW = datetime(2026, 10, 15, 12, tzinfo=TZ)


def event(uid: str, days: float, **kw: object) -> ScrapedEvent:
    return ScrapedEvent.model_validate(
        {"uid": uid, "title": uid, "start": NOW + timedelta(days=days), **kw}
    )


FIRST_SCHEMA = """
create table listing (
    source text not null, uid text not null, data text not null, first_seen text not null,
    last_seen text not null, misses integer not null default 0, primary key (source, uid)
);
create table verdict (key text primary key, data text not null, created text not null);
create table run (
    source text primary key, last_attempt text not null, last_success text,
    ok integer not null, events integer not null, error text
);
insert into run values ('s', '2026-10-14T06:00:00+00:00', null, 0, 0, 'HTTP 503');
"""


def test_older_databases_gain_new_columns(tmp_path: Path) -> None:
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as db:
        db.executescript(FIRST_SCHEMA)
    store = Store(path)
    store.record_failure("s", "HTTP 503")
    assert [(f.source, f.runs) for f in store.failing(1)] == [("s", 1)]
    store.close()
    Store(path).close()  # and opening it again is harmless


def test_prune_forgets_old_listings_sources_dropped(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.db")
    still_listed = event("listed", days=-40)
    store.record_success(
        "s",
        [
            still_listed,
            event("old", days=-40),
            event("recent", days=-10),
            event("long-run", days=-40, end=NOW - timedelta(days=20)),
        ],
    )
    for _ in range(MAX_MISSES):
        store.record_success("s", [still_listed])
    assert store.prune(NOW - timedelta(days=30)) == 1
    uids = {uid for (uid,) in store.db.execute("select uid from listing")}
    assert uids == {"listed", "recent", "long-run"}
