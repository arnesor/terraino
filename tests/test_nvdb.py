"""Paths and vehicle tracks from NVDB."""

import json
import logging
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
import requests

from terraino.fetch import nvdb
from terraino.ingest.georef import Extent

# Around the fixture map, in zone 32.
EXTENT = Extent(666448, 6646176, 666976, 6646624)


def segment(kind: str, coords: str) -> dict[str, Any]:
    return {"typeVeg": kind, "geometri": {"wkt": f"LINESTRING Z ({coords})"}}


def page(segments: list[dict[str, Any]], size: int, start: str) -> dict[str, Any]:
    meta = {"returnert": len(segments), "sidestørrelse": size, "neste": {"start": start}}
    return {"objekter": segments, "metadata": meta}


def reply(data: dict[str, Any]) -> mock.Mock:
    response = mock.Mock(ok=True, headers={"Content-Type": "application/json"})
    response.content = json.dumps(data).encode()
    return response


def test_pages_are_followed_and_lines_cut_to_the_world(tmp_path: Path) -> None:
    first = page(
        [
            segment("Sti", "666500 6646200 10, 666600 6646300 11"),
            # Runs out of the world to the east.
            segment("Traktorveg", "666900 6646400 10, 667100 6646400 10"),
        ],
        size=2,
        start="next",
    )
    second = page([segment("Gangveg", "666500 6646500 0, 666600 6646500 0")], 2, "x")
    with mock.patch(
        "terraino.fetch.cache.requests.get", side_effect=[reply(first), reply(second)]
    ) as get:
        lines = nvdb.fetch_paths(25832, EXTENT, tmp_path)
    assert [(n.kind, n.width) for n in lines] == [
        ("path", 1.2),
        ("vehicle_track", 3.0),
    ]
    assert lines[1].line.length == pytest.approx(76)
    first_call, second_call = get.call_args_list
    params = first_call.kwargs["params"]
    assert params["srid"] == "5972"
    assert params["typeveg"] == "sti,traktorveg"
    assert "start" not in params
    assert second_call.kwargs["params"]["start"] == "next"
    assert first_call.kwargs["headers"]["X-Client"] == "terraino"
    # The query box is in UTM33, around the world.
    x0, y0, x1, y1 = (float(v) for v in params["kartutsnitt"].split(","))
    assert 331000 < x0 < x1 < 331700
    assert 6646200 < y0 < y1 < 6646800

    # Cached: the second build reads the same pages without downloading.
    with mock.patch("terraino.fetch.cache.requests.get") as get:
        again = nvdb.fetch_paths(25832, EXTENT, tmp_path)
    get.assert_not_called()
    assert [n.line for n in again] == [n.line for n in lines]


def test_no_paths_with_a_warning_when_nvdb_fails(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with (
        mock.patch(
            "terraino.fetch.cache.requests.get",
            side_effect=requests.ConnectionError("down"),
        ),
        mock.patch("terraino.fetch.cache.time.sleep"),
        caplog.at_level(logging.WARNING),
    ):
        assert nvdb.fetch_paths(25832, EXTENT, tmp_path) == []
    assert "No paths from NVDB" in caplog.text
