-- Gigs sent in through the "Submit a gig" form, and their review.
-- Dates and times are Boston local; timestamps are ISO 8601 UTC.
-- submitter_name, submitter_email and notes are private: only the admin API
-- returns them.
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),

  title TEXT NOT NULL,
  date TEXT NOT NULL,          -- YYYY-MM-DD
  start_time TEXT,             -- HH:MM; NULL when the time is TBA
  end_time TEXT,               -- HH:MM; earlier than start_time means after midnight
  venue TEXT,                  -- venue id; NULL for a venue we don't list yet
  venue_name TEXT,             -- the unlisted venue, as submitted
  venue_town TEXT,
  price TEXT,
  url TEXT NOT NULL,           -- a page confirming the gig

  submitter_name TEXT NOT NULL,
  submitter_email TEXT NOT NULL,
  notes TEXT,

  relevance TEXT CHECK (relevance IN ('jazz', 'adjacent')),
  reviewed_at TEXT,
  editor_note TEXT
);

CREATE INDEX submissions_by_status ON submissions (status, date);
