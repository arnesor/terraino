"""Buildings with heights and roofs measured from the laser surface model."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from shapely import MultiPolygon, Polygon, STRtree
from shapely.geometry.base import BaseGeometry

from otest.fetch.osm import OsmFeature
from otest.ingest.georef import Extent
from otest.process.geometry import to_geometry
from otest.process.symbols import Ground, SymbolSet

MIN_AREA_M2 = 4.0
# A map building overlapping an OSM building by this share is the same building.
SAME_BUILDING_OVERLAP = 0.3
# Footprints filling at least this share of their oriented rectangle get gable roofs.
RECTANGULAR = 0.82
MIN_RIDGE_M = 0.8

# Default (wall height, roof height) when the surface model gives no useful heights.
_DEFAULT_SIZE = {
    "house": (5.0, 2.8),
    "garage": (2.5, 1.0),
    "shed": (2.3, 0.9),
    "barn": (5.5, 3.5),
    "farm_auxiliary": (4.5, 2.8),
    "cabin": (2.6, 1.6),
    "other": (4.0, 2.0),
}
# Wall colours (sRGB hex) and their weights, by kind of building.
_WALLS = {
    "house": [
        ("#f2f0e8", 5),
        ("#b33a2c", 2),
        ("#e8c66a", 2),
        ("#8d9aa3", 1),
        ("#6b5a48", 1),
    ],
    "barn": [("#a8322a", 8), ("#7d2a22", 2), ("#d8d4c8", 1)],
    "cabin": [("#5a4636", 4), ("#8a3a2a", 2), ("#6e6a5a", 1)],
    "other": [("#d9d6cc", 3), ("#9aa0a4", 2), ("#b33a2c", 1)],
}
_ROOFS = [("#2c2c2e", 6), ("#3d3f42", 3), ("#7a3527", 2), ("#55524e", 1)]


@dataclass(frozen=True)
class Building:
    """A building ready for the viewer.

    Attributes:
        footprint: Outline in projected coordinates.
        base: Ground height (lowest DTM value under the footprint).
        wall: Wall height above ``base`` in metres.
        roof: Roof height above the walls in metres (0 for flat roofs).
        roof_type: ``"gable"`` or ``"flat"``.
        ridge: Direction of the ridge in radians from east, counter-clockwise.
        wall_color: Wall colour, sRGB hex.
        roof_color: Roof colour, sRGB hex.
        kind: house, garage, shed, barn, farm_auxiliary, cabin or other.
        source: ``"osm"`` or ``"map"``.
    """

    footprint: Polygon
    base: float
    wall: float
    roof: float
    roof_type: str
    ridge: float
    wall_color: str
    roof_color: str
    kind: str
    source: str


def building_kind(tags: Mapping[str, str]) -> str:
    """Group OSM building types into the kinds used for size and colour.

    Examples:
        >>> building_kind({"building": "detached"}), building_kind({"building": "garages"})
        ('house', 'garage')
    """
    value = tags.get("building", "yes")
    groups = {
        "house": {
            "house",
            "detached",
            "semidetached_house",
            "residential",
            "farm",
            "terrace",
        },
        "garage": {"garage", "garages", "carport"},
        "shed": {"shed", "hut", "roof", "greenhouse"},
        "barn": {"barn", "stable", "cowshed"},
        "farm_auxiliary": {"farm_auxiliary"},
        "cabin": {"cabin"},
    }
    for kind, values in groups.items():
        if value in values:
            return kind
    return "other"


def _pick(options: Sequence[tuple[str, int]], seed: str) -> str:
    """Deterministic weighted choice: the same building always gets the same colour."""
    total = sum(w for _, w in options)
    r = (
        int(hashlib.md5(seed.encode(), usedforsecurity=False).hexdigest()[:8], 16)
        % total
    )
    for value, weight in options:
        if r < weight:
            return value
        r -= weight
    return options[-1][0]


def _ridge_angle(footprint: Polygon) -> tuple[float, float]:
    """Return the long-axis direction of the footprint and how rectangular it is."""
    rect = footprint.minimum_rotated_rectangle
    if not isinstance(rect, Polygon):
        return 0.0, 0.0
    coords = list(rect.exterior.coords)
    edges = [
        (coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1])
        for i in range(2)
    ]
    long_edge = max(edges, key=lambda e: math.hypot(*e))
    angle = math.atan2(long_edge[1], long_edge[0])
    fill = footprint.area / rect.area if rect.area > 0 else 0.0
    return angle, fill


def collect_footprints(
    osm: Iterable[OsmFeature],
    omap_features: Iterable[Mapping[str, Any]],
    symbols: SymbolSet,
) -> list[tuple[Polygon, str, str, str]]:
    """Return ``(footprint, kind, source, id)`` for OSM buildings and map-only buildings."""
    footprints: list[tuple[Polygon, str, str, str]] = []
    for f in osm:
        if "building" not in f.tags:
            continue
        for poly in _polygons(f.geometry):
            footprints.append((poly, building_kind(f.tags), "osm", f.osm_id))

    osm_polys = [p for p, _, _, _ in footprints]
    tree = STRtree(osm_polys) if osm_polys else None
    for feature in omap_features:
        rule = symbols.rule(feature["properties"]["sym"])
        if rule is None or rule.ground is not Ground.BUILDING:
            continue
        geometry = to_geometry(feature.get("geometry"))
        if geometry is None:
            continue
        for poly in _polygons(geometry):
            if tree is not None:
                hits = tree.query(poly, predicate="intersects")
                overlap = sum(poly.intersection(osm_polys[i]).area for i in hits)
                if overlap > SAME_BUILDING_OVERLAP * poly.area:
                    continue
            oid = feature["properties"]["oid"]
            footprints.append((poly, "other", "map", f"map/{oid}"))
    return [fp for fp in footprints if fp[0].area >= MIN_AREA_M2]


def _polygons(geometry: BaseGeometry) -> list[Polygon]:
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    if hasattr(geometry, "geoms"):
        return [g for g in geometry.geoms if isinstance(g, Polygon)]
    return []


def measure_buildings(
    footprints: Sequence[tuple[Polygon, str, str, str]],
    dtm: npt.NDArray[np.float32],
    canopy: npt.NDArray[np.float32],
    extent: Extent,
) -> list[Building]:
    """Measure base, wall and roof heights of each footprint.

    Args:
        footprints: From collect_footprints.
        dtm: Terrain heights on the world's 1 m grid.
        canopy: Surface minus terrain on the same grid.
        extent: World extent.
    """
    if not footprints:
        return []
    labels = rasterize(
        [(fp[0], i + 1) for i, fp in enumerate(footprints)],
        out_shape=extent.raster_shape(1),
        transform=extent.raster_transform(1),
        fill=0,
        dtype=np.int32,
    )
    flat = labels.ravel()
    cells = np.flatnonzero(flat)
    order = np.argsort(flat[cells], kind="stable")
    cells = cells[order]
    ids = flat[cells]
    bounds = np.searchsorted(ids, np.arange(1, len(footprints) + 2))

    buildings = []
    for i, (poly, kind, source, ident) in enumerate(footprints):
        own = cells[bounds[i] : bounds[i + 1]]
        default_wall, default_roof = _DEFAULT_SIZE[kind]
        if len(own) >= 3:
            heights = canopy.ravel()[own]
            base = float(dtm.ravel()[own].min())
            top = float(np.percentile(heights, 95))
            eave = float(np.percentile(heights, 25))
        else:
            centre = poly.representative_point()
            row = int(np.clip(extent.y1 - centre.y, 0, dtm.shape[0] - 1))
            col = int(np.clip(centre.x - extent.x0, 0, dtm.shape[1] - 1))
            base = float(dtm[row, col])
            top = eave = 0.0

        angle, fill = _ridge_angle(poly)
        if top < 2.0:
            wall, roof = default_wall, default_roof
        else:
            top = min(top, 25.0)
            wall = float(np.clip(eave, 2.2, top))
            roof = top - wall
        gable = fill >= RECTANGULAR and roof >= MIN_RIDGE_M
        if not gable:
            wall, roof = max(wall + roof * 0.5, 2.2), 0.0
        palette = _WALLS.get(kind if kind in _WALLS else "other", _WALLS["other"])
        if kind == "farm_auxiliary":
            palette = _WALLS["barn"]
        buildings.append(
            Building(
                footprint=poly,
                base=base,
                wall=round(wall, 2),
                roof=round(min(roof, 9.0), 2),
                roof_type="gable" if gable else "flat",
                ridge=angle,
                wall_color=_pick(palette, ident),
                roof_color=_pick(_ROOFS, ident + "roof"),
                kind=kind,
                source=source,
            )
        )
    return buildings
