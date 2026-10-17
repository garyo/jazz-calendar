# Boston Jazz Calendar

Monorepo: `scraper/` (Python, uv), `site/` (TypeScript, bun, Cloudflare Worker), `data/`
(venue and source registries), `schema/` (the feed contract). See README.md for the overview.

- The feed contract is `scraper/src/jazzcal/models.py` (`EventsFile`). After changing it, run
  `uv run jazzcal schema` and update `site/src/types.ts` to match.
- Scraper checks: `cd scraper && uv run ruff format . && uv run ruff check . && uvx ty check && uv run pytest -q`
- Site checks: `cd site && bun run check`
- All scraper fetches go through `jazzcal.http.Http`: it handles robots.txt, delays and the
  cache. Never bypass robots.txt or bot protection. If a site blocks us, note it in
  `data/sources.yaml` and leave the source disabled.
- Never turn a standing schedule into dated events. Weekly series go in `data/regulars.yaml`
  (or come from the site's database, approved on /admin) and appear in their own section.
- Removal requests (a venue, a gig, a performer): follow "Removing listings on request" in
  `scraper/README.md`.
- Publish facts and links only. Never store or publish venue descriptions or images;
  `ScrapedEvent.text` is used only for classification.
- New adapters handle a platform, not a venue: a pure `parse` function tested against a
  fixture, plus a thin `@adapter` scrape function.
- This repo is public. Keep venue copy and private details out of it:
  - Before committing a fixture, run `uv run python tests/redact.py [--keep SELECTOR] <file>`.
    It strips descriptions, bios, images and page chrome. Then check the result by eye.
  - Use fictional names in samples and tests.
  - Never commit anything from the owner's email or notes. Drafts and personal notes go in
    `private/` (gitignored).
