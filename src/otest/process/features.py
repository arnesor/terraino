"""3D objects for the map's point and line features: rocks, cliffs, walls, fences ..."""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from shapely import LineString, MultiLineString, MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry

from otest.ingest.georef import Extent
from otest.process.geometry import to_geometry
from otest.process.layers import GroundLayers
from otest.process.symbols import Ground, SymbolSet

LINE_STEP_M = 2.0
CLIFF_STEP_M = 1.5
CLIFF_PROBE_M = 3.5
MIN_CLIFF_DROP = {"cliff": 1.5, "rock_face": 0.8}
IMPASSABLE_BAND_M = 1.2
BOULDER_FIELD_M2_PER_STONE = 18.0


@dataclass(frozen=True)
class PointFeature:
    """An object at a point, in projected coordinates.

    Attributes:
        kind: Feature kind (see otest.process.symbols.FEATURES), or "stone".
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
    """An object along a line (wall, fence, power line), in projected coordinates."""

    kind: str
    coords: list[tuple[float, float]]
    size: float


@dataclass(frozen=True)
class CliffFace:
    """A rock face: matching top and bottom polylines as (easting, northing, height)."""

    kind: str
    top: list[tuple[float, float, float]]
    bottom: list[tuple[float, float, float]]


@dataclass
class Features:
    """All 3D features of a world."""

    points: list[PointFeature] = field(default_factory=list)
    lines: list[LineFeature] = field(default_factory=list)
    cliffs: list[CliffFace] = field(default_factory=list)


_DEFAULT_SIZE = {
    "boulder": 1.3,
    "boulder_cluster": 1.2,
    "boulder_field": 0.7,
    "stones": 0.3,
    "stone_wall": 0.9,
    "ruined_wall": 0.5,
    "fence": 1.2,
    "ruined_fence": 1.0,
    "tower": 4.0,
    "cairn": 1.2,
    "fodder_rack": 2.0,
    "ruin": 0.6,
    "power_line": 10.0,
    "pylon_line": 25.0,
}
_LINE_KINDS = {
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
        s = size * (0.8 + 0.4 * _rand(x + y, 1))
        return [PointFeature("boulder", x, y, s, _rand(x, 3) * 2 * math.pi)]
    if kind == "boulder_cluster":
        return _scatter("boulder", x, y, size, 4, 2.0 + size * 0.5)
    if kind == "boulder_field":
        return _scatter("boulder", x, y, size, 9, 6.0)
    if kind == "stones":
        return _scatter("stone", x, y, size, 5, 2.0)
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


class _Sampler:
    """Nearest-cell DTM lookup in projected coordinates."""

    def __init__(self, dtm: npt.NDArray[np.float32], extent: Extent) -> None:
        self.dtm = dtm
        self.extent = extent

    def __call__(self, x: float, y: float) -> float:
        row = int(np.clip(self.extent.y1 - y, 0, self.dtm.shape[0] - 1))
        col = int(np.clip(x - self.extent.x0, 0, self.dtm.shape[1] - 1))
        return float(self.dtm[row, col])


def measure_cliffs(
    cliff_lines: Iterable[tuple[str, LineString]],
    dtm: npt.NDArray[np.float32],
    extent: Extent,
) -> list[CliffFace]:
    """Build rock faces for cliff lines, falling to the lower side of each line.

    The map draws a cliff along its top edge. At each point the terrain model tells
    which side is lower and by how much; the face runs from the line down to there.
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

        top, bottom = [], []
        for (x, y), (nx, ny) in zip(coords, normals, strict=True):
            dx, dy = nx * side, ny * side
            h_top = max(height(x - dx * 0.8, y - dy * 0.8), height(x, y))
            bx, by = x + dx * CLIFF_PROBE_M * 0.6, y + dy * CLIFF_PROBE_M * 0.6
            h_bottom = min(
                height(bx, by), height(x + dx * CLIFF_PROBE_M, y + dy * CLIFF_PROBE_M)
            )
            # Map cliffs are at least this high, even where the terrain model smooths them.
            h_bottom = min(h_bottom, h_top - MIN_CLIFF_DROP[kind])
            top.append((x, y, h_top + 0.2))
            bottom.append((bx, by, h_bottom - 0.3))
        faces.append(CliffFace(kind, top, bottom))
    return faces


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
            blocked.append((line.buffer(IMPASSABLE_BAND_M / 2), 1))
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
