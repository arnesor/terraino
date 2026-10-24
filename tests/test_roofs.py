import math
from collections.abc import Callable

import numpy as np
import pytest
import shapely
from shapely import Polygon, box

from terraino.process.roofs import RoofPart, segment_roof

CELL = 0.5


def segment(
    footprint: Polygon, height: Callable[[np.ndarray, np.ndarray], np.ndarray]
) -> list[RoofPart]:
    """Run segment_roof on a synthetic surface over a footprint centred near (0, 0)."""
    x0, y0, x1, y1 = footprint.bounds
    xs = np.arange(x0 - 1 + CELL / 2, x1 + 1, CELL)
    ys = np.arange(y1 + 1 - CELL / 2, y0 - 1, -CELL)  # rows from the north
    x, y = np.meshgrid(xs, ys)
    rng = np.random.default_rng(0)
    z = height(x, y) + rng.normal(0, 0.04, x.shape)
    valid = np.asarray(shapely.contains_xy(footprint.buffer(-0.5), x, y), dtype=bool)
    ox, oy = np.asarray(footprint.exterior.coords).T
    rect = footprint.minimum_rotated_rectangle
    assert isinstance(rect, Polygon)
    coords = list(rect.exterior.coords)
    edges = [
        (coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1])
        for i in range(2)
    ]
    long = max(edges, key=lambda e: math.hypot(*e))
    axis = math.atan2(long[1], long[0])
    parts = segment_roof(z, valid, x, y, axis, ox, oy, CELL)
    assert parts is not None
    return parts


def gable(
    x: np.ndarray,
    y: np.ndarray,
    *,
    along_x: bool,
    at: float,
    eave: float,
    ridge: float,
    half: float,
) -> np.ndarray:
    across = np.abs((y if along_x else x) - at)
    return ridge - (ridge - eave) / half * across


def test_simple_gable() -> None:
    footprint = box(-6, -4, 6, 4)  # ridge east-west
    (part,) = segment(
        footprint, lambda x, y: gable(x, y, along_x=True, at=0, eave=3, ridge=6, half=4)
    )
    assert part.roof_type == "gable"
    assert part.hips == (False, False)
    assert math.degrees(part.angle) % 180 == pytest.approx(0, abs=3)
    assert part.eave == pytest.approx(3.0, abs=0.3)
    assert part.ridge == pytest.approx(6.0, abs=0.2)
    assert 2 * part.half_length == pytest.approx(12, abs=0.6)
    assert 2 * part.half_width == pytest.approx(8, abs=0.6)


def test_hipped_roof() -> None:
    footprint = box(-7, -4, 7, 4)

    def hip(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        return np.asarray(6 - 0.75 * np.maximum(np.abs(y), np.abs(x) - 3))

    parts = segment(footprint, hip)
    main = max(parts, key=lambda p: p.area)
    assert main.roof_type == "gable"
    assert main.hips == (True, True)
    assert main.ridge == pytest.approx(6.0, abs=0.2)


def test_cross_gable() -> None:
    # A 12 x 10 m main block (ridge east-west) crossed by a 5 m wide wing running
    # north-south, 14 m long, both ridges at 7.7 m.
    footprint = shapely.union(box(-6, -5, 6, 5), box(-2.5, -7, 2.5, 7))
    assert isinstance(footprint, Polygon)

    def roof(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        main = gable(x, y, along_x=True, at=0, eave=4.8, ridge=7.7, half=5)
        wing = gable(x, y, along_x=False, at=0, eave=5.8, ridge=7.7, half=2.5)
        in_wing = np.abs(x) <= 2.5
        return np.where(in_wing, np.maximum(main, wing), main)

    parts = segment(footprint, roof)
    gables = sorted((p for p in parts if p.roof_type == "gable"), key=lambda p: -p.area)
    assert len(gables) >= 2
    directions = {round(math.degrees(p.angle) % 180) // 45 for p in gables[:2]}
    assert directions == {0, 2}  # one ridge east-west, one north-south
    for p in gables[:2]:
        assert p.ridge == pytest.approx(7.7, abs=0.3)
    ew = next(p for p in gables if round(math.degrees(p.angle) % 180) // 45 == 0)
    ns = next(p for p in gables if round(math.degrees(p.angle) % 180) // 45 == 2)
    assert 2 * ew.half_width == pytest.approx(10, abs=1.2)
    assert 2 * ns.half_width == pytest.approx(5, abs=1.2)


def test_l_shaped_house() -> None:
    # Main wing 12 x 8 m (ridge east-west), a 6 x 6 m wing to the south of its east end.
    footprint = shapely.union(box(-6, 0, 6, 8), box(0, -6, 6, 0))
    assert isinstance(footprint, Polygon)

    def roof(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        main = gable(x, y, along_x=True, at=4, eave=3, ridge=6, half=4)
        wing = gable(x, y, along_x=False, at=3, eave=3, ridge=5.2, half=3)
        return np.where(y >= 0, main, wing)

    parts = segment(footprint, roof)
    gables = [p for p in parts if p.roof_type == "gable"]
    assert len(gables) == 2
    assert sorted(round(p.ridge, 1) for p in gables) == pytest.approx(
        [5.2, 6.0], abs=0.25
    )


def test_flat_roof() -> None:
    (part,) = segment(box(-10, -8, 10, 8), lambda x, y: np.full(x.shape, 7.0))
    assert part.roof_type == "flat"
    assert part.eave == pytest.approx(7.0, abs=0.1)
