import numpy as np
import pytest
from shapely import LineString

from terraino.ingest.georef import Extent
from terraino.process.boundaries import VegetationBoundaries
from terraino.process.features import collect_features
from terraino.process.layers import TREES_KEEP, GroundLayers
from terraino.process.symbols import SymbolSet
from terraino.process.trees import Trees, understorey_cells

EXTENT = Extent(0, 0, 100, 100)
SHAPE = (100, 100)
# A boundary running east along the middle: north (rows 0-49) is its left side.
LINE = LineString([(0, 50), (100, 50)])


def layers(speed_south: float = 1.0) -> GroundLayers:
    zeros = np.zeros(SHAPE, dtype=np.float32)
    speed = zeros + 1
    speed[50:] = speed_south
    return GroundLayers(
        ground=np.ones(SHAPE, dtype=np.uint8),
        speed=speed,
        young=zeros.copy(),
        thicket=zeros.copy(),
        shrubs=zeros.copy(),
        tree_rule=np.full(SHAPE, TREES_KEEP, dtype=np.uint8),
        clear=zeros > 0,
        in_map=zeros == 0,
    )


def forest(north_m: float, south_m: float) -> Trees:
    """Laser trees every 3 m, all spruce, of one height on each side of the line."""
    rows, cols = np.mgrid[1.5:100:3, 1.5:100:3]
    rows, cols = rows.ravel().astype(np.float32), cols.ravel().astype(np.float32)
    height = np.where(rows < 50, north_m, south_m).astype(np.float32)
    n = len(rows)
    return Trees(
        col=cols,
        row=rows,
        height=height,
        crown=np.full(n, 2.0, np.float32),
        species=np.ones(n, np.uint8),
        laser=np.ones(n, dtype=bool),
    )


def south_of_line(trees: Trees, low: float, high: float) -> np.ndarray:
    """Trees between ``low`` and ``high`` metres south of the line."""
    d = trees.row - 50
    return (d > low) & (d < high)


@pytest.mark.parametrize("key", ["isom2000", "isom2017"])
def test_vegetation_boundaries_are_lines_with_a_tree_free_strip(key: str) -> None:
    symbols = SymbolSet.load(key)
    line = {"type": "LineString", "coordinates": [[0, 0], [30, 0]]}
    found, _ = collect_features(
        [{"geometry": line, "properties": {"oid": 0, "sym": "416.0", "ang": 0}}], symbols
    )
    assert [line.kind for line in found.lines] == ["vegetation_boundary"]
    rule = symbols.rule("416.0")
    assert rule is not None
    assert rule.clear == 2


def test_each_side_fills_its_own_trees_below_the_canopy() -> None:
    chm = np.full((16, 16), 10.0, dtype=np.float32)
    allowed = np.ones((16, 16), dtype=bool)
    # A whole block's worth of laser trees (750 per hectare: 19), all in its north half.
    tops = (np.repeat(np.arange(8), 3)[:19], np.tile([2, 7, 12], 8)[:19])
    tops = (tops[0].astype(np.intp), tops[1].astype(np.intp))
    rng = np.random.default_rng(1)
    rows, _ = understorey_cells(chm, allowed, tops, None, rng)
    assert len(rows) == 0
    parts = np.zeros((16, 16), dtype=np.int32)
    parts[:8], parts[8:] = 1, 2
    rows, _ = understorey_cells(chm, allowed, tops, None, rng, parts=parts)
    assert len(rows) == 10
    assert (rows >= 8).all()


def test_a_slower_side_becomes_a_young_stand() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    trees = forest(20, 20)
    out, report = b.invent_contrast(trees, layers(speed_south=0.6), np.ones(SHAPE, np.uint8))
    assert (report.lacking, report.stretches) == (5, 5)
    assert (report.young, report.lowered) == (1, 0)
    # No tall trees left near the line on the slower south side; young ones instead.
    near = south_of_line(out, 0, 30)
    assert not (out.height[near] > 8).any()
    young = out.height[near]
    assert len(young) > 0.5 * 30 * 100 / 5
    assert young.min() >= 4
    # The north side, and the forest beyond the band, are as they were.
    north = out.row < 50
    assert (out.height[north] == 20).all()
    assert (out.height[south_of_line(out, 50, 100)] == 20).all()
    _, again = b.invent_contrast(out, layers(speed_south=0.6), np.ones(SHAPE, np.uint8))
    assert again.lacking == 0


