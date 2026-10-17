"""Rasterise the orienteering map into 1 m layers describing the ground."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from shapely import LineString, MultiLineString, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from otest.ingest.georef import Extent
from otest.process.geometry import to_geometry
from otest.process.symbols import Ground, SymbolRule, SymbolSet

log = logging.getLogger(__name__)

# Lines narrower than this are widened so they stay connected on the 1 m grid.
MIN_RASTER_WIDTH_M = 1.2

TREES_KEEP = 0
TREES_NONE = 1
# Only the trees found in the laser data; nothing is added below the canopy.
TREES_LIDAR = 2
TREE_RULES = {"keep": TREES_KEEP, "none": TREES_NONE, "lidar": TREES_LIDAR}

# Overprinting areas (marsh, stony ground) do not change the vegetation below them.
_OVERPRINT = {Ground.MARSH, Ground.STONY}


@dataclass
class GroundLayers:
    """1 m rasters over the world extent, north-up.

    Attributes:
        ground: Ground class (Ground values); UNKNOWN outside the map.
        speed: Running speed factor, 1 = easy forest.
        young: Young trees to add per 100 m².
        shrubs: Undergrowth density, 0..1.
        tree_rule: TREES_KEEP, TREES_NONE or TREES_LIDAR.
        clear: True where no trees may stand (roads, paths, streams, power lines).
        in_map: True inside the mapped area.
    """

    ground: npt.NDArray[np.uint8]
    speed: npt.NDArray[np.float32]
    young: npt.NDArray[np.float32]
    shrubs: npt.NDArray[np.float32]
    tree_rule: npt.NDArray[np.uint8]
    clear: npt.NDArray[np.bool_]
    in_map: npt.NDArray[np.bool_]


@dataclass(frozen=True)
class _Shape:
    geometry: BaseGeometry
    rule: SymbolRule
    is_area: bool


def _shapes(
    features: Iterable[Mapping[str, Any]], symbols: SymbolSet
) -> tuple[list[_Shape], list[BaseGeometry], set[str]]:
    """Return painted shapes (sorted by order), tree-free strips and unknown symbols."""
    shapes: list[_Shape] = []
    clear: list[BaseGeometry] = []
    unknown: set[str] = set()
    for feature in features:
        number = feature["properties"]["sym"]
        rule = symbols.rule(number)
        if rule is None:
            unknown.add(number)
            continue
        geometry = to_geometry(feature.get("geometry"))
        if geometry is None:
            continue
        if isinstance(geometry, Polygon | MultiPolygon):
            if rule.ground is not None or rule.overprint:
                shapes.append(_Shape(geometry, rule, is_area=True))
        elif isinstance(geometry, LineString | MultiLineString):
            if rule.ground is not None and rule.width is not None:
                width = max(rule.width, MIN_RASTER_WIDTH_M)
                shapes.append(_Shape(geometry.buffer(width / 2), rule, is_area=False))
            if rule.clear is not None:
                clear.append(geometry.buffer(rule.clear / 2))
    shapes.sort(key=lambda s: s.rule.order)
    return shapes, clear, unknown


def _paint(
    pairs: Sequence[tuple[BaseGeometry, float]],
    extent: Extent,
    fill: float,
    dtype: type[np.generic],
) -> npt.NDArray[Any]:
    shape = extent.raster_shape(1)
    if not pairs:
        return np.full(shape, fill, dtype=dtype)
    painted: npt.NDArray[Any] = rasterize(
        pairs,
        out_shape=shape,
        transform=extent.raster_transform(1),
        fill=fill,
        dtype=dtype,
    )
    return painted


def rasterize_map(
    features: Iterable[Mapping[str, Any]],
    symbols: SymbolSet,
    extent: Extent,
    map_area: Polygon,
) -> GroundLayers:
    """Paint the map's objects into ground layers.

    Args:
        features: The map's terrain objects (GeoJSON features with ``sym``).
        symbols: Meaning of the symbols.
        extent: World extent; the rasters have 1 m cells.
        map_area: Outline of the mapped area. Inside it the white map background
            means forest with easy running.

    Returns:
        The ground layers.
    """
    shapes, clear_strips, unknown = _shapes(features, symbols)
    if unknown:
        log.info("Symbols without 3D meaning (ignored): %s", ", ".join(sorted(unknown)))

    in_map = _paint([(map_area, 1)], extent, 0, np.uint8).astype(bool)

    ground = _paint(
        [(map_area, int(Ground.FOREST))]
        + [
            (s.geometry, int(s.rule.ground))
            for s in shapes
            if s.rule.ground is not None
        ],
        extent,
        int(Ground.UNKNOWN),
        np.uint8,
    )
    speed = _paint(
        [(s.geometry, s.rule.speed) for s in shapes if s.rule.speed is not None],
        extent,
        1.0,
        np.float32,
    )
    # Vegetation areas set young trees, shrubs and the tree rule; overprinting areas
    # (marsh, stony ground, undergrowth patterns) leave what is below them.
    vegetation = [
        s
        for s in shapes
        if s.is_area and not s.rule.overprint and s.rule.ground not in _OVERPRINT
    ]
    young = _paint(
        [(s.geometry, s.rule.young) for s in vegetation], extent, 0.0, np.float32
    )
    undergrowth = [
        s
        for s in shapes
        if s.is_area and (s.rule.overprint or s.rule.ground not in _OVERPRINT)
    ]
    shrubs = _paint(
        [(s.geometry, s.rule.shrubs) for s in undergrowth], extent, 0.0, np.float32
    )
    tree_rule = _paint(
        [(s.geometry, TREE_RULES[s.rule.trees]) for s in vegetation],
        extent,
        TREES_KEEP,
        np.uint8,
    )
    no_trees = [(s.geometry, 1) for s in shapes if not s.is_area]
    clear = _paint(
        [(g, 1) for g in clear_strips] + no_trees, extent, 0, np.uint8
    ).astype(bool)

    return GroundLayers(
        ground=ground,
        speed=speed,
        young=young,
        shrubs=shrubs,
        tree_rule=tree_rule,
        clear=clear,
        in_map=in_map,
    )
