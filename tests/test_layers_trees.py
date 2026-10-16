from typing import Any

import numpy as np
import numpy.typing as npt
import pytest
from shapely import Polygon, box

from otest.ingest.georef import Extent
from otest.process.fuse import fill_unknown_ground
from otest.process.layers import TREES_NONE, GroundLayers, rasterize_map
from otest.process.symbols import Ground, SymbolSet
from otest.process.trees import (
    canopy_height,
    effective_canopy,
    find_tree_tops,
    place_trees,
    understorey_cells,
)

EXTENT = Extent(0, 0, 100, 100)
MAP_AREA = box(10, 10, 90, 90)
ISOM = SymbolSet.load("isom2000")


def area(oid: int, sym: str, polygon: Polygon) -> dict[str, Any]:
    return {
        "geometry": {"type": "Polygon", "coordinates": [list(polygon.exterior.coords)]},
        "properties": {"oid": oid, "sym": sym},
    }


def line(oid: int, sym: str, coords: list[tuple[float, float]]) -> dict[str, Any]:
    return {
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"oid": oid, "sym": sym},
    }


def cell(x: float, y: float) -> tuple[int, int]:
    """Row and column of the 1 m cell containing projected point (x, y)."""
    return int(EXTENT.y1 - y), int(x - EXTENT.x0)


@pytest.fixture
def layers() -> GroundLayers:
    features = [
        area(0, "401.0", box(20, 20, 40, 40)),  # open land
        area(1, "408.0", box(50, 50, 80, 80)),  # difficult forest
        area(2, "310.0", box(60, 60, 70, 70)),  # marsh on top of the green
        area(3, "301.0", box(20, 60, 30, 70)),  # lake
        line(4, "506.0", [(10.0, 45.0), (90.0, 45.0)]),  # footpath
        line(5, "999.0", [(10.0, 15.0), (90.0, 15.0)]),  # unknown symbol
    ]
    return rasterize_map(features, ISOM, EXTENT, MAP_AREA)


def test_ground_classes(layers: GroundLayers) -> None:
    assert layers.ground[cell(5, 5)] == Ground.UNKNOWN
    assert layers.ground[cell(15, 85)] == Ground.FOREST
    assert layers.ground[cell(30, 30)] == Ground.OPEN
    assert layers.ground[cell(25, 65)] == Ground.WATER
    assert layers.ground[cell(50, 45)] == Ground.PATH
    assert layers.ground[cell(65, 65)] == Ground.MARSH


def test_overprinting_marsh_keeps_vegetation(layers: GroundLayers) -> None:
    assert layers.young[cell(65, 65)] == pytest.approx(8)
    assert layers.speed[cell(65, 65)] == pytest.approx(0.6)
    assert layers.speed[cell(55, 55)] == pytest.approx(0.5)


def test_tree_rules_and_clear_strips(layers: GroundLayers) -> None:
    assert layers.tree_rule[cell(30, 30)] == TREES_NONE
    assert layers.clear[cell(50, 45)]
    assert not layers.clear[cell(50, 50)]
    assert layers.in_map[cell(50, 50)]
    assert not layers.in_map[cell(5, 5)]


def test_fill_unknown_ground(layers: GroundLayers) -> None:
    canopy = np.zeros(layers.ground.shape, dtype=np.float32)
    canopy[cell(5, 95)] = 15
    fill_unknown_ground(layers, canopy)
    assert layers.ground[cell(5, 95)] == Ground.FOREST
    assert layers.ground[cell(5, 5)] == Ground.OPEN
    assert layers.ground[cell(30, 30)] == Ground.OPEN


def test_canopy_height_clips() -> None:
    dom = np.array([[100.0, 95.0, 300.0]], dtype=np.float32)
    dtm = np.array([[90.0, 100.0, 100.0]], dtype=np.float32)
    assert canopy_height(dom, dtm).tolist() == [[10.0, 0.0, 60.0]]


def cone_forest(
    tops: list[tuple[int, int, float]], size: int = 100
) -> npt.NDArray[np.float32]:
    """A canopy of cone-shaped trees at (row, col, height)."""
    yy, xx = np.mgrid[0:size, 0:size]
    chm = np.zeros((size, size), dtype=np.float32)
    for r, c, h in tops:
        cone = h - 1.5 * np.hypot(yy - r, xx - c)
        chm = np.maximum(chm, cone.astype(np.float32))
    return chm


def test_tree_tops_found() -> None:
    chm = cone_forest([(20, 20, 15.0), (20, 40, 22.0), (60, 60, 8.0)])
    rows, cols, heights = find_tree_tops(chm)
    found = {(int(r), int(c)) for r, c in zip(rows, cols, strict=True)}
    assert {(20, 20), (20, 40), (60, 60)} <= found
    assert len(found) == 3
    assert sorted(np.round(heights).tolist()) == [8.0, 15.0, 22.0]


def test_low_vegetation_is_not_a_tree() -> None:
    chm = cone_forest([(50, 50, 2.0)])
    rows, _, _ = find_tree_tops(chm)
    assert len(rows) == 0


def test_understorey_fills_to_target() -> None:
    chm = np.full((32, 32), 15.0, dtype=np.float32)
    allowed = np.ones(chm.shape, dtype=bool)
    tops = (np.array([5], dtype=np.intp), np.array([5], dtype=np.intp))
    per_ha = np.full(chm.shape, 1000.0, dtype=np.float32)
    rng = np.random.default_rng(1)
    r, c = understorey_cells(chm, allowed, tops, per_ha, rng)
    # 4 blocks of 256 m², 1000 trees/ha -> 25.6 each; one block has a tree already.
    assert len(r) == 26 * 3 + 25
    assert len(set(zip(r.tolist(), c.tolist(), strict=True))) == len(r)


def test_place_trees_respects_map(layers: GroundLayers) -> None:
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 5) for c in range(5, 100, 5)]
    )
    species = np.full(chm.shape, 1, dtype=np.uint8)
    trees = place_trees(chm, layers, species, seed=3)
    rows = trees.row.astype(int)
    cols = trees.col.astype(int)
    ground = layers.ground[rows, cols]
    assert not np.isin(ground, [Ground.WATER, Ground.PATH, Ground.OPEN]).any()
    assert not layers.clear[rows, cols].any()
    # Young trees make the difficult forest (30 x 30 m) denser than plain forest.
    dense = (layers.young[rows, cols] > 0).sum() / 900
    plain_area = (layers.ground == Ground.FOREST) & (layers.young == 0) & ~layers.clear
    plain = (plain_area[rows, cols]).sum() / plain_area.sum()
    # 408 adds 8 young trees per 100 m² on top of the canopy trees.
    assert dense - plain == pytest.approx(0.08, abs=0.03)
    assert set(np.unique(trees.species).tolist()) <= {1, 2, 3}
    assert (trees.crown > 0).all()


def test_place_trees_is_deterministic(layers: GroundLayers) -> None:
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 7) for c in range(5, 100, 7)]
    )
    species = np.full(chm.shape, 2, dtype=np.uint8)
    a = place_trees(chm, layers, species, seed=7)
    b = place_trees(chm, layers, species, seed=7)
    np.testing.assert_array_equal(a.col, b.col)
    np.testing.assert_array_equal(a.species, b.species)


def test_effective_canopy_removes_open_land(layers: GroundLayers) -> None:
    chm = np.full(layers.ground.shape, 10.0, dtype=np.float32)
    canopy = effective_canopy(chm, layers)
    assert canopy[cell(30, 30)] == 0
    assert canopy[cell(50, 45)] == 0
    assert canopy[cell(15, 85)] == 10
