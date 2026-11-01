import math
from typing import Any

import numpy as np
import pytest
from shapely import Point, Polygon, box

from terraino.ingest.georef import Extent
from terraino.process.features import (
    CLIFF_FACE_M,
    CLIFF_TAPER_M,
    LineFeature,
    carve_cliffs,
    carve_pits,
    collect_features,
    contour_rings,
    dig_small_depressions,
    drop_rocks_in_buildings,
    drop_ruins_in_buildings,
    measure_cliffs,
    paint_cliffs,
    place_poles,
    raise_earth_walls,
    raise_knolls,
    stand_lamp_posts,
)
from terraino.process.layers import GroundLayers
from terraino.process.symbols import Ground, SymbolSet
from terraino.process.tracks import Track

EXTENT = Extent(0, 0, 100, 100)
ISOM = SymbolSet.load("isom2000")


def feature(
    oid: int, sym: str, geometry: dict[str, Any], ang: float = 0
) -> dict[str, Any]:
    return {"geometry": geometry, "properties": {"oid": oid, "sym": sym, "ang": ang}}


def point(x: float, y: float) -> dict[str, Any]:
    return {"type": "Point", "coordinates": [x, y]}


def line(*coords: tuple[float, float]) -> dict[str, Any]:
    return {"type": "LineString", "coordinates": [list(c) for c in coords]}


def test_points_expand_into_rocks() -> None:
    features, cliffs = collect_features(
        [
            feature(0, "206.0", point(10, 10)),  # boulder
            feature(1, "209.0", point(30, 30)),  # boulder cluster
            feature(2, "210.0", point(50, 50)),  # stony ground
            feature(3, "536.0", point(70, 70), ang=45),  # small tower
            feature(4, "101.0", line((0, 0), (5, 5))),  # contour: no feature
        ],
        ISOM,
    )
    kinds = [p.kind for p in features.points]
    assert kinds.count("boulder") == 1 + 4
    assert kinds.count("stone") == 5
    (tower,) = [p for p in features.points if p.kind == "tower"]
    assert tower.size == 4
    assert tower.angle == pytest.approx(math.pi / 4)
    assert cliffs == []
    # Clustered rocks stay near their map symbol.
    for p in features.points:
        if p.kind == "stone":
            assert math.hypot(p.x - 50, p.y - 50) <= 2.0


def test_boulder_field_area_is_filled() -> None:
    poly = box(0, 0, 30, 30)
    geometry = {"type": "Polygon", "coordinates": [list(poly.exterior.coords)]}
    features, _ = collect_features([feature(0, "208.0", geometry)], ISOM)
    assert len(features.points) == round(900 / 18)
    assert all(0 <= p.x <= 30 and 0 <= p.y <= 30 for p in features.points)


def test_lines_are_densified() -> None:
    features, _ = collect_features([feature(0, "522.0", line((0, 0), (20, 0)))], ISOM)
    (fence,) = features.lines
    assert fence.kind == "fence"
    assert len(fence.coords) == 11


def test_cliff_falls_to_lower_side() -> None:
    # Terrain: 110 m north of y = 50, 100 m south of it; a cliff drawn along y = 50.
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    dtm[:50, :] = 110.0  # rows 0..49 are the northern half
    _, cliff_lines = collect_features(
        [feature(0, "201.0", line((20, 50.5), (80, 50.5)))], ISOM
    )
    (face,) = measure_cliffs(cliff_lines, dtm, EXTENT)
    for (tx, ty, th), (bx, by, bh) in zip(face.top, face.bottom, strict=True):
        assert by == pytest.approx(ty - CLIFF_FACE_M)  # the face falls to the south
        assert bx == pytest.approx(tx)
        if CLIFF_TAPER_M <= tx - 20 <= 60 - CLIFF_TAPER_M:
            assert th - bh > 9
    # The drop tapers off at the ends of the line.
    assert face.top[0][2] - face.bottom[0][2] < 5


