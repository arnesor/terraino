from typing import Any

import numpy as np
import numpy.typing as npt
import pytest
from shapely import Point, Polygon, box
from shapely.geometry import mapping

from terraino.ingest.georef import Extent
from terraino.process.fuse import fill_unknown_ground
from terraino.process.layers import (
    TREES_KEEP,
    TREES_LIDAR,
    TREES_NONE,
    TREES_SCATTERED,
    GroundLayers,
    rasterize_map,
)
from terraino.process.symbols import Ground, SymbolSet
from terraino.process.trees import (
    BIRCH_BEYOND_FOREST_M,
    FOREST_DISTANCE_STEP,
    MIN_TREE_HEIGHT_M,
    SCATTERED_SPACING_M,
    Trees,
    canopy_height,
    effective_canopy,
    find_tree_tops,
    low_vegetation,
    place_trees,
    scattered_stumps,
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
    # Paths are drawn as strips by the viewer; the ground below keeps its class.
    assert layers.ground[cell(50, 45)] == Ground.FOREST
    assert layers.speed[cell(50, 45)] == pytest.approx(1.15)
    assert layers.ground[cell(65, 65)] == Ground.MARSH


def test_overprinting_marsh_keeps_vegetation(layers: GroundLayers) -> None:
    assert layers.young[cell(65, 65)] == pytest.approx(8)
    # Marsh is faster than the green below it, so the green's speed counts.
    assert layers.speed[cell(65, 65)] == pytest.approx(0.5)
    assert layers.speed[cell(55, 55)] == pytest.approx(0.5)


def speed_of(number: str) -> float:
    rule = ISOM.rule(number)
    assert rule is not None
    assert rule.speed is not None
    return rule.speed


def test_slowest_speed_group_counts() -> None:
    features = [
        area(0, "406.0", box(20, 20, 40, 40)),  # slow running
        area(1, "311.0", box(30, 30, 40, 40)),  # indistinct marsh on top
        area(2, "403.0", box(50, 20, 80, 40)),  # rough open land
        area(3, "407.0", box(50, 20, 70, 40)),  # undergrowth on it
        area(4, "310.0", box(60, 20, 80, 40)),  # marsh on both
        area(5, "407.0", box(20, 50, 40, 80)),  # undergrowth in white forest
        area(6, "409.0", box(30, 50, 40, 80)),  # denser undergrowth on top
        area(7, "310.0", box(50, 50, 80, 80)),  # marsh
        line(8, "506.0", [(50.0, 65.0), (80.0, 65.0)]),  # a path across it
    ]
    layers = rasterize_map(features, ISOM, EXTENT, MAP_AREA)
    assert layers.speed[cell(35, 35)] == pytest.approx(
        min(speed_of("406"), speed_of("311"))
    )
    assert layers.speed[cell(55, 30)] == pytest.approx(
        min(speed_of("403"), speed_of("407"))
    )
    assert layers.speed[cell(65, 30)] == pytest.approx(
        min(speed_of("403"), speed_of("407"), speed_of("310"))
    )
    assert layers.speed[cell(75, 30)] == pytest.approx(
        min(speed_of("403"), speed_of("310"))
    )
    # Within a group the topmost symbol counts.
    assert layers.speed[cell(35, 65)] == pytest.approx(speed_of("409"))
    # Other symbols replace what is below them, marsh included.
    assert layers.speed[cell(65, 65)] == pytest.approx(speed_of("506"))
    assert layers.speed[cell(65, 75)] == pytest.approx(speed_of("310"))


@pytest.mark.parametrize(("key", "number"), [("isom2000", "415"), ("isom2017", "412")])
def test_cultivated_land_is_grain_with_a_grass_verge(key: str, number: str) -> None:
    symbols = SymbolSet.load(key)
    features = [
        area(0, number, box(20, 20, 80, 80)),
        line(1, "505.0", [(20.0, 50.0), (80.0, 50.0)]),  # a path across the field
    ]
    layers = rasterize_map(features, symbols, EXTENT, MAP_AREA)
    rule = symbols.rule(number)
    assert rule is not None
    assert layers.ground[cell(40, 30)] == Ground.GRAIN
    assert layers.speed[cell(40, 30)] == pytest.approx(rule.speed)
    for verge in [(20.5, 30), (79.5, 30), (40, 20.5), (40, 52.5), (40, 47.5)]:
        assert layers.ground[cell(*verge)] == Ground.FIELD, verge
        assert layers.speed[cell(*verge)] == pytest.approx(rule.as_grass().speed)
    assert layers.tree_rule[cell(40, 30)] == layers.tree_rule[cell(20.5, 30)]


def test_a_share_of_the_fields_grow_grass() -> None:
    symbols = SymbolSet.load("isom2017")
    rule = symbols.rule("412")
    assert rule is not None
    assert rule.grass_share == pytest.approx(0.1)
    fields = [area(k, "412", box(10 + 4 * k, 20, 13 + 4 * k, 80)) for k in range(20)]
    layers = rasterize_map(fields, symbols, EXTENT, MAP_AREA)
    middles = [layers.ground[cell(11.5 + 4 * k, 50)] for k in range(20)]
    # Narrow fields have no room for grain inside their verge: all FIELD.
    assert set(middles) == {Ground.FIELD}
    wide = [area(k, "412", box(10, 10 + 8 * k, 90, 17 + 8 * k)) for k in range(10)]
    layers = rasterize_map(wide, symbols, EXTENT, MAP_AREA)
    middles = [layers.ground[cell(50, 13.5 + 8 * k)] for k in range(10)]
    assert middles.count(Ground.FIELD) == 1
    assert middles.count(Ground.GRAIN) == 9


def test_a_field_drawn_in_pieces_has_no_verge_between_them() -> None:
    symbols = SymbolSet.load("isom2000")
    pieces = [area(0, "415", box(20, 20, 52, 80)), area(1, "415", box(48, 20, 80, 80))]
    layers = rasterize_map(pieces, symbols, EXTENT, MAP_AREA)
    assert all(layers.ground[cell(x, 50)] == Ground.GRAIN for x in range(25, 76))


def test_cultivation_boundaries_split_fields_with_a_narrow_verge() -> None:
    symbols = SymbolSet.load("isom2000")
    land = area(0, "415", box(20, 20, 80, 80))
    boundary = line(1, "414.0", [(50.0, 20.0), (50.0, 80.0)])
    layers = rasterize_map([land, boundary], symbols, EXTENT, MAP_AREA)
    assert layers.ground[cell(50.5, 50)] == Ground.FIELD
    assert layers.ground[cell(48, 50)] == Ground.GRAIN
    assert layers.ground[cell(53, 50)] == Ground.GRAIN


def test_holes_left_for_lettering_are_filled() -> None:
    symbols = SymbolSet.load("isom2017")
    # A field with a rectangular hole for a name, one without a name beside it, and
    # an irregular hole (a real island of other ground) with a name in it.
    island = Point(70, 30).buffer(6)
    field = (
        box(15, 15, 85, 85)
        .difference(box(25, 60, 55, 75))
        .difference(box(25, 25, 45, 40))
        .difference(island)
    )
    feature = {
        "geometry": mapping(field),
        "properties": {"oid": 0, "sym": "412"},
    }
    lettering = [Point(22, 77).buffer(8), Point(70, 30).buffer(8)]
    layers = rasterize_map([feature], symbols, EXTENT, MAP_AREA, lettering)
    assert layers.ground[cell(40, 67)] == Ground.GRAIN
    assert layers.ground[cell(35, 32)] == Ground.FOREST
    assert layers.ground[cell(70, 30)] == Ground.FOREST
    without = rasterize_map([feature], symbols, EXTENT, MAP_AREA)
    assert without.ground[cell(40, 67)] == Ground.FOREST


def test_lettering_hole_overlapping_another_hole_is_filled() -> None:
    # The hole for the name overlaps the hole of a yard: the polygon as drawn is
    # invalid, and repairing it would merge the two holes into one with many corners.
    yard = [list(c) for c in Point(60, 67).buffer(6).exterior.coords]
    text = [[25, 60], [25, 75], [56, 75], [56, 60], [25, 60]]
    square = [[15, 15], [85, 15], [85, 85], [15, 85], [15, 15]]
    feature = {
        "geometry": {"type": "Polygon", "coordinates": [square, text, yard]},
        "properties": {"oid": 0, "sym": "412"},
    }
    symbols = SymbolSet.load("isom2017")
    layers = rasterize_map(
        [feature], symbols, EXTENT, MAP_AREA, [Point(22, 77).buffer(8)]
    )
    assert layers.ground[cell(40, 67)] == Ground.GRAIN
    assert layers.ground[cell(61, 67)] == Ground.FOREST


def test_tree_rules_and_clear_strips(layers: GroundLayers) -> None:
    assert layers.tree_rule[cell(30, 30)] == TREES_LIDAR
    assert layers.tree_rule[cell(25, 65)] == TREES_NONE
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
    assert not np.isin(ground, [Ground.WATER, Ground.PATH]).any()
    # On open land only the laser's tree tops stand (18 m cones), nothing is added.
    on_open = ground == Ground.OPEN
    assert on_open.any()
    assert (trees.height[on_open] > 15).all()
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


def test_trees_far_from_sr16_forest_are_birch(layers: GroundLayers) -> None:
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 5) for c in range(5, 100, 5)]
    )
    species = np.zeros(chm.shape, dtype=np.uint8)
    species[:, :12] = 1  # SR16 spruce forest along the west edge only
    trees = place_trees(chm, layers, species, seed=3)
    far = trees.col > 12 + BIRCH_BEYOND_FOREST_M + FOREST_DISTANCE_STEP
    near = trees.col < 12
    marsh = layers.ground[trees.row.astype(int), trees.col.astype(int)] == Ground.MARSH
    assert (far & ~marsh).any()
    assert (trees.species[far & ~marsh] == 3).all()
    assert (trees.species[near] == 1).any()


