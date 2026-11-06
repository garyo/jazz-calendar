import json
from pathlib import Path

import httpx
import pytest

from jazzcal import submit

SITE = "https://site.example"


def test_sends_each_gig_with_the_defaults_and_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("JAZZCAL_SITE", SITE)
    monkeypatch.setenv("JAZZCAL_SUBMIT_TOKEN", "t0k")
    batch = tmp_path / "gigs.json"
    me = {"submitter_name": "Pat Example", "submitter_email": "pat@example.com"}
    gigs = [
        {"title": "The Fictional Trio", "date": "2026-12-01", "venue": "lilypad"},
        {"title": "Imaginary Quartet", "date": "2026-12-02", "submitter_name": "Sam"},
    ]
    batch.write_text(json.dumps({"defaults": me, "gigs": gigs}))
    sent: list[dict[str, str]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == f"{SITE}/api/submissions"
        assert request.headers["authorization"] == "Bearer t0k"
        sent.append(json.loads(request.content))
        if len(sent) == 2:
            return httpx.Response(400, json={"fields": {"venue": "Choose a venue."}})
        return httpx.Response(201, json={"id": "x", "status": "pending"})

    assert not submit.submit(batch, transport=httpx.MockTransport(handle))
    assert sent == [me | gigs[0], me | gigs[1]]
    assert sent[1]["submitter_name"] == "Sam"
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "queued The Fictional Trio (2026-12-01)"
    assert out[1].startswith("FAILED Imaginary Quartet (2026-12-02): HTTP 400")


def test_needs_the_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JAZZCAL_SUBMIT_TOKEN", raising=False)
    with pytest.raises(SystemExit, match="JAZZCAL_SUBMIT_TOKEN"):
        submit.submit(tmp_path / "unread.json")
