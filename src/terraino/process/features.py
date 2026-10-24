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
from shapely import LineString, MultiLineString, MultiPolygon, Point, Polygon, STRtree
from shapely.geometry.base import BaseGeometry

from terraino.ingest.georef import Extent
from terraino.process.geometry import to_geometry
from terraino.process.layers import GroundLayers
from terraino.process.symbols import Ground, SymbolSet

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
# Masts this close to a power line are its poles; a line running on this far beyond its
# first or last mast gets an end pole; gaps longer than MAX_GAP_SPACINGS times the usual
# spacing get poles in between.
POLE_SNAP_M = 3.0
POLE_END_GAP_M = 20.0
MAX_GAP_SPACINGS = 2.5
POLE_SPACING_M = {"power_line": 60.0, "pylon_line": 250.0}
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
    waterhole's size is its diameter.
    """

    points: list[PointFeature] = field(default_factory=list)
    lines: list[LineFeature] = field(default_factory=list)
    cliffs: list[CliffFace] = field(default_factory=list)


# Boulders: their least height above the ground (ISOM: a boulder is at least 1 m high,
# a large boulder 2 m). Waterholes: their diameter.
_DEFAULT_SIZE = {
    "boulder": 1.0,
    "boulder_cluster": 1.0,
    "waterhole": 4.0,
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
        ...     young=z, shrubs=z, tree_rule=np.zeros((20, 20), np.uint8),
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
        reach = math.ceil(radius + 1)
        col = int(p.x - extent.x0)
        row = int(extent.y1 - p.y)
        r0, r1 = max(row - reach, 0), min(row + reach + 1, dtm.shape[0])
        c0, c1 = max(col - reach, 0), min(col + reach + 1, dtm.shape[1])
        if r0 >= r1 or c0 >= c1:
            continue
        rows, cols = np.mgrid[r0:r1, c0:c1]
        d = np.hypot(extent.x0 + cols + 0.5 - p.x, extent.y1 - rows - 0.5 - p.y)
        ground = dtm[r0:r1, c0:c1]
        rim_cells = (d >= radius) & (d <= radius + 1)
        rim = (
            float(np.median(ground[rim_cells]))
            if rim_cells.any()
            else float(ground.min())
        )
        inside = d < radius
        bowl = rim - WATERHOLE_DEPTH_M * (1 - (d / max(radius, 0.1)) ** 2)
        ground[inside] = np.minimum(ground[inside], bowl[inside])
        # Water under the pond's surface; no trees on its banks either.
        layers.ground[r0:r1, c0:c1][d < radius * 0.75] = Ground.WATER
        layers.speed[r0:r1, c0:c1][inside] = WATERHOLE_SPEED
        layers.clear[r0:r1, c0:c1][d < radius + 0.5] = True


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
