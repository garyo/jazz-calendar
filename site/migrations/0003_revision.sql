-- Counts changes to what the feed shows: approvals, unpublishing, confirming a regular, and
-- adding, editing or deleting a venue. The scraper republishes when it has moved on from the
-- count it last published.
CREATE TABLE revision (n INTEGER NOT NULL);
INSERT INTO revision (n) VALUES (0);