def test_low_terrain_still_gets_a_cliff() -> None:
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    _, cliff_lines = collect_features(
        [feature(0, "203.0", line((20, 50), (80, 50)))], ISOM
    )
    (face,) = measure_cliffs(cliff_lines, dtm, EXTENT)
    drops = [t[2] - b[2] for t, b in zip(face.top, face.bottom, strict=True)]
    # A rock face is at least 1 m high, less only where it tapers off at its ends.
    assert min(drops[2:-2]) >= 1.0
    assert 0 < drops[0] < 1.0


def test_carve_cliffs_makes_a_step() -> None:
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    dtm[50:, :] = 99.9  # the south side is a little lower
    _, cliff_lines = collect_features(
        [feature(0, "203.0", line((20, 50), (80, 50)))], ISOM
    )
    faces = measure_cliffs(cliff_lines, dtm, EXTENT)
    carve_cliffs(dtm, faces, EXTENT)
    # Half a metre behind the line, and 1.5 m in front of it: the foot of the face.
    above = dtm[int(EXTENT.y1 - 50.5), 50]
    below = dtm[int(EXTENT.y1 - 48.5), 50]
    assert above == pytest.approx(100.0)
    assert above - below >= 1.0
    assert dtm[int(EXTENT.y1 - 40), 50] == pytest.approx(99.9)  # untouched farther out
    assert dtm[int(EXTENT.y1 - 50.5), 5] == pytest.approx(100.0)  # beyond the end


def test_paint_cliffs() -> None:
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    dtm[:50, :] = 110.0
    _, cliff_lines = collect_features(
        [feature(0, "201.0", line((20, 50.2), (80, 50.2)))], ISOM
    )
    faces = measure_cliffs(cliff_lines, dtm, EXTENT)
    shape = EXTENT.raster_shape(1)
    zeros = np.zeros(shape, dtype=np.float32)
    layers = GroundLayers(
        ground=np.ones(shape, dtype=np.uint8),
        speed=zeros + 1,
        young=zeros,
        thicket=zeros,
        shrubs=zeros,
        tree_rule=np.zeros(shape, dtype=np.uint8),
        clear=zeros > 0,
        in_map=zeros == 0,
    )
    paint_cliffs(layers, faces, EXTENT)
    row, col = int(EXTENT.y1 - 49.5), 50  # under the face, just below the line
    assert layers.ground[row, col] == Ground.ROCK
    assert layers.speed[int(EXTENT.y1 - 50.5), col] == 0
    assert layers.speed[row, col] == 0
    assert layers.speed[int(EXTENT.y1 - 60), col] == 1


def test_poles_on_registered_masts() -> None:
    line = LineFeature("power_line", [(0.0, 0.0), (400.0, 0.0)], 10.0)
    fence = LineFeature("fence", [(0.0, 5.0), (100.0, 5.0)], 1.0)
    masts = [(10.0, 0.3), (75.0, -0.4), (310.0, 0.2), (150.0, 30.0)]
    power, other = place_poles([line, fence], masts)
    xs = [round(x) for x, _ in power.poles]
    # Its own masts (not the one 30 m off it), three poles evenly in the 235 m gap,
    # and an end pole 90 m past the last mast.
    assert xs == [10, 75, 134, 192, 251, 310, 400]
    assert other.poles == ()


@pytest.mark.parametrize(
    ("key", "boulder", "large", "cluster", "waterhole"),
    [
        ("isom2000", "206", "207", "209", "303"),
        ("isom2017", "204", "205", "207", "303"),
    ],
)
def test_boulders_are_high_enough_and_waterholes_hold_water(
    key: str, boulder: str, large: str, cluster: str, waterhole: str
) -> None:
    symbols = SymbolSet.load(key)
    found, _ = collect_features(
        [
            feature(i, f"{sym}.0", point(10 + 10 * i, 50))
            for i, sym in enumerate([boulder, large, cluster, waterhole])
        ],
        symbols,
    )
    by_kind: dict[str, list[float]] = {}
    for p in found.points:
        by_kind.setdefault(p.kind, []).append(p.size)
    boulders = sorted(by_kind["boulder"])
    assert len(boulders) == 1 + 1 + 4  # the cluster has several
    assert min(boulders) >= 1.0
    assert max(boulders) >= 2.0  # the large boulder
    assert by_kind["waterhole"] == [4.0]


