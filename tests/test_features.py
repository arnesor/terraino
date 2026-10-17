import math
from typing import Any

import numpy as np
import pytest
from shapely import box

from otest.ingest.georef import Extent
from otest.process.features import (
    CLIFF_FACE_M,
    CLIFF_TAPER_M,
    LineFeature,
    carve_cliffs,
    collect_features,
    measure_cliffs,
    paint_cliffs,
    place_poles,
)
from otest.process.layers import GroundLayers
from otest.process.symbols import Ground, SymbolSet

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
