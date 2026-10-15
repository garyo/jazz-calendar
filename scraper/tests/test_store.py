import sqlite3
from pathlib import Path

from jazzcal.store import Store

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
