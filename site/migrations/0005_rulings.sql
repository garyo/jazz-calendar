-- The owner's calls on acts the scraper's classifier was unsure of, made on the review page.
-- The scraper reads them through /api/registry; each settles every listing of that title at
-- that venue, overriding its rules and its classifier.
CREATE TABLE rulings (
  venue TEXT NOT NULL,         -- venue id
  title TEXT NOT NULL,         -- as the review page showed it
  title_key TEXT NOT NULL,     -- the title in lower case with single spaces, for matching
  relevance TEXT NOT NULL CHECK (relevance IN ('jazz', 'adjacent', 'other')),
  decided TEXT NOT NULL,       -- YYYY-MM-DD
  PRIMARY KEY (venue, title_key)
);