@pytest.mark.parametrize(
    ("key", "pit", "knoll"),
    [("isom2000", "116", "112"), ("isom2017", "112", "109")],  # 2000: 112 small knoll
)
def test_pits_are_dug_with_steep_sides_and_no_trees(
    key: str, pit: str, knoll: str
) -> None:
    found, _ = collect_features(
        [
            feature(0, f"{pit}.0", point(50.3, 50.6)),
            feature(1, f"{knoll}.0", point(20, 20)),
        ],
        SymbolSet.load(key),
    )
    assert [(p.kind, p.size) for p in found.points] == [("pit", 2.0), ("knoll", 10.0)]
    dtm = slope()
    before = dtm.copy()
    shape = dtm.shape
    zeros = np.zeros(shape, dtype=np.float32)
    layers = GroundLayers(
        ground=np.ones(shape, dtype=np.uint8),
        speed=zeros + 1,
        young=zeros,
        thicket=zeros,
        shrubs=zeros,
        tree_rule=np.ones(shape, dtype=np.uint8),
        clear=zeros > 0,
        in_map=zeros == 0,
    )
    carve_pits(dtm, layers, found.points, EXTENT)

    rows, cols = np.mgrid[0 : shape[0], 0 : shape[1]]
    d = np.hypot(cols + 0.5 - 50.3, EXTENT.y1 - rows - 0.5 - 50.6)
    inside = d < 1.0
    assert inside.any()
    rim = (d >= 1.0) & (d <= 2.0)
    # At least 1 m below every point of the rim, downhill too; 2 m wide.
    assert dtm[inside].max() <= dtm[rim].min() - 1.0 + 1e-4
    np.testing.assert_array_equal(dtm[~inside], before[~inside])
    # No trees in it or on its edge, and the rest of the forest untouched.
    assert layers.clear[d < 1.5].all()
    assert not layers.clear[d > 2.0].any()


def slope() -> np.ndarray:
    """Ground sloping down to the east, 0.2 m per metre."""
    shape = EXTENT.raster_shape(1)
    dtm = np.tile(100.0 - 0.2 * (np.arange(shape[1]) + 0.5), (shape[0], 1))
    return dtm.astype(np.float32)


def offsets(x: float, y: float) -> tuple[np.ndarray, np.ndarray]:
    """How far east and north of (x, y) each cell's centre is."""
    rows, cols = np.mgrid[0 : EXTENT.raster_shape(1)[0], 0 : EXTENT.raster_shape(1)[1]]
    return cols + 0.5 - x, EXTENT.y1 - rows - 0.5 - y