def test_trees_on_open_land_outside_sr16_forest_are_birch(layers: GroundLayers) -> None:
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 3) for c in range(5, 100, 3)]
    )
    species = np.zeros(chm.shape, dtype=np.uint8)
    species[:, :12] = 1  # SR16 spruce forest along the west edge only
    trees = place_trees(chm, layers, species, seed=3)
    ground = layers.ground[trees.row.astype(int), trees.col.astype(int)]
    # Within 50 m of SR16 forest: birch on open land, the usual mix in mapped forest.
    near = (trees.col > 13) & (trees.col < 12 + BIRCH_BEYOND_FOREST_M - 4)
    on_open = near & (ground == Ground.OPEN)
    in_forest = near & (ground == Ground.FOREST)
    assert on_open.sum() > 10
    assert (trees.species[on_open] == 3).all()
    assert (trees.species[in_forest] != 3).any()


def test_trees_on_marsh_far_from_sr16_forest_lean_to_pine() -> None:
    layers = rasterize_map(
        [area(0, "310.0", box(60, 20, 90, 80))], ISOM, EXTENT, MAP_AREA
    )
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 4) for c in range(5, 100, 4)]
    )
    species = np.zeros(chm.shape, dtype=np.uint8)
    species[:, :12] = 1  # SR16 spruce forest along the west edge only
    trees = place_trees(chm, layers, species, seed=3)
    far = trees.col > 12 + BIRCH_BEYOND_FOREST_M + FOREST_DISTANCE_STEP
    marsh = layers.ground[trees.row.astype(int), trees.col.astype(int)] == Ground.MARSH
    on_bog = trees.species[far & marsh]
    assert len(on_bog) > 20
    assert np.bincount(on_bog, minlength=4).argmax() == 2  # pine, not all birch