def test_otherwise_the_lower_side_is_lowered_to_half_its_height() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    out, report = b.invent_contrast(forest(20, 18), layers(), np.ones(SHAPE, np.uint8))
    assert (report.young, report.lowered) == (0, 1)
    assert len(out) == len(forest(20, 18))
    assert out.height[south_of_line(out, 0, 30)] == pytest.approx(9)
    fading = out.height[south_of_line(out, 30, 50)]
    assert (fading > 9).all()
    assert (fading < 18).all()
    assert (out.height[out.row < 50] == 20).all()
    # Now the two sides differ.
    _, again = b.invent_contrast(out, layers(), np.ones(SHAPE, np.uint8))
    assert again.lacking == 0


def test_a_young_stand_where_the_other_side_is_low_forest() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    out, report = b.invent_contrast(forest(9, 8), layers(), np.ones(SHAPE, np.uint8))
    assert (report.young, report.lowered) == (1, 0)


def test_sides_that_differ_are_left_alone() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    trees = forest(20, 12)  # 1.5 times and 5 m higher
    out, report = b.invent_contrast(trees, layers(), np.ones(SHAPE, np.uint8))
    assert report.lacking == 0
    np.testing.assert_array_equal(out.height, trees.height)


def test_a_small_height_difference_is_alike() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    out, report = b.invent_contrast(forest(16, 11), layers(), np.ones(SHAPE, np.uint8))
    assert (report.lacking, report.lowered) == (5, 1)
    # The lower side goes to half its height (and at most half the other side's).
    assert out.height[south_of_line(out, 0, 30)] == pytest.approx(5.5)


def test_sides_with_different_sr16_species_differ() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    species = np.ones(SHAPE, np.uint8)
    species[50:] = 3  # deciduous south of the line
    _, report = b.invent_contrast(forest(20, 20), layers(), species)
    assert report.lacking == 0


def test_the_invented_stand_ends_at_a_path() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    ground = layers()
    ground.clear[74:76] = True  # a path 24-26 m south of the line
    out, _ = b.invent_contrast(forest(20, 18), ground, np.ones(SHAPE, np.uint8))
    assert out.height[south_of_line(out, 0, 23)] == pytest.approx(9)
    assert (out.height[south_of_line(out, 27, 100)] == 18).all()


def test_a_path_along_the_boundary_does_not_end_the_stand() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    ground = layers()
    ground.clear[53:55] = True  # a path 3-5 m south of the line
    out, _ = b.invent_contrast(forest(20, 18), ground, np.ones(SHAPE, np.uint8))
    assert out.height[south_of_line(out, 6, 30)] == pytest.approx(9)


def test_the_other_side_changes_when_the_lower_one_is_cut_off() -> None:
    b = VegetationBoundaries.find([LINE], EXTENT, SHAPE)
    ground = layers()
    ground.clear[59:61] = True  # a path 9-11 m south of the line
    out, report = b.invent_contrast(forest(20, 18), ground, np.ones(SHAPE, np.uint8))
    assert report.lowered == 1
    assert (out.height[out.row > 50] == 18).all()
    # The north side goes to half the south side's height.
    north = (out.row < 50) & (out.row > 20)
    assert out.height[north] == pytest.approx(9)


def test_pieces_of_a_boundary_are_judged_together() -> None:
    pieces = [LineString([(0, 50), (45, 50)]), LineString([(100, 50), (55, 50)])]
    b = VegetationBoundaries.find(pieces, EXTENT, SHAPE)
    assert len(b.lines) == 1
    _, report = b.invent_contrast(forest(20, 18), layers(), np.ones(SHAPE, np.uint8))
    assert (report.stretches, report.lowered) == (5, 1)
