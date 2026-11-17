"""Watercourses and water channels traced from Kartverket's map."""

import logging
from pathlib import Path
from unittest import mock

import numpy as np
import pytest
import requests
from PIL import Image, ImageDraw
from shapely import LineString, box

from terraino.fetch import watercourses
from terraino.fetch.osm import OsmFeature
from terraino.fetch.watercourses import join_pieces, trace_tile
from terraino.ingest.georef import Extent
from terraino.process.fuse import apply_osm
from terraino.process.symbols import Ground, SymbolSet
from terraino.process.tracks import collect_tracks
from terraino.process.watercourses import paint_watercourses
from tests.test_buildings_fuse import EXTENT, cell, empty_layers

ISOM = SymbolSet.load("isom2017")
BLUE = (0, 164, 253, 255)
PALE = (222, 253, 253, 255)


def rendering(lines: list[tuple[list[tuple[int, int]], tuple[int, ...]]]) -> np.ndarray:
    """A 400 x 400 pixel tile with lines drawn one pixel wide, anti-aliased edges."""
    img = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for points, colour in lines:
        draw.line(points, fill=colour, width=1)
        # A faint second pixel beside the line, as anti-aliasing leaves.
        draw.line([(x + 1, y) for x, y in points], fill=(*colour[:3], 80), width=1)
    return np.asarray(img)


def test_lines_are_traced_by_colour() -> None:
    rgba = rendering(
        [
            ([(10, 10), (200, 150), (390, 160)], BLUE),  # a stream
            ([(50, 300), (350, 300)], PALE),  # a ditch
            ([(300, 50), (303, 52)], BLUE),  # a speck
        ]
    )
    # 0.25 m per pixel: the tile is 100 m across, west edge 1000, north edge 2000.
    keep = box(1000, 1900, 1100, 2000)
    pieces = join_pieces(trace_tile(rgba, 1000.0, 2000.0, keep))
    lengths = sorted((kind, line.length) for kind, line in pieces)
    assert [kind for kind, _ in lengths] == ["small_stream", "water_channel"]
    # 426 and 300 pixels drawn; the speck is dropped.
    assert lengths[0][1] == pytest.approx(106.6, abs=2)
    assert lengths[1][1] == pytest.approx(75, abs=1)
    stream = next(line for kind, line in pieces if kind == "small_stream")
    start, end = sorted([stream.coords[0], stream.coords[-1]])
    assert start == pytest.approx((1002.6, 1997.4), abs=0.5)
    assert end == pytest.approx((1097.6, 1959.9), abs=0.5)


def test_only_the_tile_without_its_overlap_is_kept() -> None:
    rgba = rendering([([(0, 200), (399, 200)], BLUE)])
    keep = box(1020, 1900, 1080, 2000)  # the middle 60 m
    ((_, line),) = trace_tile(rgba, 1000.0, 2000.0, keep)
    assert line.length == pytest.approx(60, abs=0.5)


def test_pieces_meeting_at_a_tile_edge_are_joined() -> None:
    west = ("small_stream", LineString([(0, 0), (800, 3)]))
    east = ("small_stream", LineString([(800.2, 3.1), (900, 10)]))
    ((kind, line),) = join_pieces([west, east])
    assert kind == "small_stream"
    assert line.length == pytest.approx(900, abs=1)


def test_no_watercourses_when_the_map_cannot_be_read(
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
        found = watercourses.fetch_watercourses(25832, Extent(0, 0, 100, 100), tmp_path)
    assert found is None
    assert "No watercourses from Kartverket's map" in caplog.text


def test_traced_lines_are_painted_as_their_symbols_outside_the_map() -> None:
    in_map = np.zeros(EXTENT.raster_shape(1), dtype=bool)
    in_map[:, :50] = True
    layers = empty_layers(in_map)
    stream = ("small_stream", LineString([(0, 50), (100, 50)]))
    paint_watercourses(layers, [stream], ISOM, EXTENT, box(0, 0, 50, 100))
    assert layers.ground[cell(75, 50)] == Ground.WATER
    assert layers.speed[cell(75, 50)] == pytest.approx(0.7)
    assert layers.clear[cell(75, 50)]
    assert layers.ground[cell(75, 53)] != Ground.WATER
    assert layers.ground[cell(25, 50)] == Ground.UNKNOWN  # the map decides


def test_traced_lines_are_drawn_as_their_symbols_outside_the_map() -> None:
    traced = [
        ("small_stream", LineString([(0, 0), (100, 0)])),
        ("water_channel", LineString([(0, 20), (100, 20)])),
    ]
    tracks = collect_tracks([], ISOM, [], box(-1, -50, 50, 50), traced=traced)
    assert sorted((t.kind, t.width, t.coords[0]) for t in tracks) == [
        ("small_stream", 1.0, (50.0, 0.0)),
        ("water_channel", 0.8, (50.0, 20.0)),
    ]


@pytest.mark.parametrize(("streams", "painted"), [(True, 2), (False, 1)])
def test_osm_streams_give_way_to_traced_ones(streams: bool, painted: int) -> None:
    layers = empty_layers()
    stream = OsmFeature(
        LineString([(0, 30), (100, 30)]), {"waterway": "stream"}, "way/1"
    )
    river = OsmFeature(LineString([(0, 70), (100, 70)]), {"waterway": "river"}, "way/2")
    apply_osm(layers, [stream, river], [], [], EXTENT, streams=streams)
    wet = [layers.ground[cell(50, y)] == Ground.WATER for y in (30, 70)]
    assert sum(wet) == painted
    assert wet[1]  # rivers stay
