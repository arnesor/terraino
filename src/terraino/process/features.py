"""3D objects for the map's point and line features: rocks, cliffs, walls, fences ..."""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from scipy import ndimage
from shapely import (
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    STRtree,
    box,
    line_interpolate_point,
    line_locate_point,
)
from shapely import points as shapely_points
from shapely.affinity import rotate
from shapely.geometry.base import BaseGeometry

from terraino.ingest.georef import Extent
from terraino.process.geometry import to_geometry
from terraino.process.layers import GroundLayers
from terraino.process.symbols import Ground, SymbolSet
from terraino.process.tracks import Track

LINE_STEP_M = 2.0
CLIFF_STEP_M = 1.5
CLIFF_PROBE_M = 3.5
MIN_CLIFF_DROP = {"cliff": 1.5, "rock_face": 1.0}
# The rock face stands this far out from the map line, on the lower side.
CLIFF_FACE_M = 1.0
# Below the face the ground stays at the foot height for a short shelf, then rises back
# to the terrain model at this slope (talus).
CLIFF_SHELF_M = 0.5
CLIFF_FOOT_SLOPE = 0.6
CLIFF_FOOT_M = 4.0
# The drop tapers off over this distance at the ends of a cliff line.
CLIFF_TAPER_M = 2.0
IMPASSABLE_BAND_M = 1.2
WATERHOLE_DEPTH_M = 0.6
WATERHOLE_SPEED = 0.3
# Pits have steep sides: the bottom is this far below the rim, out to the pit's edge.
PIT_DEPTH_M = 1.0
# Knolls stand at least this high above the ground around them (ISOM: at least 1 m). A
# 1 m terrain model smooths small knolls into faint humps, so they are raised to it.
KNOLL_HEIGHT_M = 1.0
# An elongated knoll is this many times longer than it is wide.
KNOLL_ELONGATION = 2.0
# Small depressions are dug at least this deep below the ground around them (ISOM: at
# least 1 m), as a bowl with gentle sides; the terrain model shows most of them faintly.
SMALL_DEPRESSION_DEPTH_M = 1.0
# Earth walls are a rounded ridge this wide at the base, as high as their size (ISOM: at
# least 1 m) above the ground on both sides; the terrain model shows most of them faintly.
# viewer/src/placement.ts puts flags at the foot, half this width from the line.
EARTH_WALL_WIDTH_M = 4.0
# The ground around a knoll or small depression, which it rises from or sinks into, is
# measured on a ring this wide.
LANDFORM_RIM_M = 2.0
# Closed contour rings up to this size are knolls drawn with contours (or depressions).
CONTOUR_KNOLL_MAX_M2 = 1500.0
# A contour line whose ends are this close is a closed ring.
RING_CLOSED_M = 1.0
# Ground this close to the shape of a knoll, small depression or earth wall is near
# enough already.
LANDFORM_TOLERANCE_M = 0.01
# Masts this close to a power line are its poles; a line running on this far beyond its
# first or last mast gets an end pole; gaps longer than MAX_GAP_SPACINGS times the usual
# spacing get poles in between.
POLE_SNAP_M = 3.0
POLE_END_GAP_M = 20.0
MAX_GAP_SPACINGS = 2.5
POLE_SPACING_M = {"power_line": 60.0, "pylon_line": 250.0}
# Lamp posts stand this far from the edge of the road or path they light, if one is
# within LAMP_POST_REACH_M: the map draws them farther out, beside the track's symbol.
LAMP_POST_EDGE_M = (1.0, 2.0)
LAMP_POST_REACH_M = 15.0
_LIT_TRACKS = frozenset(
    {"paved", "gravel", "vehicle_track", "path", "small_path", "faint_path"}
)
BOULDER_FIELD_M2_PER_STONE = 18.0


@dataclass(frozen=True)
class PointFeature:
    """An object at a point, in projected coordinates.

    Attributes:
        kind: Feature kind (see terraino.process.symbols.FEATURES), or "stone".
        x: Easting.
        y: Northing.
        size: Size in metres.
        angle: Rotation in radians, counter-clockwise from east.
    """

    kind: str
    x: float
    y: float
    size: float
    angle: float = 0.0


@dataclass(frozen=True)
class LineFeature:
    """An object along a line (wall, fence, power line), in projected coordinates.

    Attributes:
        kind: Feature kind.
        coords: The line.
        size: Height in metres.
        poles: Where the poles of a power line stand, in order along it; empty if
            unknown (the viewer then spaces them evenly).
    """

    kind: str
    coords: list[tuple[float, float]]
    size: float
    poles: tuple[tuple[float, float], ...] = ()


@dataclass(frozen=True)
class CliffFace:
    """A rock face: matching top and bottom polylines as (easting, northing, height).

    The top runs along the map's cliff line, at the ground height there; the bottom is
    ``CLIFF_FACE_M`` out on the lower side, at the ground height at the foot of the face.
    ``carve_cliffs`` shapes the terrain model to match.
    """

    kind: str
    top: list[tuple[float, float, float]]
    bottom: list[tuple[float, float, float]]


@dataclass
class Features:
    """All 3D features of a world.

    Boulders' sizes are their least height above the ground around them; a
    waterhole's, a pit's, a small depression's and a knoll's size is its diameter (an
    elongated knoll's, its width).
    """

    points: list[PointFeature] = field(default_factory=list)
    lines: list[LineFeature] = field(default_factory=list)
    cliffs: list[CliffFace] = field(default_factory=list)


