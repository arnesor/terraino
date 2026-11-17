"""The page for drawing a mapless world's area, and the server behind it."""

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest

from terraino.ingest.area import MAX_AREA_M2
from terraino.ingest.georef import Extent
from terraino.picker import CONFIG_PLACEHOLDER, PickerServer, pick

AREA = {"xmin": 193986, "ymin": 6622759, "xmax": 196356, "ymax": 6625129}


@pytest.fixture
def server() -> Iterator[PickerServer]:
    """A picker server running in the background."""
    running = PickerServer(margin=300)
    thread = threading.Thread(target=running.serve_forever, daemon=True)
    thread.start()
    yield running
    running.shutdown()
    running.server_close()


def post(url: str, body: Any) -> tuple[int, dict[str, Any]]:
    """POST ``body`` as JSON; return the status and the JSON reply."""
    request = urllib.request.Request(  # noqa: S310 - a local test server
        url, data=json.dumps(body).encode(), method="POST"
    )
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_page_gets_the_limits(server: PickerServer) -> None:
    with urllib.request.urlopen(server.url) as response:  # noqa: S310
        page = response.read().decode()
    assert CONFIG_PLACEHOLDER not in page
    assert f'"maxAreaM2": {MAX_AREA_M2}' in page
    assert '"margin": 300' in page


def test_an_area_too_large_is_refused(server: PickerServer) -> None:
    status, reply = post(server.url + "area", {**AREA, "xmax": 205073})
    assert status == 400
    assert "at most 25 km²" in reply["error"]
    assert server.chosen is None
    assert not server.done.is_set()


def test_a_reply_that_is_not_an_area_is_refused(server: PickerServer) -> None:
    status, reply = post(server.url + "area", {"xmin": "west"})
    assert status == 400
    assert "Expected xmin" in reply["error"]


def test_the_chosen_area_is_kept_in_whole_metres(server: PickerServer) -> None:
    status, _ = post(server.url + "area", {**AREA, "xmin": 193986.4})
    assert status == 200
    assert server.done.is_set()
    assert server.chosen == Extent(193986, 6622759, 196356, 6625129)


def test_pick_returns_the_area_drawn() -> None:
    urls: list[str] = []
    ready = threading.Event()

    def announce(text: str) -> None:
        urls.append(text.split(" at ")[1].split()[0])
        ready.set()

    def draw() -> None:
        ready.wait(5)
        post(urls[0] + "area", AREA)

    threading.Thread(target=draw, daemon=True).start()
    assert pick(300, announce, open_browser=False) == Extent(
        193986, 6622759, 196356, 6625129
    )


def test_pick_returns_none_when_cancelled() -> None:
    ready = threading.Event()
    urls: list[str] = []

    def announce(text: str) -> None:
        urls.append(text.split(" at ")[1].split()[0])
        ready.set()

    def cancel() -> None:
        ready.wait(5)
        post(urls[0] + "cancel", {})

    threading.Thread(target=cancel, daemon=True).start()
    assert pick(300, announce, open_browser=False) is None
