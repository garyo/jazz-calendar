-- Regulars (standing series) join one-off gigs as submissions, unlisted
-- venues keep their full details, and venues the editor adds while approving
-- get a table of their own. SQLite can't relax date's NOT NULL in place, so
-- the submissions table is rebuilt.
CREATE TABLE submissions_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  kind TEXT NOT NULL DEFAULT 'gig' CHECK (kind IN ('gig', 'regular')),

  title TEXT NOT NULL,
  date TEXT,                   -- YYYY-MM-DD; NULL for a regular
  days TEXT,                   -- a regular's weekdays as JSON, e.g. ["thu"]
  nth TEXT,                    -- which of them in a month as JSON, e.g. [1, 3]; [] for every week
  start_time TEXT,             -- HH:MM; NULL when the time is TBA
  end_time TEXT,               -- HH:MM; earlier than start_time means after midnight
  venue TEXT,                  -- venue id; NULL for a venue we don't list yet
  venue_name TEXT,             -- the unlisted venue, as submitted
  venue_town TEXT,
  venue_address TEXT,
  venue_url TEXT,
  price TEXT,
  url TEXT NOT NULL,           -- a page confirming the gig or publishing the series

  submitter_name TEXT NOT NULL,
  submitter_email TEXT NOT NULL,
  notes TEXT,

  relevance TEXT CHECK (relevance IN ('jazz', 'adjacent')),
  reviewed_at TEXT,
  checked TEXT,                -- YYYY-MM-DD: a regular last confirmed running
  editor_note TEXT
);

INSERT INTO submissions_new (
  id, created_at, status, title, date, start_time, end_time, venue,
  venue_name, venue_town, price, url, submitter_name, submitter_email, notes,
  relevance, reviewed_at, editor_note
)
SELECT
  id, created_at, status, title, date, start_time, end_time, venue,
  venue_name, venue_town, price, url, submitter_name, submitter_email, notes,
  relevance, reviewed_at, editor_note
FROM submissions;

DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX submissions_by_status ON submissions (status, date);

-- Venues added on the review page; the scraper lists them alongside
-- data/venues.yaml, whose entries win on a shared id.
CREATE TABLE venues (
  id TEXT PRIMARY KEY,         -- slug, e.g. "example-room"
  name TEXT NOT NULL,
  address TEXT,
  town TEXT NOT NULL,
  neighborhood TEXT,
  url TEXT,
  jazz_level TEXT NOT NULL CHECK (jazz_level IN ('dedicated', 'regular', 'occasional')),
  created_at TEXT NOT NULL
);
