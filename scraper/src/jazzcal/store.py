"""SQLite state: every event each source has listed, and each source's run history.

An event a source stops listing isn't dropped at once (pages flicker); after MAX_MISSES
consecutive successful runs without it, it counts as removed.
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from jazzcal.models import ScrapedEvent, SourceStatus

MAX_MISSES = 2

SCHEMA = """
create table if not exists listing (
    source text not null,
    uid text not null,
    data text not null,
    first_seen text not null,
    last_seen text not null,
    misses integer not null default 0,
    primary key (source, uid)
);
create table if not exists run (
    source text primary key,
    last_attempt text not null,
    last_success text,
    ok integer not null,
    events integer not null,
    error text
);
"""


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def record_success(self, source: str, events: list[ScrapedEvent]) -> None:
        now = _now()
        with self.db:
            # Count a miss against everything, then clear it for what this run found.
            self.db.execute("update listing set misses = misses + 1 where source = ?", (source,))
            self.db.executemany(
                """insert into listing (source, uid, data, first_seen, last_seen, misses)
                   values (?, ?, ?, ?, ?, 0)
                   on conflict (source, uid) do update
                   set data = excluded.data, last_seen = excluded.last_seen, misses = 0""",
                [(source, e.uid, e.model_dump_json(), now, now) for e in events],
            )
            self.db.execute(
                """insert or replace into run values (?, ?, ?, 1, ?, null)""",
                (source, now, now, len(events)),
            )

    def record_failure(self, source: str, error: str) -> None:
        now = _now()
        with self.db:
            self.db.execute(
                """insert into run (source, last_attempt, ok, events, error)
                   values (?, ?, 0, 0, ?)
                   on conflict (source) do update
                   set last_attempt = excluded.last_attempt, ok = 0, events = 0,
                       error = excluded.error""",
                (source, now, error),
            )

    def current(self, source: str) -> list[ScrapedEvent]:
        """Events the source still lists."""
        rows = self.db.execute(
            "select data from listing where source = ? and misses < ?", (source, MAX_MISSES)
        )
        return [ScrapedEvent.model_validate_json(data) for (data,) in rows]

    def status(self, source: str) -> SourceStatus | None:
        row = self.db.execute(
            "select ok, events, last_success, error from run where source = ?", (source,)
        ).fetchone()
        if row is None:
            return None
        ok, events, last_success, error = row
        return SourceStatus(
            id=source,
            ok=bool(ok),
            events=events,
            last_success=datetime.fromisoformat(last_success) if last_success else None,
            error=error,
        )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
