import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from shapely import box

from otest.fetch import topo
from otest.fetch.cache import DownloadError
from otest.fetch.topo_buildings import (
    FILL,
    ROOF_LINE,
    fetch_topo_buildings,
    trace_buildings,
)
from otest.ingest.georef import Extent
from otest.process.roofs import parts_from_lines

X0, Y1 = 1000.0, 2000.0


def tile(height: int = 300, width: int = 300) -> np.ndarray:
    return np.zeros((height, width, 4), np.uint8)


def paint(
    img: np.ndarray, rows: slice, cols: slice, colour: tuple[int, int, int]
) -> None:
    img[rows, cols] = (*colour, 255)


def test_buildings_cut_by_the_tile_edge_are_left_out() -> None:
    img = tile()
    paint(img, slice(0, 50), slice(100, 180), FILL)  # touches the top edge
    paint(img, slice(100, 160), slice(100, 180), FILL)
    (b,) = trace_buildings(img, X0, Y1)
    assert b.footprint.bounds[1] == pytest.approx(Y1 - 16.15, abs=0.1)


def test_only_buildings_centred_in_the_tile_are_kept() -> None:
    img = tile()
    paint(img, slice(100, 160), slice(20, 60), FILL)  # centre 4 m from the west edge
    paint(img, slice(100, 160), slice(200, 260), FILL)
    found = trace_buildings(img, X0, Y1, keep=box(X0 + 10, Y1 - 30, X0 + 30, Y1))
    assert len(found) == 1
    assert found[0].footprint.centroid.x == pytest.approx(X0 + 23, abs=0.2)


def test_cross_gabled_house() -> None:
    img = tile()
    # Main block 12 x 10 m (ridge east-west) crossed by a 5 m wing running north-south.
    paint(img, slice(100, 200), slice(80, 200), FILL)
    paint(img, slice(80, 220), slice(115, 165), FILL)
    paint(img, slice(149, 151), slice(85, 115), ROOF_LINE)  # the main ridge, west part
    paint(img, slice(149, 151), slice(165, 195), ROOF_LINE)  # east part
    paint(img, slice(85, 215), slice(139, 141), ROOF_LINE)  # the wing's ridge
    (house,) = trace_buildings(img, X0, Y1)
    lines = [(r.x0, r.y0, r.x1, r.y1) for r in house.lines]
    parts = parts_from_lines(house.footprint, lines, 4.0, math.radians(35))
    widths = sorted(round(2 * p.half_width) for p in parts)
    assert widths == [5, 10]
    directions = sorted(round(math.degrees(p.angle)) % 180 for p in parts)
    assert directions == [0, 90]


def test_no_buildings_without_the_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*args: Any, **kwargs: Any) -> Path:
        raise DownloadError("offline")

    monkeypatch.setattr(topo, "cached_download", fail)
    assert fetch_topo_buildings(25832, Extent(0, 0, 500, 500), tmp_path) == []


def test_wings_split_at_outlines_and_share_a_complex() -> None:
    blue = (115, 163, 212)
    img = tile()
    # Two wings of a public building, drawn against each other with a black outline.
    paint(img, slice(50, 150), slice(50, 120), blue)
    paint(img, slice(50, 150), slice(121, 250), blue)
    paint(img, slice(50, 150), slice(120, 121), (20, 25, 30))
    paint(img, slice(99, 100), slice(125, 245), ROOF_LINE)  # ridge of the east wing
    west, east = sorted(
        trace_buildings(img, X0, Y1), key=lambda b: b.footprint.centroid.x
    )
    assert west.category == east.category == "public"
    assert west.complex == east.complex
    assert west.footprint.area == pytest.approx(7.0 * 10.0, rel=0.06)
    assert [round(line.length) for line in east.lines] == [12]
