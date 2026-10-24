"""Roads and paths as lines, drawn by the viewer as sharp strips on the terrain.

Path ends that stop just short of another path are snapped onto it: the mapper meant a
junction, and in the terrain the paths should meet. Wider gaps are kept; on the map they
mark indistinct junctions, where the paths do not visibly meet.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from shapely import LineString, MultiLineString, Point, Polygon, STRtree
from shapely.geometry.base import BaseGeometry
from shapely.ops import linemerge, nearest_points

from terraino.fetch.osm import OsmFeature
from terraino.process.fuse import road_style
from terraino.process.geometry import to_geometry
from terraino.process.symbols import Ground, SymbolSet

# Path ends closer than this to another path are joined to it.
SNAP_M = 1.5
# Drawn width at least this, so narrow paths stay visible.
MIN_WIDTH_M = {
    "path": 1.2,
    "small_path": 0.8,
    "faint_path": 0.5,
    "small_stream": 1.0,
    "water_channel": 0.8,
}


@dataclass(frozen=True)
class Track:
    """A road or path.

    Attributes:
        kind: Style (terraino.process.symbols.TRACKS).
        width: Drawn width in metres.
        coords: Line vertices in projected coordinates.
    """

    kind: str
    width: float
    coords: list[tuple[float, float]]


def _lines(geometry: BaseGeometry | None) -> list[LineString]:
    if isinstance(geometry, LineString) and geometry.length > 0:
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return [g for g in geometry.geoms if g.length > 0]
    if geometry is not None and hasattr(geometry, "geoms"):
        return [g for part in geometry.geoms for g in _lines(part)]
    return []


def _osm_kind(ground: Ground, width: float) -> str:
    if ground is Ground.PAVED:
        return "paved"
    if ground is Ground.GRAVEL:
        return "gravel" if width >= 3.5 else "vehicle_track"
    return "path" if width >= 1 else "small_path"


def snap_ends(
    lines: Sequence[LineString], distance: float = SNAP_M
) -> list[LineString]:
    """Extend line ends that stop within ``distance`` of another line onto that line.

    Examples:
        >>> a = LineString([(0, 0), (10, 0)])
        >>> b = LineString([(5, 1.0), (5, 10)])   # stops 1 m short of a
        >>> c = LineString([(8, 4.0), (8, 10)])   # 4 m short: a deliberate gap
        >>> [list(line.coords)[0] for line in snap_ends([a, b, c])]
        [(0.0, 0.0), (5.0, 0.0), (8.0, 4.0)]
    """
    tree = STRtree(list(lines))
    snapped = []
    for i, line in enumerate(lines):
        coords = list(line.coords)
        for end in (0, -1):
            point = Point(coords[end])
            if any(
                j != i and lines[j].distance(point) < 1e-6
                for j in tree.query(point.buffer(1e-3))
            ):
                continue  # already joined
            candidates = [j for j in tree.query(point.buffer(distance)) if j != i]
            if not candidates:
                continue
            j = min(candidates, key=lambda k: lines[k].distance(point))
            if lines[j].distance(point) >= distance:
                continue
            target = nearest_points(lines[j], point)[0]
            if end == 0:
                coords.insert(0, (target.x, target.y))
            else:
                coords.append((target.x, target.y))
        snapped.append(LineString(coords))
    return snapped


def collect_tracks(
    omap_features: Iterable[Mapping[str, Any]],
    symbols: SymbolSet,
    osm: Iterable[OsmFeature],
    map_area: Polygon | None,
) -> list[Track]:
    """Roads and paths from the map, and OSM roads outside the mapped area."""
    found: list[tuple[str, float, LineString]] = []
    for feature in omap_features:
        rule = symbols.rule(feature["properties"]["sym"])
        if rule is None or rule.track is None or rule.width is None:
            continue
        width = max(rule.width, MIN_WIDTH_M.get(rule.track, 0.0))
        found.extend(
            (rule.track, width, line)
            for line in _lines(to_geometry(feature.get("geometry")))
        )

    for f in osm:
        style = road_style(f.tags)
        if style is None:
            continue
        width, ground = style
        outside = f.geometry if map_area is None else f.geometry.difference(map_area)
        kind = _osm_kind(ground, width)
        width = max(width, MIN_WIDTH_M.get(kind, 0.0))
        found.extend((kind, width, line) for line in _lines(outside))

    lines = snap_ends([line for _, _, line in found])
    # A road is often drawn as many pieces end to end; join pieces of the same kind into
    # one line, so the viewer draws it as one strip without overlapping ends.
    groups: dict[tuple[str, float], list[LineString]] = {}
    for (kind, width, _), line in zip(found, lines, strict=True):
        groups.setdefault((kind, width), []).append(line)
    tracks = []
    for (kind, width), group in groups.items():
        for line in _lines(linemerge(group)):
            coords = [(float(x), float(y)) for x, y in line.coords]
            tracks.append(Track(kind=kind, width=width, coords=coords))
    return tracks
