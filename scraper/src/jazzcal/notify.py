"""Push notifications to the owner through ntfy, configured as deploy/run.sh has it:
NTFY_USER and NTFY_PASS (nothing is sent without them), NTFY_URL and NTFY_TOPIC."""

import logging
import os

import httpx

log = logging.getLogger(__name__)

DEFAULT_URL = "https://ntfy.oberbrunner.com"
DEFAULT_TOPIC = "misc"


def send(title: str, message: str, transport: httpx.BaseTransport | None = None) -> bool:
    """Publish a notification at default priority; True if it went out. Never raises: failing
    to notify mustn't fail the run."""
    user, password = os.environ.get("NTFY_USER"), os.environ.get("NTFY_PASS")
    if not (user and password):
        return False
    payload = {
        "topic": os.environ.get("NTFY_TOPIC", DEFAULT_TOPIC),
        "title": title,
        "message": message,
        "tags": ["warning"],
    }
    try:
        with httpx.Client(timeout=15, transport=transport) as client:
            url = os.environ.get("NTFY_URL", DEFAULT_URL).rstrip("/")
            client.post(url, json=payload, auth=(user, password)).raise_for_status()
    except Exception as e:
        log.warning("ntfy notification failed: %s", e)
        return False
    return True