@pytest.mark.parametrize(
    ("key", "knoll", "elongated"),
    [("isom2000", "112", "113"), ("isom2017", "109", "110")],
)
def test_knolls_stand_1_m_above_the_slope(key: str, knoll: str, elongated: str) -> None:
    found, _ = collect_features(
        [
            feature(0, f"{elongated}.0", point(50.5, 50.5), ang=0),
            feature(1, f"{knoll}.0", point(20.5, 20.5)),
            feature(2, f"{knoll}.0", point(80.5, 80.5)),
        ],
        SymbolSet.load(key),
    )
    assert [(p.kind, p.size) for p in found.points] == [
        ("elongated_knoll", 8.0),
        ("knoll", 10.0),
        ("knoll", 10.0),
    ]
    dtm = slope()
    # The terrain model already shows the last knoll, 2 m high.
    east, north = offsets(80.5, 80.5)
    d = np.hypot(east, north)
    dtm += np.where(d < 5, 1 + np.cos(np.pi * d / 5), 0).astype(np.float32)
    before = dtm.copy()

    assert raise_knolls(dtm, found.points, [], EXTENT) == (2, 0)
    rise = dtm - before
    # On the slope, 1 m above the ground around it, not above its downhill side.
    assert rise[int(EXTENT.y1 - 50.5), 50] == pytest.approx(1.0, abs=0.01)
    assert rise[int(EXTENT.y1 - 20.5), 20] == pytest.approx(1.0, abs=0.01)
    # The symbol's angle 0 is across the elongated knoll: it runs north-south, 16 x 8 m.
    east, north = offsets(50.5, 50.5)
    raised = rise > 0.01
    assert raised[(abs(east) < 0.5) & (abs(north) < 7)].all()
    assert not raised[(abs(north) < 0.5) & (abs(east) > 4)].any()
    # A round knoll, 10 m across; the one the terrain model shows is left as it is.
    east, north = offsets(20.5, 20.5)
    assert not raised[(np.hypot(east, north) > 5) & (np.hypot(east, north) < 20)].any()
    east, north = offsets(80.5, 80.5)
    near = np.hypot(east, north) < 10
    np.testing.assert_array_equal(dtm[near], before[near])


@pytest.mark.parametrize(
    ("key", "depression"), [("isom2000", "115"), ("isom2017", "111")]
)
def test_small_depressions_are_1_m_deep_with_gentle_sides(
    key: str, depression: str
) -> None:
    found, _ = collect_features(
        [
            feature(0, f"{depression}.0", point(50.5, 50.5), ang=1.0),
            feature(1, f"{depression}.0", point(80.5, 80.5)),
        ],
        SymbolSet.load(key),
    )
    assert [(p.kind, p.size) for p in found.points] == [
        ("small_depression", 8.0),
        ("small_depression", 8.0),
    ]
    dtm = slope()
    # The terrain model already shows the second one, 2 m deep.
    east, north = offsets(80.5, 80.5)
    d = np.hypot(east, north)
    dtm -= np.where(d < 4, 1 + np.cos(np.pi * d / 4), 0).astype(np.float32)
    before = dtm.copy()

    assert dig_small_depressions(dtm, found.points, EXTENT) == 1
    drop = before - dtm
    # On the slope, 1 m below the ground around it, not below its downhill side.
    assert drop[int(EXTENT.y1 - 50.5), 50] == pytest.approx(1.0, abs=0.01)
    # Round and 8 m across, whatever the symbol's angle; the ground is never raised.
    east, north = offsets(50.5, 50.5)
    d = np.hypot(east, north)
    lowered = drop > 0.01
    assert lowered[d < 3.5].all()
    assert not lowered[d > 4].any()
    assert drop.min() >= 0
    # No steep sides: its walls are under 25 degrees steeper than the slope around it.
    hollow = drop[40:61, 40:61]
    steepest = max(
        np.abs(np.diff(hollow, axis=0)).max(), np.abs(np.diff(hollow, axis=1)).max()
    )
    assert steepest < math.tan(math.radians(25))
    # The one the terrain model shows deep enough is left as it is.
    east, north = offsets(80.5, 80.5)
    near = np.hypot(east, north) < 10
    np.testing.assert_array_equal(dtm[near], before[near])


