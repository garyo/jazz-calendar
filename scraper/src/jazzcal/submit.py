"""`jazzcal submit`: queue gigs for review on /admin, as the site's "Submit a gig" form does,
with $JAZZCAL_SUBMIT_TOKEN standing in for the form's Turnstile check.

The batch is a JSON file, `{"defaults": {...}, "gigs": [{...}, ...]}`. Each gig has the
form's fields (`POST /api/submissions` in site/README.md), and the defaults fill in what a
gig leaves out, such as the submitter's name and email. Keep batches in private/, since
they hold those.
"""

import json
import os
from pathlib import Path

import httpx

from jazzcal import export


def submit(batch_file: Path, *, transport: httpx.BaseTransport | None = None) -> bool:
    """Send each gig in the batch, printing what became of it; True when all were queued."""
    token = os.environ.get("JAZZCAL_SUBMIT_TOKEN")
    if not token:
        raise SystemExit("set JAZZCAL_SUBMIT_TOKEN to submit")
    batch = json.loads(batch_file.read_text())
    defaults = batch.get("defaults", {})
    queued = True
    with httpx.Client(
        base_url=export.site_url(),
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
        transport=transport,
    ) as client:
        for gig in batch["gigs"]:
            body = defaults | gig
            label = f"{body.get('title')} ({body.get('date', 'series')})"
            resp = client.post("/api/submissions", json=body)
            if resp.status_code == httpx.codes.CREATED:
                print(f"queued {label}")
            else:
                queued = False
                print(f"FAILED {label}: HTTP {resp.status_code} {resp.text}")
    return queued
