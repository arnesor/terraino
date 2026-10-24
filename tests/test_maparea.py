from typing import Any

import pytest

from terraino.process.geometry import to_geometry
from terraino.process.maparea import find_map_area


def square(
    oid: int, x: float, y: float = 0.0, size: float = 100.0, sym: str = "406.0"
) -> dict[str, Any]:
    ring = [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]
    return {
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"oid": oid, "sym": sym},
    }


def line(oid: int, coords: list[list[float]], sym: str = "506.0") -> dict[str, Any]:
    return {
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"oid": oid, "sym": sym},
    }


def is_terrain(sym: str) -> bool:
    return float(sym) < 600


def test_legend_far_from_map_is_dropped() -> None:
    map_objects = [square(i, x=i * 110) for i in range(10)]
    legend = [square(100, x=3000), line(101, [[3000, 200], [3050, 200]])]
    area = find_map_area(map_objects + legend, is_terrain)
    assert area.keep_ids == list(range(10))
    assert area.dropped_ids == [100, 101]
    assert area.polygon.contains(to_geometry(map_objects[5]["geometry"]))


def test_non_terrain_symbols_are_ignored() -> None:
    features = [square(0, 0), square(1, 5000, sym="601.0")]
    area = find_map_area(features, is_terrain)
    assert area.keep_ids == [0]
    assert area.dropped_ids == []


def test_degenerate_geometries_are_skipped() -> None:
    features = [square(0, 0), line(1, [[50, 50]]), line(2, [])]
    area = find_map_area(features, is_terrain)
    assert area.keep_ids == [0, 1]


def test_no_terrain_raises() -> None:
    with pytest.raises(ValueError, match="no terrain"):
        find_map_area([square(0, 0, sym="900.0")], is_terrain)


def test_to_geometry_repairs_bow_tie() -> None:
    bow_tie = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]],
    }
    geometry = to_geometry(bow_tie)
    assert geometry is not None
    assert geometry.is_valid
    assert geometry.area == pytest.approx(50)