def test_without_sr16_trees_keep_their_mix(layers: GroundLayers) -> None:
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 5) for c in range(5, 100, 5)]
    )
    species = np.zeros(chm.shape, dtype=np.uint8)  # no SR16 data at all
    trees = place_trees(chm, layers, species, seed=3)
    assert (trees.species != 3).any()


def test_effective_canopy_keeps_lidar_trees(layers: GroundLayers) -> None:
    chm = np.full(layers.ground.shape, 10.0, dtype=np.float32)
    canopy = effective_canopy(chm, layers)
    assert canopy[cell(25, 65)] == 0  # lake
    assert canopy[cell(30, 30)] == 10  # open land keeps the trees the laser found
    assert canopy[cell(50, 45)] == 0
    assert canopy[cell(15, 85)] == 10


def test_low_vegetation_ignores_even_crops() -> None:
    chm = np.zeros((40, 40), dtype=np.float32)
    chm[:, :20] = 0.9  # grain
    chm[30, 30] = 1.5  # a bush in a mown field
    chm[10, 10] = 2.0  # a bush in the grain
    found = low_vegetation(chm)
    assert found[30, 30]
    assert found[10, 10]
    assert not found[5:15, 2:8].any()


def test_undergrowth_overprint_keeps_rough_open_land() -> None:
    features = [
        area(0, "403.0", box(20, 20, 60, 60)),  # rough open land, no trees
        area(1, "407.0", box(30, 30, 50, 50)),  # undergrowth pattern on top
        area(2, "407.0", box(70, 70, 85, 85)),  # undergrowth in white forest
    ]
    layers = rasterize_map(features, ISOM, EXTENT, MAP_AREA)
    assert layers.ground[cell(40, 40)] == Ground.ROUGH
    assert layers.tree_rule[cell(40, 40)] == TREES_NONE
    assert layers.shrubs[cell(40, 40)] == pytest.approx(0.45)
    assert layers.speed[cell(40, 40)] == pytest.approx(0.7)
    assert layers.ground[cell(78, 78)] == Ground.FOREST
    assert layers.shrubs[cell(78, 78)] == pytest.approx(0.45)


