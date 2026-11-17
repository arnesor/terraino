"""Watercourses and water channels traced from Kartverket's map, outside the orienteering map.

Kartverket's water layer draws lake and river shores in the same blue as streams; a
traced line that lies mostly along water already in the world (AR5, OSM) is a shore and
is left out. The rest are drawn and painted as the map's symbols of the same kind:
small watercourse (305) and minor water channel (306).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from scipy import ndimage
from shapely import LineString, Polygon
from shapely.geometry.base import BaseGeometry

from terraino.fetch.osm import OsmFeature
from terraino.ingest.georef import Extent
from terraino.process.layers import MIN_RASTER_WIDTH_M, GroundLayers
from terraino.process.symbols import Ground, SymbolRule, SymbolSet

# A traced line with at least SHORE_SHARE of its length within SHORE_M of water is a shore.
SHORE_M = 3
SHORE_SHARE = 0.5

type Traced = tuple[str, LineString]


def track_rule(symbols: SymbolSet, kind: str) -> SymbolRule | None:
    """The rule of the first line symbol drawn as track style ``kind``.

    Examples:
        >>> rule = track_rule(SymbolSet.load("isom2017"), "small_stream")
        >>> rule.ground, rule.width, rule.clear
        (<Ground.WATER: 10>, 0.8, 1.5)
    """
    return next((r for r in symbols.rules.values() if r.track == kind), None)


def water_mask(
    layers: GroundLayers, osm: Iterable[OsmFeature], extent: Extent
) -> npt.NDArray[np.bool_]:
    """Cells of water in the world: from the map and AR5, and OSM's lakes."""
    water: npt.NDArray[np.bool_] = layers.ground == Ground.WATER
    lakes = [
        (f.geometry, 1)
        for f in osm
        if f.tags.get("natural") == "water" and not f.geometry.is_empty
    ]
    if lakes:
        water |= rasterize(
            lakes,
            out_shape=water.shape,
            transform=extent.raster_transform(1),
            fill=0,
            dtype=np.uint8,
        ).astype(bool)
    return water


def leave_out_shores(
    traced: Sequence[Traced], water: npt.NDArray[np.bool_], extent: Extent
) -> list[Traced]:
    """The traced lines that are not shores of the water in ``water``.

    Examples:
        >>> water = np.zeros((20, 20), bool)
        >>> water[:10, :] = True   # a lake in the northern half
        >>> shore = ("small_stream", LineString([(0, 10), (20, 10)]))
        >>> stream = ("small_stream", LineString([(10, 10), (10, 0)]))  # runs into it
        >>> [list(line.coords) for _, line in leave_out_shores([shore, stream], water, Extent(0, 0, 20, 20))]
        [[(10.0, 10.0), (10.0, 0.0)]]
    """
    near = ndimage.binary_dilation(water, iterations=SHORE_M)
    rows_n, cols_n = near.shape
    kept = []
    for kind, line in traced:
        n = max(2, int(line.length) + 1)
        points = [line.interpolate(i / (n - 1), normalized=True) for i in range(n)]
        cols = np.array([int(p.x - extent.x0) for p in points])
        rows = np.array([int(extent.y1 - p.y) for p in points])
        inside = (rows >= 0) & (rows < rows_n) & (cols >= 0) & (cols < cols_n)
        hits = near[rows[inside], cols[inside]]
        if hits.size == 0 or hits.mean() < SHORE_SHARE:
            kept.append((kind, line))
    return kept


def paint_watercourses(
    layers: GroundLayers,
    traced: Sequence[Traced],
    symbols: SymbolSet,
    extent: Extent,
    map_area: Polygon | None,
) -> None:
    """Paint wet ground, running speed and a tree-free strip along the traced lines.

    As the map's symbol for each kind does, outside the orienteering map.
    """
    ground: list[tuple[BaseGeometry, int]] = []
    speed: list[tuple[BaseGeometry, float]] = []
    clear: list[tuple[BaseGeometry, int]] = []
    for kind, traced_line in traced:
        rule = track_rule(symbols, kind)
        if rule is None:
            continue
        line = traced_line if map_area is None else traced_line.difference(map_area)
        if line.is_empty:
            continue
        if rule.ground is not None and rule.width is not None:
            strip = line.buffer(max(rule.width, MIN_RASTER_WIDTH_M) / 2)
            ground.append((strip, int(rule.ground)))
            if rule.speed is not None:
                speed.append((strip, rule.speed))
        if rule.clear is not None:
            clear.append((line.buffer(rule.clear / 2), 1))
    outside = ~layers.in_map
    for target, shapes in ((layers.ground, ground), (layers.speed, speed)):
        if shapes:
            painted = rasterize(
                shapes,
                out_shape=target.shape,
                transform=extent.raster_transform(1),
                fill=-1,
                dtype=np.float32,
            )
            cells = outside & (painted >= 0)
            target[cells] = painted[cells].astype(target.dtype)
    if clear:
        layers.clear |= outside & rasterize(
            clear,
            out_shape=layers.clear.shape,
            transform=extent.raster_transform(1),
            fill=0,
            dtype=np.uint8,
        ).astype(bool)