# Boulders: their least height above the ground (ISOM: a boulder is at least 1 m high,
# a large boulder 2 m). Waterholes, pits, small depressions and knolls: their diameter.
_DEFAULT_SIZE = {
    "boulder": 1.0,
    "boulder_cluster": 1.0,
    "waterhole": 4.0,
    "pit": 2.0,
    "small_depression": 8.0,
    "knoll": 10.0,
    "elongated_knoll": 8.0,
    "earth_wall": 1.0,
    "vegetation_boundary": 0.0,
    "boulder_field": 0.7,
    "stones": 0.3,
    "stone_wall": 0.9,
    "ruined_wall": 0.5,
    "fence": 1.2,
    "ruined_fence": 1.0,
    "tower": 4.0,
    "lamp_post": 6.0,
    "cairn": 1.2,
    "fodder_rack": 2.0,
    "ant_hill": 1.0,
    "picnic_table": 1.8,
    "ruin": 0.6,
    "power_line": 10.0,
    "pylon_line": 25.0,
}
_LINE_KINDS = {
    "earth_wall",
    "vegetation_boundary",
    "stone_wall",
    "ruined_wall",
    "fence",
    "ruined_fence",
    "power_line",
    "pylon_line",
    "ruin",
}


def _rand(seed: float, salt: int) -> float:
    """Deterministic pseudo-random number in [0, 1) from a coordinate."""
    h = math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
    return h - math.floor(h)


def _scatter(
    kind: str, x: float, y: float, size: float, count: int, radius: float
) -> list[PointFeature]:
    out = []
    for i in range(count):
        a = _rand(x + y, 2 * i) * 2 * math.pi
        r = radius * math.sqrt(_rand(x - y, 2 * i + 1))
        s = size * (0.55 + 0.6 * _rand(x * 0.7 + y, i + 50))
        out.append(PointFeature(kind, x + r * math.cos(a), y + r * math.sin(a), s, a))
    return out


def _expand_point(
    kind: str, point: Point, size: float, angle: float
) -> list[PointFeature]:
    """Turn a map point symbol into one or more objects."""
    x, y = point.x, point.y
    if kind == "boulder":
        # At least the symbol's height, often a little more.
        s = size * (1.0 + 0.5 * _rand(x + y, 1) ** 2)
        return [PointFeature("boulder", x, y, s, _rand(x, 3) * 2 * math.pi)]
    if kind == "boulder_cluster":
        # Boulders of the cluster are boulders too: at least the symbol's height.
        cluster = _scatter("boulder", x, y, size, 4, 2.0 + size * 0.5)
        return [
            replace(b, size=size * (1.0 + 0.4 * _rand(b.x + b.y, 7))) for b in cluster
        ]
    if kind == "boulder_field":
        return _scatter("boulder", x, y, size, 9, 6.0)
    if kind == "stones":
        return _scatter("stone", x, y, size, 5, 2.0)
    if kind == "ant_hill":
        # Its height: the symbol's, give or take a fifth.
        s = size * (0.8 + 0.4 * _rand(x + y, 5))
        return [PointFeature("ant_hill", x, y, s, _rand(x, 6) * 2 * math.pi)]
    if kind == "picnic_table":
        # The map's symbol is a cross, whose angle says nothing about the table's.
        return [PointFeature(kind, x, y, size, _rand(x + y, 8) * 2 * math.pi)]
    return [PointFeature(kind, x, y, size, angle)]


def _boulder_field_area(polygon: Polygon, size: float) -> list[PointFeature]:
    count = max(1, round(polygon.area / BOULDER_FIELD_M2_PER_STONE))
    minx, miny, maxx, maxy = polygon.bounds
    out: list[PointFeature] = []
    i = 0
    while len(out) < count and i < count * 20:
        x = minx + _rand(minx + i, 7) * (maxx - minx)
        y = miny + _rand(miny - i, 9) * (maxy - miny)
        i += 1
        if polygon.contains(Point(x, y)):
            s = size * (0.5 + 0.7 * _rand(x + y, 11))
            out.append(PointFeature("boulder", x, y, s, _rand(x, 13) * 2 * math.pi))
    return out


# Side in metres of a ruin drawn as a point symbol, when its rule gives no width.
_POINT_RUIN_SIDE = 4.0


def _point_ruin(point: Point, side: float, angle: float) -> Polygon:
    """The square outline of a ruin drawn as a point, turned by the symbol's angle.

    Examples:
        >>> ruin = _point_ruin(Point(10, 20), 4.0, 0.0)
        >>> ruin.bounds
        (8.0, 18.0, 12.0, 22.0)
        >>> round(_point_ruin(Point(0, 0), 4.0, math.radians(45)).bounds[2], 2)
        2.83
    """
    half = side / 2
    square = box(point.x - half, point.y - half, point.x + half, point.y + half)
    return rotate(square, angle, origin=point, use_radians=True)


def _lines(geometry: BaseGeometry) -> list[LineString]:
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return list(geometry.geoms)
    if isinstance(geometry, Polygon):
        return [LineString(geometry.exterior.coords)]
    if isinstance(geometry, MultiPolygon):
        return [LineString(p.exterior.coords) for p in geometry.geoms]
    return []


