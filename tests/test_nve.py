"""Power lines from NVE, outside the orienteering map."""

import json
import logging
from pathlib import Path
from typing import Any
from unittest import mock

import numpy as np
import pytest
import requests
from shapely import LineString, box

from terraino.fetch import nve
from terraino.ingest.georef import Extent
from terraino.process.features import (
    LineFeature,
    clear_along,
    clear_widths,
    place_power_poles,
    power_lines_outside,
)
from terraino.process.symbols import SymbolSet
from tests.test_buildings_fuse import EXTENT, cell, empty_layers

# Around the fixture map, in zone 32.
WORLD = Extent(666448, 6646176, 666976, 6646624)


def reply(paths: list[list[list[float]]], *, more: bool = False) -> mock.Mock:
    data: dict[str, Any] = {"features": [{"geometry": {"paths": paths}}]}
    if more:
        data["exceededTransferLimit"] = True
    response = mock.Mock(ok=True, headers={"Content-Type": "application/json"})
    response.content = json.dumps(data).encode()
    return response


def test_layers_pages_and_cut_to_the_world(tmp_path: Path) -> None:
    replies = [
        reply([[[666500, 6646200], [666600, 6646200]]]),  # transmission
        reply([], more=False),  # regional
        # Distribution, in two pages; the second runs out of the world to the east.
        reply([[[666500, 6646300], [666600, 6646300]]], more=True),
        reply([[[666900, 6646400], [667100, 6646400]]]),
    ]
    with mock.patch("terraino.fetch.cache.requests.get", side_effect=replies) as get:
        lines = nve.fetch_power_lines(25832, WORLD, tmp_path)
    assert [(p.kind, round(p.line.length)) for p in lines] == [
        ("pylon_line", 100),
        ("power_line", 100),
        ("power_line", 76),
    ]
    calls = get.call_args_list
    assert [c.args[0].rsplit("/", 2)[1] for c in calls] == ["0", "1", "2", "2"]
    params = calls[0].kwargs["params"]
    assert params["inSR"] == params["outSR"] == "25832"
    assert params["geometry"] == "666448,6646176,666976,6646624"
    assert calls[3].kwargs["params"]["resultOffset"] == str(nve.PAGE_SIZE)

    with mock.patch("terraino.fetch.cache.requests.get") as get:
        again = nve.fetch_power_lines(25832, WORLD, tmp_path)
    get.assert_not_called()
    assert [p.line for p in again] == [p.line for p in lines]


@pytest.mark.parametrize(
    "failure",
    [
        {"side_effect": requests.ConnectionError("down")},
        {"return_value": reply([])},
    ],
)
def test_no_power_lines_with_a_warning_when_nve_fails(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, failure: dict[str, Any]
) -> None:
    if "return_value" in failure:
        failure["return_value"].content = b'{"error": {"code": 500}}'
    with (
        mock.patch("terraino.fetch.cache.requests.get", **failure),
        mock.patch("terraino.fetch.cache.time.sleep"),
        caplog.at_level(logging.WARNING),
    ):
        assert nve.fetch_power_lines(25832, WORLD, tmp_path) == []
    assert "No power lines from NVE" in caplog.text


def test_lines_inside_the_map_are_left_out_and_pieces_joined() -> None:
    found = [
        ("pylon_line", LineString([(0, 0), (100, 0)])),
        ("power_line", LineString([(0, 50), (100, 50)])),
        ("power_line", LineString([(100, 50), (200, 50)])),
    ]
    lines = power_lines_outside(found, box(-10, -10, 50, 10))
    assert sorted((f.kind, f.coords[0], f.coords[-1], f.size) for f in lines) == [
        ("power_line", (0.0, 50.0), (200.0, 50.0), 10.0),
        ("pylon_line", (50.0, 0.0), (100.0, 0.0), 25.0),
    ]


MAP_AREA = box(-10, -50, 120, 50)


def test_line_continuing_the_maps_is_joined_to_its_end_pole() -> None:
    # The map's line stops 20 m inside the map's edge; NVE's is cut at the edge.
    on_map = [LineFeature("power_line", [(0, 0), (100, 0)], 10.0)]
    outside = [LineFeature("power_line", [(120, 2), (300, 2)], 10.0)]
    map_line, nve_line = place_power_poles(
        on_map, outside, [(50, 0), (180, 2)], MAP_AREA
    )
    assert map_line.poles[-1] == (100.0, 0.0)
    assert nve_line.coords[0] == (100.0, 0.0)
    assert nve_line.poles[:2] == ((100.0, 0.0), (180.0, 2.0))


@pytest.mark.parametrize(
    "coords",
    [
        [(120, 45), (300, 45)],  # cut at the edge, but far from the map's line
        [(140, 2), (300, 2)],  # near, but not cut at the edge
    ],
)
def test_other_lines_are_not_joined(coords: list[tuple[float, float]]) -> None:
    on_map = [LineFeature("power_line", [(0, 0), (100, 0)], 10.0)]
    outside = [LineFeature("power_line", coords, 10.0)]
    map_line, nve_line = place_power_poles(on_map, outside, [(50, 0)], MAP_AREA)
    assert map_line.poles[-1] == (100.0, 0.0)
    assert nve_line.coords == coords


def test_forest_strip_along_lines_outside_the_map() -> None:
    in_map = np.zeros(EXTENT.raster_shape(1), dtype=bool)
    in_map[:, :50] = True
    layers = empty_layers(in_map)
    widths = clear_widths(SymbolSet.load("isom2017"))
    assert (widths["power_line"], widths["pylon_line"]) == (12.0, 30.0)
    clear_along(
        layers, [LineFeature("pylon_line", [(0, 50), (100, 50)], 25.0)], widths, EXTENT
    )
    assert layers.clear[cell(75, 50)]
    assert layers.clear[cell(75, 36)]
    assert not layers.clear[cell(75, 30)]
    assert not layers.clear[cell(25, 50)]  # inside the map: the map decides
