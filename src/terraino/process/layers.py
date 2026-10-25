"""Rasterise the orienteering map into 1 m layers describing the ground."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from scipy import ndimage
from shapely import (
    LineString,
    MultiLineString,
    MultiPolygon,
    Polygon,
    STRtree,
    box,
    unary_union,
)
from shapely.geometry.base import BaseGeometry

from terraino.ingest.georef import Extent
from terraino.process.geometry import to_geometry
from terraino.process.symbols import SPEED_GROUPS, Ground, SymbolRule, SymbolSet

log = logging.getLogger(__name__)

# Lines narrower than this are widened so they stay connected on the 1 m grid.
MIN_RASTER_WIDTH_M = 1.2
# Areas narrower than this (on average) and elongated count as narrow strips.
NARROW_STRIP_M = 8.0
NARROW_ELONGATION = 18.0  # perimeter² / area; 18 is a 2:1 rectangle

TREES_KEEP = 0
TREES_NONE = 1
# Only the trees found in the laser data; nothing is added below the canopy.
TREES_LIDAR = 2
# A few of the laser's trees, the tallest, far apart (open land with scattered trees).
TREES_SCATTERED = 3
TREE_RULES = {
    "keep": TREES_KEEP,
    "none": TREES_NONE,
    "lidar": TREES_LIDAR,
    "scattered": TREES_SCATTERED,
}

# Overprinting areas (marsh, stony ground) do not change the vegetation below them.
_OVERPRINT = {Ground.MARSH, Ground.STONY}

# Width (m) of the grass verge along the edges of grain fields and the roads, paths and
# streams across them.
VERGE_M = 2
# Width (m) of the grass verge on each side of a cultivation boundary between fields.
FIELD_EDGE_VERGE_M = 1.0
# A hole in an area with at most this many corners, with a text beside it, is a gap the
# mapper left for the lettering (to keep a pattern such as cultivated land's dots off the
# text), not terrain: the area is painted without the hole.
LETTERING_HOLE_CORNERS = 8
# Fields numbered k = 1, 2, ... grow grass when frac(k * golden ratio) < grass share:
# the picks spread evenly, so about that share of any run of fields is grass.
_GOLDEN = (5**0.5 - 1) / 2


@dataclass
class GroundLayers:
    """1 m rasters over the world extent, north-up.

    Attributes:
        ground: Ground class (Ground values); UNKNOWN outside the map.
        speed: Running speed factor, 1 = easy forest.
        young: Young trees to add per 100 m².
        shrubs: Undergrowth density, 0..1.
        tree_rule: TREES_KEEP, TREES_NONE, TREES_LIDAR or TREES_SCATTERED.
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


def is_narrow(polygon: Polygon) -> bool:
    """True for a long, narrow area: under NARROW_STRIP_M wide on average, elongated.

    Examples:
        >>> from shapely import box
        >>> is_narrow(box(0, 0, 60, 4)), is_narrow(box(0, 0, 15, 15))
        (True, False)
    """
    if polygon.area <= 0:
        return False
    width = 2 * polygon.area / polygon.length
    return (
        width < NARROW_STRIP_M and polygon.length**2 / polygon.area > NARROW_ELONGATION
    )


def grass_fields(numbers: npt.NDArray[np.int_], share: float) -> npt.NDArray[np.bool_]:
    """Which of the fields numbered ``numbers`` (1, 2, ...) grow grass instead of grain.

    Examples:
        >>> grass_fields(np.arange(1, 21), 0.1).nonzero()[0] + 1
        array([ 5, 13])
    """
    picked: npt.NDArray[np.bool_] = np.modf(numbers * _GOLDEN)[0] < share
    return picked


def split_fields(
    fields: npt.NDArray[np.bool_], grass_share: float
) -> tuple[npt.NDArray[np.bool_], npt.NDArray[np.bool_]]:
    """Split cultivated land into grain and grass.

    Each connected area of ``fields`` is one field. A share of them grow grass, and the
    others a grass verge VERGE_M wide along their edges.

    Args:
        fields: Cells of cultivated land, without the roads and streams across it.
        grass_share: Share of the fields that grow grass.

    Returns:
        Masks of grain and of grass.

    Examples:
        >>> fields = np.zeros((9, 9), dtype=bool)
        >>> fields[:, 1:8] = True
        >>> grain, grass = split_fields(fields, 0.0)
        >>> int(grain.sum()), int(grass.sum()), bool(grain[4, 4]), bool(grass[4, 1])
        (15, 48, True, True)
    """
    labels, count = ndimage.label(fields)
    grass_ids = np.flatnonzero(grass_fields(np.arange(1, count + 1), grass_share)) + 1
    grain = fields & ~np.isin(labels, grass_ids)
    y, x = np.ogrid[-VERGE_M : VERGE_M + 1, -VERGE_M : VERGE_M + 1]
    grain = ndimage.binary_erosion(grain, structure=x * x + y * y <= VERGE_M**2)
    return grain, fields & ~grain


