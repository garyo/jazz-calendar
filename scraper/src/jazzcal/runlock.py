"""One run at a time. Every command that changes the scraper's state holds this lock, so the
daily run and the quick republish (`jazzcal refresh`) never overlap: whichever starts second
waits for the first to finish."""

import fcntl
import logging
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

log = logging.getLogger(__name__)


@contextmanager
def held(path: Path) -> Generator[None]:
    """Hold the lock at `path`, waiting for whoever holds it now. Closing the file releases it,
    so a run that dies never leaves it held."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.info("waiting for another run to finish")
            fcntl.flock(f, fcntl.LOCK_EX)
        yield
