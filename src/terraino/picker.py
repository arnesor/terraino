"""Draw the area of a mapless world on a map of Norway, in the browser.

A small HTTP server on 127.0.0.1 serves one page (``picker.html``) where the user drags
a rectangle in EUREF89 / UTM33. The page posts the rectangle back, the server checks it
as ``terraino build --area`` would, and :func:`pick` returns it.
"""

from __future__ import annotations

import json
import logging
import threading
import webbrowser
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from typing import Any

from terraino.ingest.area import (
    MAX_AREA_M2,
    MIN_SIDE_M,
    NORWAY_UTM33,
    AreaError,
    check_area,
)
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

PAGE = "picker.html"
CONFIG_PLACEHOLDER = "/*CONFIG*/null"
MAX_BODY_BYTES = 10_000


class PickerServer(ThreadingHTTPServer):
    """Serves the picker page on a free port of 127.0.0.1 until an area is chosen.

    Attributes:
        margin: Metres around the area, shown on the page.
        chosen: The area once chosen, or None.
        done: Set when an area is chosen or the page gives up.
    """

    def __init__(self, margin: float) -> None:
        """Listen on a free port of 127.0.0.1."""
        super().__init__(("127.0.0.1", 0), _Handler)
        self.margin = margin
        self.chosen: Extent | None = None
        self.done = threading.Event()

    @property
    def url(self) -> str:
        """Where the page is."""
        return f"http://localhost:{self.server_port}/"

    def page(self) -> bytes:
        """The picker page, with the limits it checks against."""
        config = {
            "maxAreaM2": MAX_AREA_M2,
            "minSideM": MIN_SIDE_M,
            "norway": list(NORWAY_UTM33.as_tuple()),
            "margin": self.margin,
        }
        html = files("terraino").joinpath(PAGE).read_text(encoding="utf-8")
        return html.replace(CONFIG_PLACEHOLDER, json.dumps(config)).encode()


def parse_area(body: Any) -> Extent:
    """The area posted by the page, rounded to whole metres and checked.

    Raises:
        AreaError: If the body is not an area that can be built.

    Examples:
        >>> parse_area({"xmin": 193986.4, "ymin": 6622759, "xmax": 196356, "ymax": 6625129})
        Extent(x0=193986, y0=6622759, x1=196356, y1=6625129)
    """
    try:
        x0, y0, x1, y1 = (
            round(float(body[k])) for k in ("xmin", "ymin", "xmax", "ymax")
        )
    except (KeyError, TypeError, ValueError):
        msg = "Expected xmin, ymin, xmax and ymax"
        raise AreaError(msg) from None
    if x0 >= x1 or y0 >= y1:
        msg = "xmin must be below xmax, and ymin below ymax"
        raise AreaError(msg)
    area = Extent(x0, y0, x1, y1)
    check_area(area)
    return area


class _Handler(BaseHTTPRequestHandler):
    server: PickerServer

    def do_GET(self) -> None:
        if self.path != "/":
            self._reply(HTTPStatus.NOT_FOUND, b"Not found", "text/plain")
            return
        self._reply(HTTPStatus.OK, self.server.page(), "text/html; charset=utf-8")

    def do_POST(self) -> None:
        if self.path == "/cancel":
            self.server.done.set()
            self._json(HTTPStatus.OK, {"ok": True})
            return
        if self.path != "/area":
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Too large"})
            return
        try:
            area = parse_area(json.loads(self.rfile.read(length) or b"null"))
        except (AreaError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        # Record the area before replying, so whoever gets the reply sees it.
        self.server.chosen = area
        self.server.done.set()
        self._json(HTTPStatus.OK, {"ok": True})

    def _json(self, status: HTTPStatus, data: dict[str, Any]) -> None:
        self._reply(status, json.dumps(data).encode(), "application/json")

    def _reply(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - overrides
        log.debug(format, *args)


def pick(
    margin: float,
    announce: Callable[[str], None] = log.info,
    *,
    open_browser: bool = True,
) -> Extent | None:
    """Let the user draw an area in the browser; return it, or None if they gave up.

    Args:
        margin: Metres around the area, shown on the page.
        announce: Shows the user where the page is.
        open_browser: Try to open the page in the browser. The URL is always
            announced, as under WSL opening the browser often does nothing.
    """
    server = PickerServer(margin)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        announce(f"Draw the area on the map at {server.url} (Ctrl+C to stop)")
        if open_browser:
            webbrowser.open(server.url)
        while not server.done.wait(0.5):
            pass
    finally:
        server.shutdown()
        server.server_close()
    return server.chosen