def _polygons(geometry: BaseGeometry) -> list[Polygon]:
    """The polygons in a geometry."""
    if isinstance(geometry, Polygon):
        return [geometry]
    return [g for g in getattr(geometry, "geoms", []) if isinstance(g, Polygon)]


def _sow(
    areas: Sequence[_Shape], lines: Sequence[_Shape], edges: Sequence[BaseGeometry]
) -> list[_Shape]:
    """Shapes for cultivated land.

    The grain areas of a symbol that touch or overlap are one stretch of land: mappers
    often draw a field in several pieces. The map's cultivation boundaries (``edges``)
    split it into fields, numbered in a fixed order, and a share of the fields grow
    grass. The others are grass under grain: a grass verge stays along the edge of the
    land, along the roads, paths and streams across it, and (narrower) along the
    boundaries between fields.
    """
    tree = STRtree([s.geometry for s in lines])
    between = unary_union([e.buffer(FIELD_EDGE_VERGE_M) for e in edges])
    shapes: list[_Shape] = []
    number = 0
    for rule in dict.fromkeys(a.rule for a in areas):
        land = unary_union([a.geometry for a in areas if a.rule == rule])
        shapes.append(_Shape(land, rule.as_grass(), is_area=True))
        grain: BaseGeometry = land.buffer(-VERGE_M)
        crossing = tree.query(grain, predicate="intersects")
        if len(crossing):
            strips = unary_union([lines[i].geometry for i in crossing])
            grain = grain.difference(strips.buffer(VERGE_M))
        if not between.is_empty:
            grain = grain.difference(between)
        for field in _polygons(land.difference(between)):
            sown = field.intersection(grain)
            if sown.is_empty:
                continue
            number += 1
            if not grass_fields(np.array([number]), rule.grass_share)[0]:
                shapes.append(_Shape(sown, rule, is_area=True))
    return shapes


def _without_lettering_holes(
    geojson: Mapping[str, Any], lettering: STRtree
) -> Mapping[str, Any]:
    """A GeoJSON polygon without the holes left for lettering (LETTERING_HOLE_CORNERS).

    This works on the rings as drawn: repairing an invalid polygon can merge a hole
    with its neighbours into one with many corners.

    Examples:
        >>> from shapely import Point
        >>> square = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]
        >>> hole = [[20, 20], [20, 40], [60, 40], [60, 20], [20, 20]]
        >>> field = {"type": "Polygon", "coordinates": [square, hole]}
        >>> near = STRtree([Point(15, 30).buffer(10)])
        >>> len(_without_lettering_holes(field, near)["coordinates"])
        1
        >>> len(_without_lettering_holes(field, STRtree([]))["coordinates"])
        2
    """

    def drawn_for_lettering(ring: Sequence[Sequence[float]]) -> bool:
        if len(ring) < 4 or len(ring) - 1 > LETTERING_HOLE_CORNERS:
            return False
        bounds = box(*LineString(ring).bounds)
        return len(lettering.query(bounds, predicate="intersects")) > 0

    def filled(rings: Sequence[Sequence[Sequence[float]]]) -> list[Any]:
        return [rings[0], *(r for r in rings[1:] if not drawn_for_lettering(r))]

    if geojson.get("type") == "Polygon":
        return {**geojson, "coordinates": filled(geojson["coordinates"])}
    if geojson.get("type") == "MultiPolygon":
        return {**geojson, "coordinates": [filled(p) for p in geojson["coordinates"]]}
    return geojson


