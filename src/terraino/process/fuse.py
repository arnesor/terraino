"""Combine the map's layers with national data where the map says nothing."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from scipy import ndimage
from shapely import LineString, MultiLineString, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from terraino.fetch.osm import OsmFeature
from terraino.ingest.georef import Extent
from terraino.process.layers import TREES_KEEP, TREES_LIDAR, TREES_NONE, GroundLayers
from terraino.process.symbols import Ground

FOREST_CANOPY_M = 3.0
# Undergrowth level given to low vegetation found in the laser data.
LIDAR_UNDERGROWTH = 0.6
# Laser undergrowth density (share of returns stopped 0.5-3 m above the ground) that
# starts to count as undergrowth, the range up to full undergrowth, and the smoothing.
LIDAR_LOW_MIN = 0.1
LIDAR_LOW_RANGE = 0.5
LIDAR_UNDERGROWTH_SMOOTH = 3
_NO_UNDERGROWTH = [
    Ground.WATER,
    Ground.BUILDING,
    Ground.PAVED,
    Ground.GRAVEL,
    Ground.PATH,
]
BUILDING_CLEARANCE_M = 0.8

# Tree rule and running speed for each AR5 land type outside the map.
_LAND_COVER_RULES = {
    Ground.FIELD: (TREES_LIDAR, 0.6),
    Ground.OPEN: (TREES_LIDAR, 0.95),
    Ground.LAWN: (TREES_LIDAR, 0.9),
    Ground.PAVED: (TREES_NONE, 1.0),
    Ground.WATER: (TREES_NONE, 0.0),
    Ground.MARSH: (TREES_KEEP, 0.7),
    Ground.ROUGH: (TREES_KEEP, 0.9),
    Ground.FOREST: (TREES_KEEP, 0.9),
}

# Road widths (metres) and surfaces for OSM highway types, used outside the map.
_HIGHWAYS: dict[str, tuple[float, Ground]] = {
    "motorway": (12.0, Ground.PAVED),
    "trunk": (9.0, Ground.PAVED),
    "primary": (7.5, Ground.PAVED),
    "secondary": (6.5, Ground.PAVED),
    "tertiary": (5.5, Ground.PAVED),
    "unclassified": (4.5, Ground.GRAVEL),
    "residential": (5.0, Ground.PAVED),
    "service": (3.5, Ground.GRAVEL),
    "track": (3.0, Ground.GRAVEL),
    "path": (1.0, Ground.PATH),
    "footway": (1.5, Ground.PATH),
    "cycleway": (2.5, Ground.GRAVEL),
    "bridleway": (1.5, Ground.PATH),
}
_PAVED = {"asphalt", "paved", "concrete", "paving_stones", "sett"}
_UNPAVED = {"gravel", "fine_gravel", "compacted", "unpaved", "pebblestone"}
_DIRT = {"dirt", "ground", "earth", "grass", "mud", "sand"}


def fill_unknown_ground(layers: GroundLayers, canopy: npt.NDArray[np.float32]) -> None:
    """Give cells outside the map a ground class: forest under canopy, else open land.

    Examples:
        >>> from terraino.process.layers import GroundLayers
        >>> z = np.zeros((1, 2), dtype=np.float32)
        >>> layers = GroundLayers(
        ...     ground=np.zeros((1, 2), np.uint8), speed=z + 1, young=z, shrubs=z,
        ...     tree_rule=np.zeros((1, 2), np.uint8), clear=z > 0, in_map=z > 0)
        >>> fill_unknown_ground(layers, np.array([[10.0, 0.5]], dtype=np.float32))
        >>> layers.ground.tolist()
        [[1, 2]]
    """
    unknown = layers.ground == Ground.UNKNOWN
    forest = canopy >= FOREST_CANOPY_M
    layers.ground[unknown & forest] = Ground.FOREST
    layers.ground[unknown & ~forest] = Ground.OPEN


def add_low_vegetation(layers: GroundLayers, found: npt.NDArray[np.bool_]) -> None:
    """Put undergrowth where the laser data found bushes or young trees.

    Examples:
        >>> from terraino.process.layers import GroundLayers
        >>> z = np.zeros((1, 3), dtype=np.float32)
        >>> layers = GroundLayers(
        ...     ground=np.array([[2, 2, 10]], np.uint8), speed=z + 1, young=z, shrubs=z,
        ...     tree_rule=np.zeros((1, 3), np.uint8), clear=z > 0, in_map=z == 0)
        >>> add_low_vegetation(layers, np.array([[True, False, True]]))
        >>> layers.shrubs.tolist()
        [[0.6000000238418579, 0.0, 0.0]]
    """
    cells = found & ~layers.clear & ~np.isin(layers.ground, _NO_UNDERGROWTH)
    layers.shrubs[cells] = np.maximum(layers.shrubs[cells], LIDAR_UNDERGROWTH)


def add_lidar_undergrowth(layers: GroundLayers, low: npt.NDArray[np.float32]) -> None:
    """Undergrowth in the forest where the laser stops in the 0.5-3 m layer.

    Args:
        layers: Ground layers to update.
        low: Share of the returns reaching the 0.5-3 m layer that stop in it (NaN
            where unknown), from the laser point cloud.

    Examples:
        >>> from terraino.process.layers import GroundLayers
        >>> z = np.zeros((1, 3), dtype=np.float32)
        >>> layers = GroundLayers(
        ...     ground=np.array([[1, 1, 2]], np.uint8), speed=z + 1, young=z, shrubs=z,
        ...     tree_rule=np.zeros((1, 3), np.uint8), clear=z > 0, in_map=z == 0)
        >>> add_lidar_undergrowth(layers, np.array([[0.05, 0.6, 0.6]], np.float32))
        >>> [round(v, 2) for v in layers.shrubs[0].tolist()]  # smoothed; not on open land
        [0.27, 0.6, 0.0]
    """
    density = np.nan_to_num(low, nan=0.0)
    density = ndimage.uniform_filter(density, size=LIDAR_UNDERGROWTH_SMOOTH)
    level = np.clip(
        (density - LIDAR_LOW_MIN) / LIDAR_LOW_RANGE, 0.0, LIDAR_UNDERGROWTH
    ).astype(np.float32)
    cells = (
        (layers.tree_rule == TREES_KEEP)
        & ~layers.clear
        & np.isin(layers.ground, [Ground.FOREST, Ground.UNKNOWN])
    )
    layers.shrubs[cells] = np.maximum(layers.shrubs[cells], level[cells])


def apply_land_cover(layers: GroundLayers, land_cover: npt.NDArray[np.uint8]) -> None:
    """Use AR5 land cover outside the mapped area."""
    outside = ~layers.in_map & (land_cover != Ground.UNKNOWN)
    layers.ground[outside] = land_cover[outside]
    for ground, (trees, speed) in _LAND_COVER_RULES.items():
        cells = outside & (land_cover == ground)
        layers.tree_rule[cells] = trees
        layers.speed[cells] = speed


def road_style(tags: dict[str, str]) -> tuple[float, Ground] | None:
    """Width and ground class of an OSM highway, or None if it is not a road or path.

    Examples:
        >>> road_style({"highway": "track", "surface": "asphalt"})
        (3.0, <Ground.PAVED: 7>)
        >>> road_style({"highway": "proposed"}) is None
        True
    """
    style = _HIGHWAYS.get(tags.get("highway", ""))
    if style is None:
        return None
    width, ground = style
    surface = tags.get("surface", "")
    if surface in _PAVED:
        ground = Ground.PAVED
    elif surface in _UNPAVED:
        ground = Ground.GRAVEL
    elif surface in _DIRT:
        ground = Ground.PATH
    return width, ground


def _paint(
    layer: npt.NDArray[np.generic],
    shapes: Sequence[tuple[BaseGeometry, float]],
    extent: Extent,
    where: npt.NDArray[np.bool_],
) -> None:
    if not shapes:
        return
    painted = rasterize(
        shapes,
        out_shape=layer.shape,
        transform=extent.raster_transform(1),
        fill=-1,
        dtype=np.float32,
    )
    cells = where & (painted >= 0)
    layer[cells] = painted[cells].astype(layer.dtype)


def apply_osm(
    layers: GroundLayers,
    features: Iterable[OsmFeature],
    footprints: Iterable[Polygon],
    extent: Extent,
) -> None:
    """Clear trees along OSM roads and paint water outside the map, buildings everywhere."""
    roads: list[tuple[BaseGeometry, float]] = []
    water: list[tuple[BaseGeometry, float]] = []
    for f in features:
        geometry = f.geometry
        style = road_style(f.tags)
        if style is not None and isinstance(geometry, LineString | MultiLineString):
            width, ground = style
            roads.append((geometry.buffer(max(width, 1.2) / 2), int(ground)))
        elif f.tags.get("natural") == "water" and isinstance(
            geometry, Polygon | MultiPolygon
        ):
            water.append((geometry, int(Ground.WATER)))
        elif f.tags.get("waterway") in {"stream", "river", "ditch"} and isinstance(
            geometry, LineString | MultiLineString
        ):
            width = 6.0 if f.tags["waterway"] == "river" else 1.5
            water.append((geometry.buffer(width / 2), int(Ground.WATER)))

    outside = ~layers.in_map
    # Roads are drawn as their own strips (terraino.process.tracks), not as ground.
    _paint(layers.ground, water, extent, outside)
    clear = np.zeros_like(layers.clear)
    _paint(clear, [(g, 1) for g, _ in water + roads], extent, outside)
    layers.clear |= clear
    speed = [(g, 0.0) for g, _ in water] + [(g, 1.0) for g, _ in roads]
    _paint(layers.speed, speed, extent, outside)

    buildings = [(fp, int(Ground.BUILDING)) for fp in footprints]
    everywhere = np.ones_like(layers.clear)
    _paint(layers.ground, buildings, extent, everywhere)
    _paint(layers.speed, [(fp, 0.0) for fp in footprints], extent, everywhere)
    near = np.zeros_like(layers.clear)
    _paint(
        near,
        [(fp.buffer(BUILDING_CLEARANCE_M), 1) for fp in footprints],
        extent,
        everywhere,
    )
    layers.clear |= near
