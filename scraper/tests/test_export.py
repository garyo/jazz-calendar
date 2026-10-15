from pathlib import Path

import httpx
import pytest

from jazzcal import export

SITE = "https://site.example"
PING = "https://ping.example/check"


@pytest.fixture
def out_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("JAZZCAL_SITE", SITE)
    monkeypatch.setenv("JAZZCAL_PUBLISH_TOKEN", "t0k")
    monkeypatch.setenv("JAZZCAL_HEALTHCHECK_URL", PING)
    monkeypatch.setattr(export.time, "sleep", lambda _: None)
    for name in export.FILES:
        (tmp_path / name).write_text(name)
    return tmp_path


def site(answers: dict[str, list[int | Exception]], log: list[str]) -> httpx.MockTransport:
    """Answers each URL with the given statuses (or exceptions) in turn, then 200s."""

    def handle(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        log.append(f"{request.method} {url.removeprefix(SITE)}")
        queue = answers.get(url, [])
        answer = queue.pop(0) if queue else 200
        if isinstance(answer, Exception):
            raise answer
        return httpx.Response(answer)

    return httpx.MockTransport(handle)


def publish(out_dir: Path, answers: dict[str, list[int | Exception]]) -> list[str]:
    log: list[str] = []
    export.publish(out_dir, transport=site(answers, log))
    return log


def test_publish_uploads_status_last_and_retries(out_dir: Path) -> None:
    requests = publish(
        out_dir,
        {
            f"{SITE}/api/publish/events.json": [httpx.ConnectError("reset"), 502],
            f"{SITE}/api/publish/status.json": [503],
            PING: [httpx.ConnectError("down")],
        },
    )
    assert requests == [
        "PUT /api/publish/calendar.ics",
        "PUT /api/publish/events.json",
        "PUT /api/publish/events.json",
        "PUT /api/publish/events.json",
        "PUT /api/publish/status.json",
        "PUT /api/publish/status.json",
        f"GET {PING}",
    ]


@pytest.mark.parametrize(
    ("answers", "attempts"),
    [([401], 1), ([500] * 10, 1 + export.PUT_RETRIES)],
)
def test_publish_fails_on_client_errors_and_lasting_server_errors(
    out_dir: Path, answers: list[int | Exception], attempts: int
) -> None:
    log: list[str] = []
    transport = site({f"{SITE}/api/publish/calendar.ics": answers}, log)
    with pytest.raises(httpx.HTTPStatusError):
        export.publish(out_dir, transport=transport)
    assert log == ["PUT /api/publish/calendar.ics"] * attempts


def test_failed_healthcheck_does_not_fail_the_publish(out_dir: Path) -> None:
    assert publish(out_dir, {PING: [500]})[-1] == f"GET {PING}"