def _shapes(
    features: Iterable[Mapping[str, Any]],
    symbols: SymbolSet,
    lettering: Sequence[BaseGeometry] = (),
) -> tuple[list[_Shape], list[BaseGeometry], set[str]]:
    """Return painted shapes (sorted by order), tree-free strips and unknown symbols."""
    lettering_tree = STRtree(list(lettering))
    shapes: list[_Shape] = []
    fields: list[_Shape] = []
    field_edges: list[BaseGeometry] = []
    clear: list[BaseGeometry] = []
    unknown: set[str] = set()
    for feature in features:
        number = feature["properties"]["sym"]
        rule = symbols.rule(number)
        if rule is None:
            unknown.add(number)
            continue
        drawn = feature.get("geometry")
        if lettering and drawn is not None:
            drawn = _without_lettering_holes(drawn, lettering_tree)
        geometry = to_geometry(drawn)
        if geometry is None:
            continue
        if isinstance(geometry, Polygon | MultiPolygon):
            if rule.ground is Ground.GRAIN:
                for part in getattr(geometry, "geoms", [geometry]):
                    fields.append(_Shape(part, rule, is_area=True))
            elif rule.ground is not None or rule.overprint:
                if rule.narrow_trees is not None:
                    parts = list(getattr(geometry, "geoms", [geometry]))
                    narrow = replace(rule, trees=rule.narrow_trees)
                    for part in parts:
                        own = narrow if is_narrow(part) else rule
                        shapes.append(_Shape(part, own, is_area=True))
                else:
                    shapes.append(_Shape(geometry, rule, is_area=True))
        elif isinstance(geometry, LineString | MultiLineString):
            if rule.field_edge:
                field_edges.append(geometry)
            if rule.ground is not None and rule.width is not None:
                width = max(rule.width, MIN_RASTER_WIDTH_M)
                shapes.append(_Shape(geometry.buffer(width / 2), rule, is_area=False))
            if rule.clear is not None:
                clear.append(geometry.buffer(rule.clear / 2))
    if fields:
        shapes += _sow(fields, [s for s in shapes if not s.is_area], field_edges)
    # A stable sort: each field's grain stays on top of its grass.
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


def _speed(shapes: Sequence[_Shape], extent: Extent) -> npt.NDArray[np.float32]:
    """Paint the running speed of shapes sorted by drawing order.

    Symbols in a speed group (undergrowth, marsh, stony ground) lie on top of the
    vegetation: in each group the topmost one counts, and the slowest of the groups and
    the symbol below them sets the speed. Any other symbol replaces the speed below it,
    groups included, as a path does across a marsh.
    """
    timed = [s for s in shapes if s.rule.speed is not None]
    if not timed:
        return np.ones(extent.raster_shape(1), dtype=np.float32)
    orders = np.array([s.rule.order for s in timed])
    speeds = np.array([s.rule.speed for s in timed], dtype=np.float32)

    def topmost(group: str | None) -> npt.NDArray[np.int32]:
        """Index (in ``timed``) of the topmost shape of ``group`` in each cell, or -1."""
        pairs = [
            (s.geometry, i) for i, s in enumerate(timed) if s.rule.speed_group == group
        ]
        return _paint(pairs, extent, -1, np.int32)

    below = topmost(None)
    speed = np.where(below >= 0, speeds[below], np.float32(1.0))
    below_order = np.where(below >= 0, orders[below], np.iinfo(orders.dtype).min)
    for group in sorted(SPEED_GROUPS):
        top = topmost(group)
        cells = (top >= 0) & (orders[top] >= below_order)
        speed[cells] = np.minimum(speed[cells], speeds[top[cells]])
    return speed


def rasterize_map(
    features: Iterable[Mapping[str, Any]],
    symbols: SymbolSet,
    extent: Extent,
    map_area: Polygon,
    lettering: Sequence[BaseGeometry] = (),
) -> GroundLayers:
    """Paint the map's objects into ground layers.

    Args:
        features: The map's terrain objects (GeoJSON features with ``sym``).
        symbols: Meaning of the symbols.
        extent: World extent; the rasters have 1 m cells.
        map_area: Outline of the mapped area. Inside it the white map background
            means forest with easy running.
        lettering: Where the map's texts are. Holes left for them in areas are filled
            (LETTERING_HOLE_CORNERS).

    Returns:
        The ground layers.
    """
    shapes, clear_strips, unknown = _shapes(features, symbols, lettering)
    if unknown:
        log.info("Symbols without 3D meaning (ignored): %s", ", ".join(sorted(unknown)))

    in_map = _paint([(map_area, 1)], extent, 0, np.uint8).astype(bool)

    ground = _paint(
        [(map_area, int(Ground.FOREST))]
        + [
            (s.geometry, int(s.rule.ground))
            for s in shapes
            if s.rule.ground is not None and s.rule.track is None
        ],
        extent,
        int(Ground.UNKNOWN),
        np.uint8,
    )
    speed = _speed(shapes, extent)
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
