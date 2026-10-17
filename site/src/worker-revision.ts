/**
 * The feed's revision: a count of changes to what the feed shows, kept in
 * D1. Each change bumps it in the same batch, and /api/registry reports it,
 * so the scraper can tell when approved listings need republishing.
 */

/** The statement that counts one more change; batch it with the change. */
export function bumpRevision(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE revision SET n = n + 1");
}

export function readRevision(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT n FROM revision");
}