@pytest.mark.parametrize(
    ("key", "wall", "small", "other"),
    [("isom2000", "107.1", "108.1", "106.0"), ("isom2017", "105.1", "106.0", "105.2")],
)
def test_earth_walls_stand_their_height_above_the_slope(
    key: str, wall: str, small: str, other: str
) -> None:
    found, _ = collect_features(
        [
            feature(0, wall, line((20, 30.5), (80, 30.5))),  # down the slope
            feature(1, small, line((50.5, 50), (50.5, 90))),  # across the slope
            feature(2, other, line((10, 70), (40, 70))),  # earth bank or retaining wall
        ],
        SymbolSet.load(key),
    )
    assert [(w.kind, w.size) for w in found.lines] == [
        ("earth_wall", 1.0),
        ("earth_wall", 0.5),
    ]
    dtm = slope()
    before = dtm.copy()

    assert raise_earth_walls(dtm, found.lines, EXTENT) == 2
    rise = dtm - before
    # Its size above the line between both sides: on the slope, above the middle.
    assert rise[int(EXTENT.y1 - 30.5), 50] == pytest.approx(1.0, abs=0.03)
    assert rise[int(EXTENT.y1 - 70.5), 50] == pytest.approx(0.5, abs=0.03)
    # 4 m wide, with rounded ends.
    east, north = offsets(50.0, 30.5)
    raised = rise > 0.01
    assert raised[(abs(north) < 1.5) & (abs(east) < 25)].all()
    assert not raised[(abs(north) > 2) & (abs(north) < 10) & (abs(east) < 25)].any()
    east, north = offsets(80.0, 30.5)
    assert raised[np.hypot(east, north) < 1.5].all()
    assert not raised[(east > 2) & (abs(north) < 3)].any()
    assert rise.min() >= 0


def test_lamp_posts_stand_beside_the_trail_they_light() -> None:
    found, _ = collect_features(
        [
            feature(0, "541.1", point(30, 56)),  # 6 m north of the path
            feature(1, "541.1", point(70, 44)),  # 6 m south of it
            feature(2, "541.0", point(50, 80)),  # another ring symbol
        ],
        ISOM,
    )
    assert [(p.kind, p.size) for p in found.points] == [
        ("lamp_post", 6.0),
        ("lamp_post", 6.0),
    ]
    tracks = [
        Track("stream", 1.0, [(0, 53), (100, 53)]),  # nearer, but not lit
        Track("path", 1.5, [(0, 50), (100, 50)]),
    ]
    assert stand_lamp_posts(found, tracks) == 2
    north, south = found.points
    # 1-2 m from the path's edge, on the side the map draws them, facing the path.
    assert north.x == pytest.approx(30)
    assert 1.75 <= north.y - 50 <= 2.75
    assert south.x == pytest.approx(70)
    assert 1.75 <= 50 - south.y <= 2.75
    assert math.degrees(north.angle) == pytest.approx(-90)
    assert math.degrees(south.angle) == pytest.approx(90)


def test_knolls_drawn_with_contour_rings() -> None:
    def ring(x: float, y: float, r: float) -> dict[str, Any]:
        return {
            "type": "LineString",
            "coordinates": list(Point(x, y).buffer(r).exterior.coords),
        }

    rings = contour_rings(
        [
            feature(0, "103.0", ring(30, 70, 6)),  # a knoll
            feature(1, "101.0", ring(70, 30, 6)),  # a depression
            feature(2, "101.0", ring(50, 50, 30)),  # too big: a hill
            feature(3, "306.0", ring(30, 30, 6)),  # not a contour
        ],
        ISOM,
    )
    assert len(rings) == 2
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    # The terrain model shows both, faintly.
    for x, y, dz in ((30, 70, 0.3), (70, 30, -0.3)):
        east, north = offsets(x, y)
        dtm[np.hypot(east, north) < 4] += dz
    before = dtm.copy()

    assert raise_knolls(dtm, [], rings, EXTENT) == (0, 1)
    # The knoll's top is 1 m above its contour line; outside the ring nothing changes.
    east, north = offsets(30, 70)
    d = np.hypot(east, north)
    assert dtm[d < 1].max() == pytest.approx(101.0, abs=0.05)
    np.testing.assert_array_equal(dtm[d > 6.5], before[d > 6.5])


