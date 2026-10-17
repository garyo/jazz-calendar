-- Listings left out on request, kept here rather than in the public repo. The scraper reads
-- them through /api/registry (title, venue, night and requested only; never the note) and
-- drops every source's copy of a match. Every field given must match.
CREATE TABLE hidden (
  id INTEGER PRIMARY KEY,
  title TEXT,                  -- words to match in the title, ignoring case
  venue TEXT,                  -- venue id
  night TEXT,                  -- YYYY-MM-DD, the night it's listed under
  requested TEXT NOT NULL,     -- YYYY-MM-DD
  note TEXT,                   -- private: who asked and how
  CHECK (title IS NOT NULL OR (venue IS NOT NULL AND night IS NOT NULL))
);