def test_scattered_trees_are_few_and_far_apart() -> None:
    # Rough open land with scattered trees over a dense forest in the laser data.
    layers = rasterize_map(
        [area(0, "404.0", box(20, 20, 80, 80))], ISOM, EXTENT, MAP_AREA
    )
    chm = cone_forest(
        [
            (r, c, 12.0 + (r * 7 + c * 3) % 9)
            for r in range(5, 100, 4)
            for c in range(5, 100, 4)
        ]
    )
    species = np.full(chm.shape, 2, dtype=np.uint8)
    trees = place_trees(chm, layers, species, seed=1)
    inside = (
        layers.tree_rule[trees.row.astype(int), trees.col.astype(int)]
        == TREES_SCATTERED
    )
    x, y, h = trees.col[inside], trees.row[inside], trees.height[inside]
    assert (
        0 < len(x) <= 50
    )  # 0.36 ha: at most one tree per 72 m², far fewer than laser tops
    gaps = (
        np.hypot(x[:, None] - x[None, :], y[:, None] - y[None, :]) + np.eye(len(x)) * 99
    )
    assert gaps.min() > SCATTERED_SPACING_M - 1  # jitter moves trees up to 0.64 m
    # The tallest trees are the ones left standing.
    assert np.median(h) > 16
    # The trees left standing grew up in a stand; the others were cut, leaving stumps.
    assert trees.stand_grown is not None
    assert trees.stand_grown[inside].all()
    assert not trees.stand_grown[~inside].any()
    stump_rows, stump_cols, stump_heights = scattered_stumps(chm, layers)
    assert (stump_heights >= MIN_TREE_HEIGHT_M).all()
    assert len(stump_rows) > len(x) * 3
    cells = stump_rows.astype(int), stump_cols.astype(int)
    assert (layers.tree_rule[cells] == TREES_SCATTERED).all()
    # Forest outside the area keeps all its trees.
    outside = (
        layers.tree_rule[trees.row.astype(int), trees.col.astype(int)] == TREES_KEEP
    )
    assert outside.sum() > len(x) * 5


def test_narrow_rough_open_land_keeps_laser_trees() -> None:
    features = [
        area(0, "403.0", box(20, 20, 80, 24)),  # a 4 m verge along a road
        area(1, "403.0", box(20, 40, 60, 80)),  # a large clearing
    ]
    layers = rasterize_map(features, ISOM, EXTENT, MAP_AREA)
    assert layers.tree_rule[cell(50, 22)] == TREES_LIDAR
    assert layers.tree_rule[cell(40, 60)] == TREES_NONE
    assert layers.ground[cell(50, 22)] == Ground.ROUGH


