"""Download files once and keep them in a local cache folder."""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from pathlib import Path

import requests

log = logging.getLogger(__name__)

USER_AGENT = (
    "terraino/0.0 (orienteering 3D world builder; https://github.com/arnesor/terraino)"
)
TIMEOUT_S = 120
RETRIES = 5


class DownloadError(RuntimeError):
    """A download failed after retries."""


def cached_download(
    url: str,
    params: Mapping[str, str],
    path: Path,
    *,
    expect_content_type: str | None = None,
) -> Path:
    """Download ``url`` to ``path`` unless the file is already there.

    The file is written to a temporary name first, so an interrupted download never
    leaves a broken file in the cache.

    Args:
        url: Service URL.
        params: Query parameters.
        path: Cache file to write.
        expect_content_type: If given, a response with another content type (typically an
            HTML or XML error page) is treated as a failure.

    Returns:
        ``path``.

    Raises:
        DownloadError: If all attempts failed.
    """
    if path.is_file():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    last_error = ""
    for attempt in range(1, RETRIES + 1):
        try:
            response = requests.get(
                url,
                params=params,
                timeout=TIMEOUT_S,
                headers={"User-Agent": USER_AGENT},
            )
        except requests.RequestException as exc:
            last_error = str(exc)
        else:
            content_type = response.headers.get("Content-Type", "")
            if response.ok and (
                expect_content_type is None
                or content_type.startswith(expect_content_type)
            ):
                tmp = path.with_suffix(path.suffix + ".part")
                tmp.write_bytes(response.content)
                tmp.replace(path)
                return path
            last_error = (
                f"HTTP {response.status_code} {content_type}: {response.text[:300]}"
            )
        log.warning(
            "Download attempt %d of %s failed: %s", attempt, url, last_error[:120]
        )
        if attempt < RETRIES:
            time.sleep(2**attempt)
    msg = f"Could not download {url} {dict(params)}: {last_error}"
    raise DownloadError(msg)
