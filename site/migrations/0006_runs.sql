-- Scraper runs asked for on the review page. The scraper's one-minute refresh finds the oldest
-- queued one through /api/registry, pulls the latest code, carries it out, and reports when it
-- starts and how it ends.
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('full', 'source', 'rebuild')),
  source TEXT,                 -- the source id, for a 'source' run
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  requested TEXT NOT NULL,     -- ISO 8601, as are started and finished
  started TEXT,
  finished TEXT,
  error TEXT                   -- why a failed run failed
);