EYE_M = 1.7


def half_blocked_distance(
    trees: Trees, centre: float, rng: np.random.Generator
) -> float:
    """Median distance at which a sightline at eye height hits a thicket or young tree.

    A thicket blocks the view across its crown. A young tree is a cone with branches to
    the ground, whose foliage blocks about half of the view across it at eye height.
    """
    assert trees.thicket is not None
    radius = np.where(
        trees.thicket,
        trees.crown,
        0.5 * trees.crown * np.clip(1 - EYE_M / trees.height, 0, None),
    )
    keep = radius > 0
    x, y, r = trees.col[keep], trees.row[keep], radius[keep]
    n = 2000
    ox, oy = rng.uniform(centre - 50, centre + 50, (2, n))
    angle = rng.uniform(0, 2 * np.pi, n)
    dx, dy = np.cos(angle), np.sin(angle)
    # Distance along each ray to the nearest disc it passes through.
    px, py = x[None, :] - ox[:, None], y[None, :] - oy[:, None]
    along = px * dx[:, None] + py * dy[:, None]
    across2 = px**2 + py**2 - along**2
    hit = (along > 0) & (across2 < r**2)
    dist = np.where(hit, along - np.sqrt(np.clip(r**2 - across2, 0, None)), np.inf)
    return float(np.median(np.clip(dist.min(axis=1), 0, None)))


@pytest.mark.parametrize("symbols", ["isom2000", "isom2017"])
@pytest.mark.parametrize(
    ("symbol", "visibility"), [("406", 20), ("408", 10), ("410", 5), ("411", 5)]
)
def test_thickets_block_the_view_in_green_areas(
    symbols: str, symbol: str, visibility: float
) -> None:
    size = 260
    extent = Extent(0, 0, size, size)
    whole = box(0, 0, size, size)
    green = rasterize_map(
        [area(0, f"{symbol}.0", whole)], SymbolSet.load(symbols), extent, whole
    )
    chm = np.zeros(extent.raster_shape(1), dtype=np.float32)
    species = np.full(chm.shape, 1, dtype=np.uint8)
    trees = place_trees(chm, green, species, seed=5)
    assert trees.thicket is not None
    thickets = trees.thicket
    assert thickets.any()
    assert (trees.height[thickets] >= 3).all()
    assert (trees.height[thickets] <= 5).all()
    assert (2 * trees.crown[thickets] >= 2.5).all()
    assert (2 * trees.crown[thickets] <= 4).all()
    seen = half_blocked_distance(trees, size / 2, np.random.default_rng(1))
    assert seen == pytest.approx(visibility, rel=0.25)


def test_open_forest_has_no_thickets(layers: GroundLayers) -> None:
    chm = np.zeros(layers.ground.shape, dtype=np.float32)
    species = np.full(chm.shape, 3, dtype=np.uint8)
    trees = place_trees(chm, layers, species, seed=2)
    assert trees.thicket is not None
    rows, cols = trees.row.astype(int), trees.col.astype(int)
    # Only the difficult forest (408) has thickets; pine thickets grow as spruce.
    assert (layers.thicket[rows, cols][trees.thicket] > 0).all()
    assert trees.thicket.any()
    assert set(trees.species[trees.thicket].tolist()) <= {1, 3}


def test_thickets_leave_the_trees_as_they_were(layers: GroundLayers) -> None:
    chm = cone_forest(
        [(r, c, 18.0) for r in range(5, 100, 7) for c in range(5, 100, 7)]
    )
    species = np.full(chm.shape, 1, dtype=np.uint8)
    trees = place_trees(chm, layers, species, seed=4)
    layers.thicket[:] = 0
    plain = place_trees(chm, layers, species, seed=4)
    assert trees.thicket is not None
    assert trees.thicket.any()
    assert plain.thicket is not None
    assert not plain.thicket.any()
    np.testing.assert_array_equal(trees.col[~trees.thicket], plain.col)
    np.testing.assert_array_equal(trees.species[~trees.thicket], plain.species)