def test_a_building_drawn_as_a_rock_pillar_leaves_no_rocks() -> None:
    # ISOM 2000 202 (rock pillar) is black like a building; here it is a farm building.
    pillar = {
        "type": "Polygon",
        "coordinates": [[[52, 52], [60, 52], [60, 58], [52, 58], [52, 52]]],
    }
    found, _ = collect_features(
        [feature(0, "202.0", pillar), feature(1, "206.0", point(80, 80))], ISOM
    )
    assert drop_rocks_in_buildings(found, [box(50, 50, 62, 60)]) == 4
    assert [(p.kind, p.x, p.y) for p in found.points] == [("boulder", 80, 80)]


def test_small_ruins_drawn_as_points_become_square_ruins() -> None:
    # ISOM 2000 530.1 (small ruin, 5 m) turned 30°, and 530.2 (very small ruin, 3 m).
    found, _ = collect_features(
        [
            feature(0, "530.1", point(20, 20), ang=30),
            feature(1, "530.2", point(60, 60)),
        ],
        ISOM,
    )
    small, very_small = found.lines
    assert (small.kind, small.size, very_small.size) == ("ruin", 0.6, 0.5)
    for ruin, centre, side in ((small, (20, 20), 5), (very_small, (60, 60), 3)):
        square = Polygon(ruin.coords)
        assert ruin.coords[0] == ruin.coords[-1]  # closed, like an area ruin
        assert square.area == pytest.approx(side * side)
        assert (square.centroid.x, square.centroid.y) == pytest.approx(centre)
    # The small ruin's first side runs at 30° from east.
    (x0, y0), (x1, y1) = small.coords[0], small.coords[1]
    assert math.degrees(math.atan2(y1 - y0, x1 - x0)) % 90 == pytest.approx(30)


def test_a_ruin_under_a_building_is_left_out() -> None:
    # ISOM 2000 530 (ruin): one half under a barn, one touching a shed, one on its own.
    def ruin(x: float) -> dict[str, Any]:
        ring = [[x, 10], [x + 8, 10], [x + 8, 18], [x, 18], [x, 10]]
        return {"type": "Polygon", "coordinates": [ring]}

    found, _ = collect_features(
        [
            feature(0, "530.0", ruin(0)),
            feature(1, "530.0", ruin(20)),
            feature(2, "530.0", ruin(40)),
        ],
        ISOM,
    )
    barn = box(4, 8, 14, 20)
    shed = box(28, 12, 32, 16)  # shares only the ruin's east edge
    assert drop_ruins_in_buildings(found, [barn, shed]) == 1
    assert sorted(line.coords[0][0] for line in found.lines) == [20, 40]


@pytest.mark.parametrize(
    ("key", "number"),
    [("isom2000", "118.0"), ("isom2000", "117.1"), ("isom2017", "115.0")],
)
def test_special_landform_features_are_ant_hills_about_1_m_high(
    key: str, number: str
) -> None:
    symbols = SymbolSet.load(key)
    features, _ = collect_features(
        [feature(i, number, point(10 + 7 * i, 20 + 3 * i)) for i in range(20)], symbols
    )
    assert {p.kind for p in features.points} == {"ant_hill"}
    heights = [p.size for p in features.points]
    assert all(0.8 <= h <= 1.2 for h in heights)
    assert max(heights) - min(heights) > 0.1  # not all alike


@pytest.mark.parametrize(
    ("key", "number"), [("isom2000", "540.0"), ("isom2017", "531.0")]
)
def test_special_man_made_features_are_picnic_tables_turned_every_way(
    key: str, number: str
) -> None:
    symbols = SymbolSet.load(key)
    features, _ = collect_features(
        [feature(i, number, point(10 + 7 * i, 20 + 3 * i)) for i in range(20)], symbols
    )
    assert {p.kind for p in features.points} == {"picnic_table"}
    assert {p.size for p in features.points} == {1.8}
    angles = [p.angle for p in features.points]
    assert all(0 <= a < 2 * math.pi for a in angles)
    assert max(angles) - min(angles) > math.pi
