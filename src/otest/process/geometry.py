"""Tolerant conversion of map GeoJSON to shapely geometries."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shapely import GEOSException, LineString, Point, make_valid
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry


def to_geometry(geojson: Mapping[str, Any] | None) -> BaseGeometry | None:
    """Convert a GeoJSON geometry to shapely, repairing what OCAD maps tend to contain.

    Degenerate lines with one vertex become points, invalid polygons are repaired, and
    geometries that cannot be repaired give None.

    Examples:
        >>> to_geometry({"type": "LineString", "coordinates": [[1, 2]]}).wkt
        'POINT (1 2)'
        >>> to_geometry({"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 0]]]}) is None
        True
        >>> to_geometry(None) is None
        True
    """
    if geojson is None:
        return None
    kind = geojson.get("type")
    coords = geojson.get("coordinates")
    if kind == "LineString" and coords is not None and len(coords) < 2:
        return Point(coords[0]) if coords else None
    try:
        geometry = shape(dict(geojson))
    except (GEOSException, ValueError, IndexError):
        return None
    if isinstance(geometry, LineString) and geometry.length == 0:
        return geometry.centroid
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    if geometry.is_empty or (geometry.area == 0 and kind == "Polygon"):
        return None
    return geometry
