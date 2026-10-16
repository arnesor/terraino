"""Find the area of an orienteering map that shows real terrain.

Maps often place the legend, title and logos outside the mapped area, drawn with the
same terrain symbols as the map itself. A legend's lake or road must not end up in the
3D world. The mapped area is found as the largest cluster of terrain objects, where
objects closer than a gap distance belong to the same cluster.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from shapely import MultiPolygon, Polygon, STRtree, unary_union
from shapely.geometry.base import BaseGeometry

from otest.process.geometry import to_geometry

DEFAULT_GAP_M = 40.0


@dataclass(frozen=True)
class MapArea:
    """The mapped area and the objects inside it.

    Attributes:
        polygon: Outline of the mapped area, grown by half the gap distance.
        keep_ids: Object ids (``oid``) of terrain objects inside the mapped area.
        dropped_ids: Object ids of terrain objects outside it (legend, title, ...).
    """

    polygon: Polygon
    keep_ids: list[int]
    dropped_ids: list[int]


def _largest_polygon(geometry: BaseGeometry) -> Polygon:
    if isinstance(geometry, Polygon):
        return geometry
    if isinstance(geometry, MultiPolygon):
        return max(geometry.geoms, key=lambda g: g.area)
    msg = f"Expected a polygon, got {geometry.geom_type}"
    raise TypeError(msg)


def find_map_area(
    features: Iterable[Mapping[str, Any]],
    is_terrain: Callable[[str], bool],
    gap: float = DEFAULT_GAP_M,
) -> MapArea:
    """Find the largest cluster of terrain objects.

    Args:
        features: GeoJSON features with ``oid`` and ``sym`` properties.
        is_terrain: Tells whether a symbol number describes terrain.
        gap: Objects further apart than this (metres) belong to different clusters.

    Returns:
        The mapped area and which objects are inside it.

    Raises:
        ValueError: If there are no terrain objects.

    Examples:
        >>> def square(oid, x):
        ...     ring = [[x, 0], [x + 100, 0], [x + 100, 100], [x, 100], [x, 0]]
        ...     return {"geometry": {"type": "Polygon", "coordinates": [ring]},
        ...             "properties": {"oid": oid, "sym": "406.0"}}
        >>> area = find_map_area([square(0, 0), square(1, 120), square(2, 2000)],
        ...                      lambda s: True)
        >>> area.keep_ids, area.dropped_ids
        ([0, 1], [2])
    """
    oids: list[int] = []
    geometries: list[BaseGeometry] = []
    for feature in features:
        props = feature["properties"]
        if not is_terrain(props["sym"]):
            continue
        geometry = to_geometry(feature.get("geometry"))
        if geometry is None:
            continue
        oids.append(int(props["oid"]))
        geometries.append(geometry)
    if not geometries:
        msg = "The map has no terrain objects"
        raise ValueError(msg)

    # Simplifying first keeps the union fast; the tolerance is well below the gap.
    blobs = unary_union(
        [g.simplify(gap / 4).buffer(gap / 2, quad_segs=1) for g in geometries]
    )
    polygon = _largest_polygon(blobs)

    tree = STRtree(geometries)
    inside = {int(i) for i in tree.query(polygon, predicate="intersects")}
    keep = sorted(oids[i] for i in inside)
    dropped = sorted(oids[i] for i in range(len(oids)) if i not in inside)
    return MapArea(polygon=polygon, keep_ids=keep, dropped_ids=dropped)