def collect_features(
    omap_features: Iterable[Mapping[str, Any]], symbols: SymbolSet
) -> tuple[Features, list[tuple[str, LineString]]]:
    """Collect the map's 3D features; cliff lines are returned separately for measuring.

    Returns:
        The point and line features, and ``(kind, line)`` for cliffs and rock faces.
    """
    features = Features()
    cliff_lines: list[tuple[str, LineString]] = []
    for f in omap_features:
        rule = symbols.rule(f["properties"]["sym"])
        if rule is None or rule.feature is None:
            continue
        geometry = to_geometry(f.get("geometry"))
        if geometry is None:
            continue
        kind = rule.feature
        size = rule.size or _DEFAULT_SIZE.get(kind, 1.0)
        angle = math.radians(float(f["properties"].get("ang", 0.0)))
        if kind == "ruin" and isinstance(geometry, Point):
            # A ruin too small to draw to scale: a square of the rule's width.
            geometry = _point_ruin(geometry, rule.width or _POINT_RUIN_SIDE, angle)
        if kind in ("cliff", "rock_face"):
            cliff_lines.extend((kind, line) for line in _lines(geometry))
        elif kind in _LINE_KINDS:
            for line in _lines(geometry):
                dense = line.segmentize(LINE_STEP_M)
                coords = [(float(x), float(y)) for x, y in dense.coords]
                features.lines.append(LineFeature(kind, coords, size))
        elif isinstance(geometry, Point):
            features.points.extend(_expand_point(kind, geometry, size, angle))
        elif kind == "footbridge" and isinstance(geometry, LineString):
            mid = geometry.interpolate(0.5, normalized=True)
            (x0, y0), (x1, y1) = geometry.coords[0], geometry.coords[-1]
            features.points.append(
                PointFeature(
                    "footbridge",
                    mid.x,
                    mid.y,
                    geometry.length,
                    math.atan2(y1 - y0, x1 - x0),
                )
            )
        elif isinstance(geometry, Polygon | MultiPolygon):
            polygons = (
                [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
            )
            for polygon in polygons:
                if kind == "boulder_field":
                    features.points.extend(_boulder_field_area(polygon, size))
                else:
                    centre = polygon.representative_point()
                    features.points.extend(_expand_point(kind, centre, size, angle))
    return features, cliff_lines


# Rocks (after _expand_point): mapped next to a building, or a building drawn with a
# rock symbol that looks alike (black areas), they must not stand in its walls.
_ROCK_KINDS = frozenset({"boulder", "stone"})


def drop_rocks_in_buildings(features: Features, footprints: Sequence[Polygon]) -> int:
    """Remove rocks that would stand in a building's walls; return how many.

    Examples:
        >>> from shapely import box
        >>> found = Features(points=[PointFeature("boulder", 5, 5, 3.0),
        ...                          PointFeature("boulder", 20, 5, 3.0)])
        >>> drop_rocks_in_buildings(found, [box(0, 0, 10, 10)])
        1
        >>> [p.x for p in found.points]
        [20]
    """
    tree = STRtree(list(footprints))
    kept = []
    for p in features.points:
        if p.kind in _ROCK_KINDS and len(
            tree.query(Point(p.x, p.y), predicate="dwithin", distance=p.size / 2)
        ):
            continue
        kept.append(p)
    dropped = len(features.points) - len(kept)
    features.points = kept
    return dropped


# A ruin that shares more than this much ground (m²) with a building is left out.
_RUIN_OVERLAP_M2 = 1.0


def drop_ruins_in_buildings(features: Features, footprints: Sequence[Polygon]) -> int:
    """Remove ruins that overlap a building; return how many.

    The building data is newer than the map: a building standing on a ruin has been
    built since, or the ruin is drawn where the building is.

    Examples:
        >>> from shapely import box
        >>> ring = [(0, 0), (8, 0), (8, 8), (0, 8), (0, 0)]
        >>> found = Features(lines=[LineFeature("ruin", ring, 0.6),
        ...     LineFeature("ruin", [(x + 20, y) for x, y in ring], 0.6)])
        >>> drop_ruins_in_buildings(found, [box(6, 2, 12, 6)])
        1
        >>> [line.coords[0] for line in found.lines]
        [(20, 0)]
    """
    tree = STRtree(list(footprints))
    kept = []
    for line in features.lines:
        if line.kind == "ruin" and len(line.coords) >= 4:
            ruin = Polygon(line.coords)
            if ruin.is_valid and any(
                ruin.intersection(footprints[i]).area > _RUIN_OVERLAP_M2
                for i in tree.query(ruin, predicate="intersects")
            ):
                continue
        kept.append(line)
    dropped = len(features.lines) - len(kept)
    features.lines = kept
    return dropped


class _Sampler:
    """Nearest-cell DTM lookup in projected coordinates."""

    def __init__(self, dtm: npt.NDArray[np.float32], extent: Extent) -> None:
        self.dtm = dtm
        self.extent = extent

    def __call__(self, x: float, y: float) -> float:
        row = int(np.clip(self.extent.y1 - y, 0, self.dtm.shape[0] - 1))
        col = int(np.clip(x - self.extent.x0, 0, self.dtm.shape[1] - 1))
        return float(self.dtm[row, col])


def _disc(
    p: PointFeature, extent: Extent, shape: tuple[int, ...], reach: int
) -> tuple[slice, slice, npt.NDArray[np.float64], npt.NDArray[np.float64]] | None:
    """The cells within ``reach`` of ``p``, and how far east and north of it each is."""
    col = int(p.x - extent.x0)
    row = int(extent.y1 - p.y)
    r0, r1 = max(row - reach, 0), min(row + reach + 1, shape[0])
    c0, c1 = max(col - reach, 0), min(col + reach + 1, shape[1])
    if r0 >= r1 or c0 >= c1:
        return None
    rows, cols = np.mgrid[r0:r1, c0:c1]
    east = extent.x0 + cols + 0.5 - p.x
    north = extent.y1 - rows - 0.5 - p.y
    return slice(r0, r1), slice(c0, c1), east, north


def _rim(
    ground: npt.NDArray[np.float32], d: npt.NDArray[np.float64], radius: float
) -> npt.NDArray[np.float32]:
    """Ground heights on the ring just outside ``radius``."""
    ring = (d >= radius) & (d <= radius + 1)
    return ground[ring] if ring.any() else ground.ravel()


def carve_waterholes(
    dtm: npt.NDArray[np.float32],
    layers: GroundLayers,
    points: Iterable[PointFeature],
    extent: Extent,
) -> None:
    """Dig a shallow pit for each waterhole and mark its ground as water.

    The pit is a bowl WATERHOLE_DEPTH_M deep below the ground at its rim; the viewer
    fills it with water to just below the rim. Nothing grows in it.

    Examples:
        >>> from terraino.process.layers import GroundLayers
        >>> dtm = np.full((20, 20), 100.0, dtype=np.float32)
        >>> z = np.zeros((20, 20), dtype=np.float32)
        >>> layers = GroundLayers(ground=np.ones((20, 20), np.uint8), speed=z + 1,
        ...     young=z, thicket=z, shrubs=z,
        ...     tree_rule=np.zeros((20, 20), np.uint8),
        ...     clear=z > 0, in_map=z == 0)
        >>> carve_waterholes(dtm, layers, [PointFeature("waterhole", 10, 10, 4.0)],
        ...                  Extent(0, 0, 20, 20))
        >>> round(float(dtm[10, 10]), 2), float(dtm[10, 16]), int(layers.ground[10, 10])
        (99.47, 100.0, 10)
    """
    for p in points:
        if p.kind != "waterhole":
            continue
        radius = p.size / 2
        disc = _disc(p, extent, dtm.shape, math.ceil(radius + 1))
        if disc is None:
            continue
        rows, cols, east, north = disc
        d = np.hypot(east, north)
        ground = dtm[rows, cols]
        rim = float(np.median(_rim(ground, d, radius)))
        inside = d < radius
        bowl = rim - WATERHOLE_DEPTH_M * (1 - (d / max(radius, 0.1)) ** 2)
        ground[inside] = np.minimum(ground[inside], bowl[inside])
        # Water under the pond's surface; no trees on its banks either.
        layers.ground[rows, cols][d < radius * 0.75] = Ground.WATER
        layers.speed[rows, cols][inside] = WATERHOLE_SPEED
        layers.clear[rows, cols][d < radius + 0.5] = True


def carve_pits(
    dtm: npt.NDArray[np.float32],
    layers: GroundLayers,
    points: Iterable[PointFeature],
    extent: Extent,
) -> None:
    """Dig each pit into the terrain model, with steep sides, and keep trees out of it.

    The ground within the pit's radius drops to PIT_DEPTH_M below the lowest point of
    its rim, or stays where the terrain model is already deeper: on a slope too, the
    pit is at least that deep all round. On the 1 m grid the sides are as steep as the
    grid allows.

    Examples:
        >>> from terraino.process.layers import GroundLayers
        >>> dtm = np.full((20, 20), 100.0, dtype=np.float32)
        >>> z = np.zeros((20, 20), dtype=np.float32)
        >>> layers = GroundLayers(ground=np.ones((20, 20), np.uint8), speed=z + 1,
        ...     young=z, thicket=z, shrubs=z,
        ...     tree_rule=np.zeros((20, 20), np.uint8),
        ...     clear=z > 0, in_map=z == 0)
        >>> carve_pits(dtm, layers, [PointFeature("pit", 10, 10, 2.0)],
        ...            Extent(0, 0, 20, 20))
        >>> [float(h) for h in dtm[8:12, 9]]  # north to south, just west of the centre
        [100.0, 99.0, 99.0, 100.0]
        >>> bool(layers.clear[9, 9]), bool(layers.clear[9, 13])
        (True, False)
    """
    for p in points:
        if p.kind != "pit":
            continue
        radius = p.size / 2
        disc = _disc(p, extent, dtm.shape, math.ceil(radius + 1))
        if disc is None:
            continue
        rows, cols, east, north = disc
        d = np.hypot(east, north)
        ground = dtm[rows, cols]
        bottom = float(_rim(ground, d, radius).min()) - PIT_DEPTH_M
        inside = d < radius
        ground[inside] = np.minimum(ground[inside], bottom)
        layers.clear[rows, cols][d < radius + 0.5] = True


def dig_small_depressions(
    dtm: npt.NDArray[np.float32],
    points: Iterable[PointFeature],
    extent: Extent,
) -> int:
    """Make the map's small depressions at least SMALL_DEPRESSION_DEPTH_M deep.

    A small depression is a round bowl of its size across, with gentle sides: its
    middle is SMALL_DEPRESSION_DEPTH_M below the ground around it, fitted as a plane, so
    on a slope it sinks into the slope. The ground is only lowered, never raised: where
    the terrain model shows a depression deep enough, it stays as it is. Trees grow in
    it as around it.

    Returns:
        The number of small depressions that lowered the ground.

    Examples:
        >>> dtm = np.full((20, 20), 100.0, dtype=np.float32)
        >>> hollow = PointFeature("small_depression", 10, 10, 8.0)
        >>> dig_small_depressions(dtm, [hollow], Extent(0, 0, 20, 20))
        1
        >>> round(float(dtm.min()), 2), float(dtm[10, 15])  # 1 m deep, 8 m across
        (99.08, 100.0)
        >>> dig_small_depressions(dtm, [hollow], Extent(0, 0, 20, 20))  # deep enough
        0
    """
    dug = 0
    for p in points:
        if p.kind != "small_depression":
            continue
        radius = max(p.size / 2, 0.5)
        disc = _disc(p, extent, dtm.shape, math.ceil(radius + LANDFORM_RIM_M))
        if disc is None:
            continue
        rows, cols, east, north = disc
        rho = np.hypot(east, north) / radius
        rim = (rho >= 1) & (rho <= 1 + LANDFORM_RIM_M / radius)
        ground = dtm[rows, cols]
        plane = _ground_plane(ground, east, north, rim)
        if plane is None:
            continue
        bowl = plane - SMALL_DEPRESSION_DEPTH_M * 0.5 * (1 + np.cos(np.pi * rho))
        lower = (rho < 1) & (bowl < ground - LANDFORM_TOLERANCE_M)
        ground[lower] = bowl[lower]
        dug += bool(lower.any())
    return dug


_KNOLL_KINDS = frozenset({"knoll", "elongated_knoll"})


def contour_rings(
    omap_features: Iterable[Mapping[str, Any]], symbols: SymbolSet
) -> list[Polygon]:
    """Small closed rings of the map's contours and form lines: knolls or depressions.

    Examples:
        >>> isom = SymbolSet.load("isom2000")
        >>> ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.5]]
        >>> line = {"type": "LineString", "coordinates": ring}
        >>> big = {"type": "LineString", "coordinates": [[0, 0], [99, 0], [99, 99], [0, 99], [0, 0]]}
        >>> rings = contour_rings([{"geometry": line, "properties": {"sym": "103.0"}},
        ...                        {"geometry": big, "properties": {"sym": "101.0"}}], isom)
        >>> [ring.area for ring in rings]
        [100.0]
    """
    rings = []
    for f in omap_features:
        rule = symbols.rule(f["properties"]["sym"])
        if rule is None or rule.feature != "contour":
            continue
        geometry = to_geometry(f.get("geometry"))
        if geometry is None:
            continue
        for line in _lines(geometry):
            coords = list(line.coords)
            if (
                len(coords) < 4
                or Point(coords[0]).distance(Point(coords[-1])) > RING_CLOSED_M
            ):
                continue
            ring = Polygon(coords)
            if ring.is_valid and 0 < ring.area <= CONTOUR_KNOLL_MAX_M2:
                rings.append(ring)
    return rings


def _ground_plane(
    ground: npt.NDArray[np.float32],
    east: npt.NDArray[np.float64],
    north: npt.NDArray[np.float64],
    rim: npt.NDArray[np.bool_],
) -> npt.NDArray[np.float64] | None:
    """The ground on the ``rim`` cells as a plane, over the whole window."""
    if rim.sum() < 3:
        return None
    a = np.column_stack([np.ones(int(rim.sum())), east[rim], north[rim]])
    coef = np.linalg.lstsq(a, ground[rim].astype(np.float64), rcond=None)[0]
    plane: npt.NDArray[np.float64] = coef[0] + coef[1] * east + coef[2] * north
    return plane


def _raise_point_knoll(
    dtm: npt.NDArray[np.float32], p: PointFeature, extent: Extent
) -> bool:
    half_width = p.size / 2
    half_length = half_width * (KNOLL_ELONGATION if p.kind == "elongated_knoll" else 1)
    disc = _disc(p, extent, dtm.shape, math.ceil(half_length + LANDFORM_RIM_M))
    if disc is None:
        return False
    rows, cols, east, north = disc
    # The symbol's angle is across an elongated knoll: in the terrain models of the
    # test maps, its long axis is at right angles to it.
    ux, uy = -math.sin(p.angle), math.cos(p.angle)
    along = east * ux + north * uy
    across = north * ux - east * uy
    rho = np.hypot(along / half_length, across / half_width)
    rim = (rho >= 1) & (rho <= 1 + LANDFORM_RIM_M / half_width)
    ground = dtm[rows, cols]
    # On a slope the knoll rises from the slope.
    plane = _ground_plane(ground, east, north, rim)
    if plane is None:
        return False
    inside = rho < 1
    bump = plane + KNOLL_HEIGHT_M * 0.5 * (1 + np.cos(np.pi * rho))
    higher = inside & (bump > ground + LANDFORM_TOLERANCE_M)
    ground[higher] = bump[higher]
    return bool(higher.any())


def _raise_ring_knoll(
    dtm: npt.NDArray[np.float32], ring: Polygon, extent: Extent
) -> bool:
    x0, y0, x1, y1 = ring.bounds
    c0 = max(math.floor(x0 - extent.x0) - 1, 0)
    c1 = min(math.ceil(x1 - extent.x0) + 1, dtm.shape[1])
    r0 = max(math.floor(extent.y1 - y1) - 1, 0)
    r1 = min(math.ceil(extent.y1 - y0) + 1, dtm.shape[0])
    if r0 >= r1 or c0 >= c1:
        return False
    window = Extent(extent.x0 + c0, extent.y1 - r1, extent.x0 + c1, extent.y1 - r0)
    inside = rasterize(
        [(ring, 1)],
        out_shape=(r1 - r0, c1 - c0),
        transform=window.raster_transform(1),
        fill=0,
        dtype=np.uint8,
    ).astype(bool)
    if not inside.any():
        return False
    sample = _Sampler(dtm, extent)
    boundary = ring.exterior
    steps = max(int(boundary.length), 4)
    points = (boundary.interpolate(i / steps, normalized=True) for i in range(steps))
    line = float(np.median([sample(q.x, q.y) for q in points]))
    ground = dtm[r0:r1, c0:c1]
    if float(ground[inside].mean()) <= line:
        return False  # lower inside: a depression
    # Up from the contour line to KNOLL_HEIGHT_M above it in the middle.
    depth = ndimage.distance_transform_edt(inside)
    t = depth / depth.max()
    bump = line + KNOLL_HEIGHT_M * (1 - (1 - t) ** 2)
    higher = inside & (bump > ground + LANDFORM_TOLERANCE_M)
    ground[higher] = bump[higher]
    return bool(higher.any())


def raise_knolls(
    dtm: npt.NDArray[np.float32],
    points: Iterable[PointFeature],
    rings: Iterable[Polygon],
    extent: Extent,
) -> tuple[int, int]:
    """Make the map's knolls at least KNOLL_HEIGHT_M high in the terrain model.

    A small knoll is a round bump of its size across, an elongated knoll an oval
    KNOLL_ELONGATION times as long as wide; each stands KNOLL_HEIGHT_M above the ground
    around it. A knoll drawn with a contour ring rises KNOLL_HEIGHT_M above the ring's
    line in its middle; a ring around lower ground (a depression) is left alone. The
    ground is only raised, never lowered: where the terrain model shows a knoll high
    enough, it stays as it is.

    Returns:
        The numbers of knoll symbols and of contour rings that raised the ground.

    Examples:
        >>> dtm = np.full((40, 40), 100.0, dtype=np.float32)
        >>> dtm[26:34, 26:34] = 100.2  # a faint knoll inside a contour ring
        >>> extent = Extent(0, 0, 40, 40)
        >>> knoll = PointFeature("knoll", 10, 30, 10.0)
        >>> raise_knolls(dtm, [knoll], [box(25, 5, 35, 15)], extent)
        (1, 1)
        >>> round(float(dtm[:20, :20].max()), 2), float(dtm[10, 16])  # 1 m high, 10 m across
        (100.95, 100.0)
        >>> round(float(dtm[30, 30]), 2), float(dtm[30, 24])  # the ring's knoll
        (101.0, 100.0)
        >>> raise_knolls(dtm, [knoll], [], extent)  # high enough already
        (0, 0)
    """
    knolls = sum(
        _raise_point_knoll(dtm, p, extent) for p in points if p.kind in _KNOLL_KINDS
    )
    raised_rings = sum(_raise_ring_knoll(dtm, ring, extent) for ring in rings)
    return knolls, raised_rings


def _raise_earth_wall(
    dtm: npt.NDArray[np.float32],
    reference: npt.NDArray[np.float32],
    wall: LineFeature,
    extent: Extent,
) -> bool:
    if len(wall.coords) < 2:
        return False
    line = LineString(wall.coords)
    half = EARTH_WALL_WIDTH_M / 2
    x0, y0, x1, y1 = line.buffer(half).bounds
    c0 = max(math.floor(x0 - extent.x0), 0)
    c1 = min(math.ceil(x1 - extent.x0), dtm.shape[1])
    r0 = max(math.floor(extent.y1 - y1), 0)
    r1 = min(math.ceil(extent.y1 - y0), dtm.shape[0])
    if r0 >= r1 or c0 >= c1:
        return False
    rows, cols = np.mgrid[r0:r1, c0:c1]
    x = extent.x0 + cols + 0.5
    y = extent.y1 - rows - 0.5
    cells = shapely_points(x, y)
    t = line_locate_point(line, cells)
    nearest = np.array([(q.x, q.y) for q in line_interpolate_point(line, t.ravel())])
    nx, ny = nearest[:, 0].reshape(t.shape), nearest[:, 1].reshape(t.shape)
    d = np.hypot(x - nx, y - ny)
    inside = d < half
    if not inside.any():
        return False

    # The ground on both sides, just beyond the foot, every metre along the wall.
    stations = np.linspace(0, line.length, max(math.ceil(line.length), 1) + 1)
    sx, sy, ux, uy = _stations(line, stations)
    beyond = np.arange(half + 0.5, half + LANDFORM_RIM_M + 0.01, 0.5)

    # Left of the wall is the normal (-uy, ux), right of it (uy, -ux).
    def side(sign: float) -> npt.NDArray[np.float64]:
        px = sx[:, None] - sign * uy[:, None] * beyond
        py = sy[:, None] + sign * ux[:, None] * beyond
        heights = ndimage.map_coordinates(
            reference,
            [extent.y1 - py - 0.5, px - extent.x0 - 0.5],
            order=1,
            mode="nearest",
        )
        return np.asarray(np.median(heights, axis=1), dtype=np.float64)

    left, right = side(1.0), side(-1.0)
    # Across the wall the ground is a straight line from one side to the other; the
    # top is the wall's size above it.
    mid = (np.interp(t, stations, left) + np.interp(t, stations, right)) / 2
    tilt = (np.interp(t, stations, left) - np.interp(t, stations, right)) / 2
    tx, ty = np.interp(t, stations, ux), np.interp(t, stations, uy)
    across = (y - ny) * tx - (x - nx) * ty  # positive on the left
    reach = half + LANDFORM_RIM_M / 2
    base = mid + tilt * np.clip(across / reach, -1, 1)
    ridge = base + wall.size * 0.5 * (1 + np.cos(np.pi * d / half))
    ground = dtm[r0:r1, c0:c1]
    higher = inside & (ridge > ground + LANDFORM_TOLERANCE_M)
    ground[higher] = ridge[higher]
    return bool(higher.any())


def _stations(
    line: LineString, along: npt.NDArray[np.float64]
) -> tuple[
    npt.NDArray[np.float64],
    npt.NDArray[np.float64],
    npt.NDArray[np.float64],
    npt.NDArray[np.float64],
]:
    """Points at the distances ``along`` the line, and the unit direction there."""
    at = np.array([(q.x, q.y) for q in line_interpolate_point(line, along)])
    ahead = np.array(
        [
            (q.x, q.y)
            for q in line_interpolate_point(line, np.minimum(along + 0.5, line.length))
        ]
    )
    behind = np.array(
        [(q.x, q.y) for q in line_interpolate_point(line, np.maximum(along - 0.5, 0))]
    )
    step = ahead - behind
    norm = np.maximum(np.hypot(step[:, 0], step[:, 1]), 1e-9)
    return at[:, 0], at[:, 1], step[:, 0] / norm, step[:, 1] / norm


def raise_earth_walls(
    dtm: npt.NDArray[np.float32],
    lines: Iterable[LineFeature],
    extent: Extent,
) -> int:
    """Raise each earth wall to its size above the ground on both sides of it.

    An earth wall is a rounded ridge EARTH_WALL_WIDTH_M wide at the base along its map
    line, with rounded ends. Across it the ground is taken as a straight line between
    the ground just beyond its foot on either side, so on a slope it rises from the
    slope; its top is the wall's size above the middle of that line. The ground is only
    raised, never lowered: where the terrain model shows the wall high enough, it stays
    as it is.

    Returns:
        The number of earth walls that raised the ground.

    Examples:
        >>> dtm = np.full((20, 40), 100.0, dtype=np.float32)
        >>> wall = LineFeature("earth_wall", [(5.0, 10.0), (35.0, 10.0)], 1.0)
        >>> raise_earth_walls(dtm, [wall], Extent(0, 0, 40, 20))
        1
        >>> [round(float(h), 2) for h in dtm[7:14, 20]]  # north to south: 4 m wide
        [100.0, 100.15, 100.85, 100.85, 100.15, 100.0, 100.0]
        >>> raise_earth_walls(dtm, [wall], Extent(0, 0, 40, 20))  # high enough
        0
    """
    reference = dtm.copy()
    return sum(
        _raise_earth_wall(dtm, reference, wall, extent)
        for wall in lines
        if wall.kind == "earth_wall"
    )


def stand_lamp_posts(features: Features, tracks: Sequence[Track]) -> int:
    """Move each lamp post beside the road or path it lights.

    The map draws lamp posts a few metres out from the track, so the symbols do not
    cover it. Each one with a road or path within LAMP_POST_REACH_M moves straight
    across to stand LAMP_POST_EDGE_M from its edge (a distance of its own, the same in
    every build), on the side the map draws it, and faces the track: its angle points
    from the post to the track.

    Returns:
        The number of lamp posts moved.

    Examples:
        >>> path = Track("path", 2.0, [(0.0, 0.0), (100.0, 0.0)])
        >>> features = Features(points=[PointFeature("lamp_post", 40, 7, 6.0),
        ...                             PointFeature("lamp_post", 60, 40, 6.0)])
        >>> stand_lamp_posts(features, [path])
        1
        >>> near, far = features.points
        >>> near.x, 2.0 <= near.y <= 3.0, round(math.degrees(near.angle))
        (40.0, True, -90)
        >>> far.y  # no path within 15 m
        40
    """
    lit = [LineString(t.coords) for t in tracks if t.kind in _LIT_TRACKS]
    widths = [t.width for t in tracks if t.kind in _LIT_TRACKS]
    lit_tracks = [
        (line, width)
        for line, width in zip(lit, widths, strict=True)
        if line.length > 0
    ]
    if not lit_tracks:
        return 0
    tree = STRtree([line for line, _ in lit_tracks])
    moved = 0
    for i, p in enumerate(features.points):
        if p.kind != "lamp_post":
            continue
        here = Point(p.x, p.y)
        found = tree.query_nearest(here, max_distance=LAMP_POST_REACH_M)
        if not len(found):
            continue
        line, width = lit_tracks[int(found[0])]
        along = line.project(here)
        foot = line.interpolate(along)
        ahead = line.interpolate(min(along + 0.5, line.length))
        behind = line.interpolate(max(along - 0.5, 0))
        tx, ty = ahead.x - behind.x, ahead.y - behind.y
        norm = math.hypot(tx, ty) or 1.0
        # The left of the track, looking along it; the side the map draws the post.
        nx, ny = -ty / norm, tx / norm
        side = 1.0 if (p.x - foot.x) * nx + (p.y - foot.y) * ny >= 0 else -1.0
        lo, hi = LAMP_POST_EDGE_M
        out = width / 2 + lo + (hi - lo) * _rand(p.x + p.y, 11)
        x, y = foot.x + side * nx * out, foot.y + side * ny * out
        features.points[i] = replace(
            p, x=x, y=y, angle=math.atan2(-side * ny, -side * nx)
        )
        moved += 1
    return moved


def place_poles(
    lines: Sequence[LineFeature], masts: Sequence[tuple[float, float]]
) -> list[LineFeature]:
    """Put the poles of power lines on the masts registered along them.

    Mappers draw power lines through their masts, so the masts within POLE_SNAP_M of a
    power line are its poles. Where the line runs on beyond its first or last mast, or
    two masts are far apart (masts missing), poles are added at even spacing.

    Examples:
        >>> line = LineFeature("power_line", [(0, 0), (300, 0)], 10.0)
        >>> masts = [(50.4, 0.6), (130, -0.2), (210, 0.3), (120, 9.0)]  # the last: another line
        >>> (placed,) = place_poles([line], masts)
        >>> [(round(x), round(y)) for x, y in placed.poles]
        [(0, 0), (50, 1), (130, 0), (210, 0), (300, 0)]
    """
    if not masts:
        return list(lines)
    tree = STRtree([Point(m) for m in masts])
    placed = []
    for line in lines:
        spacing = POLE_SPACING_M.get(line.kind)
        if spacing is None or len(line.coords) < 2:
            placed.append(line)
            continue
        path = LineString(line.coords)
        hits = tree.query(path, predicate="dwithin", distance=POLE_SNAP_M)
        own = sorted((path.project(Point(masts[i])), masts[i]) for i in hits)
        if not own:
            placed.append(line)
            continue
        anchors: list[tuple[float, tuple[float, float]]] = []
        if own[0][0] > POLE_END_GAP_M:
            anchors.append((0.0, line.coords[0]))
        anchors.extend(own)
        if path.length - own[-1][0] > POLE_END_GAP_M:
            anchors.append((path.length, line.coords[-1]))
        poles = [anchors[0][1]]
        for (d0, _), (d1, p1) in itertools.pairwise(anchors):
            gap = d1 - d0
            if gap > spacing * MAX_GAP_SPACINGS:
                n = round(gap / spacing)
                for k in range(1, n):
                    q = path.interpolate(d0 + gap * k / n)
                    poles.append((q.x, q.y))
            poles.append(p1)
        placed.append(
            replace(line, poles=tuple((float(x), float(y)) for x, y in poles))
        )
    return placed


def measure_cliffs(
    cliff_lines: Iterable[tuple[str, LineString]],
    dtm: npt.NDArray[np.float32],
    extent: Extent,
) -> list[CliffFace]:
    """Build rock faces for cliff lines, falling to the lower side of each line.

    The map draws a cliff along its top edge. At each point the terrain model tells
    which side is lower and by how much; the face drops from the line to there. A 1 m
    terrain model smooths cliffs into slopes, so each is at least ``MIN_CLIFF_DROP``
    high, tapering off at the ends of the line.
    """
    height = _Sampler(dtm, extent)
    faces = []
    for kind, line in cliff_lines:
        dense = line.segmentize(CLIFF_STEP_M)
        coords = list(dense.coords)
        if len(coords) < 2:
            continue
        # Decide the downhill side once per line, from the average over its points.
        left_minus_right = 0.0
        normals = []
        for i, (x, y) in enumerate(coords):
            xa, ya = coords[max(i - 1, 0)]
            xb, yb = coords[min(i + 1, len(coords) - 1)]
            length = math.hypot(xb - xa, yb - ya) or 1.0
            nx, ny = -(yb - ya) / length, (xb - xa) / length  # left normal
            normals.append((nx, ny))
            left = height(x + nx * CLIFF_PROBE_M, y + ny * CLIFF_PROBE_M)
            right = height(x - nx * CLIFF_PROBE_M, y - ny * CLIFF_PROBE_M)
            left_minus_right += left - right
        side = -1.0 if left_minus_right > 0 else 1.0  # direction of the lower side

        along = [0.0]
        for (xa, ya), (xb, yb) in itertools.pairwise(coords):
            along.append(along[-1] + math.hypot(xb - xa, yb - ya))
        top, bottom = [], []
        for (x, y), (nx, ny), d in zip(coords, normals, along, strict=True):
            dx, dy = nx * side, ny * side
            h_top = max(height(x - dx * 0.8, y - dy * 0.8), height(x, y))
            h_bottom = min(
                height(x + dx * CLIFF_PROBE_M * 0.6, y + dy * CLIFF_PROBE_M * 0.6),
                height(x + dx * CLIFF_PROBE_M, y + dy * CLIFF_PROBE_M),
            )
            # Map cliffs are at least this high, even where the terrain model smooths them.
            drop = max(h_top - h_bottom, MIN_CLIFF_DROP[kind])
            end = min(d, along[-1] - d)
            drop *= 0.35 + 0.65 * min(end / CLIFF_TAPER_M, 1.0)
            top.append((x, y, h_top))
            bottom.append((x + dx * CLIFF_FACE_M, y + dy * CLIFF_FACE_M, h_top - drop))
        faces.append(CliffFace(kind, top, bottom))
    return faces


def carve_cliffs(
    dtm: npt.NDArray[np.float32], faces: Iterable[CliffFace], extent: Extent
) -> None:
    """Shape the terrain model (in place) into a step under each rock face.

    On the upper side the ground at the map line is raised to the top of the face. On
    the lower side it drops straight to the foot of the face: on a 1 m grid a sloping
    drop would bury much of the face. The viewer covers the strip between the line and
    the face with the face's rock edge. Beyond the face and a short shelf, the ground
    rises back to the terrain model as talus.

    Examples:
        >>> dtm = np.full((20, 20), 100.0, dtype=np.float32)
        >>> face = CliffFace("cliff", [(2, 10, 100), (18, 10, 100)],
        ...                  [(2, 9, 98), (18, 9, 98)])
        >>> carve_cliffs(dtm, [face], Extent(0, 0, 20, 20))
        >>> [round(float(h), 1) for h in dtm[8:16, 10]]  # north to south across it
        [100.0, 100.0, 98.0, 98.0, 98.6, 99.2, 99.8, 100.0]
    """
    reach = CLIFF_FACE_M + CLIFF_FOOT_M
    for face in faces:
        top = np.array(face.top, dtype=np.float64)
        bottom = np.array(face.bottom, dtype=np.float64)
        if len(top) < 2:
            continue
        xs = np.concatenate([top[:, 0], bottom[:, 0]])
        ys = np.concatenate([top[:, 1], bottom[:, 1]])
        c0 = max(int(np.floor(xs.min() - reach - extent.x0)), 0)
        c1 = min(int(np.ceil(xs.max() + reach - extent.x0)), dtm.shape[1] - 1)
        r0 = max(int(np.floor(extent.y1 - ys.max() - reach)), 0)
        r1 = min(int(np.ceil(extent.y1 - ys.min() + reach)), dtm.shape[0] - 1)
        if c0 > c1 or r0 > r1:
            continue
        cols, rows = np.meshgrid(np.arange(c0, c1 + 1), np.arange(r0, r1 + 1))
        px = extent.x0 + cols + 0.5
        py = extent.y1 - rows - 0.5
        best = np.full(px.shape, np.inf)
        offset = np.zeros(px.shape)
        h_top = np.zeros(px.shape)
        h_bottom = np.zeros(px.shape)
        for i in range(len(top) - 1):
            ax, ay, at = top[i]
            bx, by, bt = top[i + 1]
            vx, vy = bx - ax, by - ay
            length2 = vx * vx + vy * vy or 1.0
            t = np.clip(((px - ax) * vx + (py - ay) * vy) / length2, 0.0, 1.0)
            qx, qy = ax + vx * t, ay + vy * t
            dist = np.hypot(px - qx, py - qy)
            # Unit vector to the lower side, from the face's bottom line.
            ox = (bottom[i, 0] - ax + bottom[i + 1, 0] - bx) / 2
            oy = (bottom[i, 1] - ay + bottom[i + 1, 1] - by) / 2
            norm = math.hypot(ox, oy) or 1.0
            closer = dist < best
            best = np.where(closer, dist, best)
            offset = np.where(closer, ((px - qx) * ox + (py - qy) * oy) / norm, offset)
            h_top = np.where(closer, at + (bt - at) * t, h_top)
            h_bottom = np.where(
                closer, bottom[i, 2] + (bottom[i + 1, 2] - bottom[i, 2]) * t, h_bottom
            )
        ground = dtm[r0 : r1 + 1, c0 : c1 + 1]
        # Lower side: the foot of the face, then the talus back up to the terrain.
        rise = np.maximum(offset - CLIFF_FACE_M - CLIFF_SHELF_M, 0.0)
        target = h_bottom + rise * CLIFF_FOOT_SLOPE
        lower = (offset > 0) & (offset <= reach) & (best <= reach)
        ground[lower] = np.minimum(ground[lower], target[lower])
        # Upper side: the edge is at the top of the face.
        upper = (offset <= 0) & (offset > -1.0) & (best < 1.0)
        edge = h_top + offset * 0.3
        ground[upper] = np.maximum(ground[upper], edge[upper])


def paint_cliffs(
    layers: GroundLayers, faces: Iterable[CliffFace], extent: Extent
) -> None:
    """Paint bare rock under rock faces, and make impassable cliffs impassable."""
    rock: list[tuple[BaseGeometry, int]] = []
    blocked: list[tuple[BaseGeometry, int]] = []
    for face in faces:
        outline = [(x, y) for x, y, _ in face.top] + [
            (x, y) for x, y, _ in face.bottom[::-1]
        ]
        polygon = Polygon(outline).buffer(0)
        if not polygon.is_empty:
            rock.append((polygon, 1))
        if face.kind == "cliff":
            line = LineString([(x, y) for x, y, _ in face.top])
            blocked.append((line.buffer(IMPASSABLE_BAND_M / 2).union(polygon), 1))
    shape = layers.ground.shape
    transform = extent.raster_transform(1)
    if rock:
        mask = rasterize(
            rock, out_shape=shape, transform=transform, fill=0, dtype=np.uint8
        )
        layers.ground[mask > 0] = Ground.ROCK
    if blocked:
        mask = rasterize(
            blocked, out_shape=shape, transform=transform, fill=0, dtype=np.uint8
        )
        layers.speed[mask > 0] = 0.0
