"""Road bridges: decks a runner can cross and pass under.

Kartverket's terrain model has bridge decks removed, so a road on a bridge sinks to the
road or water under it. OpenStreetMap says where a bridge is and which road is on it; the
terrain model says where the deck starts and ends: where the ground drops steeply away
from the road. The deck runs straight from one end to the other, and the surface model,
which keeps the deck, is a check. See docs/adr/0006-bridges-from-osm-decks-from-the-dtm-gap.md.

Under the deck the ground is what the map has under the road on the bridge, and the gap a
mapper leaves in the road under the bridge is closed.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize
from scipy import ndimage
from shapely import (
    LineString,
    Point,
    Polygon,
    STRtree,
    get_coordinates,
    line_interpolate_point,
)
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import substring

from terraino.fetch.osm import OsmFeature
from terraino.ingest.georef import Extent
from terraino.process.fuse import road_style
from terraino.process.geometry import to_geometry
from terraino.process.layers import GroundLayers, repaint_speed
from terraino.process.symbols import Ground, SymbolSet
from terraino.process.tracks import Track

log = logging.getLogger(__name__)

# Tracks that can be on a road bridge. Paths over streams get footbridges in the viewer.
BRIDGED_KINDS = frozenset({"paved", "gravel", "vehicle_track"})
# OSM highways on footbridges, left to the viewer's footbridges.
_FOOT_HIGHWAYS = frozenset(
    {"footway", "path", "cycleway", "steps", "bridleway", "pedestrian"}
)
# Profiles along the road are sampled this far apart (m).
STEP_M = 1.0
# Ground falling or rising faster than this (m per m) is a wall under a deck, not a road.
WALL_GRADE = 0.2
# ...and drops (or climbs) at least this far (m) within this distance (m) of the deck's end.
WALL_DROP_M = 0.5
WALL_RUN_M = 4.0
# A deck slopes at most this much (m per m).
MAX_GRADE = 0.15
# A deck is built only where the ground drops more than this (m) below it.
MIN_DIP_M = 0.5
# Ground may rise this far (m) above the deck between its ends; more is not a bridge.
POKE_M = 0.3
# The surface model may be at most this far (m) below the deck (in the median).
DOM_BELOW_M = 0.5
# An OSM bridge marks a stretch of a track that runs within this distance (m) of it...
MATCH_M = 10.0
# ...and this many degrees of its direction...
MATCH_DEG = 20.0
# ...along at least this share of the bridge's length.
MATCH_SHARE = 0.5
# A deck end cut by the map's edge takes its height from the surface model over this
# much (m) of the deck, from at least this many samples, unless that is further than this
# (m) from the grade of the road leading onto it (trees over the deck).
OPEN_END_M = 15.0
OPEN_END_SAMPLES = 5
OPEN_END_DOUBT_M = 3.0
# The deck's ends are looked for this far (m) beyond the OSM bridge's.
SEARCH_M = 15.0
# The ends of a road under a bridge are joined when they are at most this many times the
# width of the deck and the road together apart (more where the road crosses at a slant),
# and face each other within this angle (degrees).
UNDERPASS_WIDTHS = 2.0
UNDERPASS_DEG = 30.0
# Which way a track's end points is judged over this much (m) of it.
END_BEARING_M = 5.0
# Guard rails stand this far (m) outside the road's edge on each side.
RAIL_M = 0.5
# No trees within this far (m) of the deck.
TREE_FREE_M = 1.0
# Spans longer than this (m) get pillars about this far apart.
PILLAR_SPACING_M = 25.0
# A pillar may move up to this far (m) along the deck to keep off roads and water.
PILLAR_SHIFT_M = 8.0
# Pillars are only built where the deck is at least this high (m) above the ground.
PILLAR_MIN_HEIGHT_M = 1.5
# Looking for bridges without an OSM tag: windows of this length (m), every half window.
SUSPECT_WINDOW_M = 80.0
# ...away from bridges OSM knows about by this far (m)...
SUSPECT_KNOWN_M = 30.0
# ...where the surface model is within this distance (m) of the deck...
SUSPECT_DOM_M = 0.5
# ...along at least this share of it.
SUSPECT_DOM_SHARE = 0.8


@dataclass(frozen=True)
class Bridge:
    """A road bridge deck.

    Attributes:
        kind: Style of the track on the deck (terraino.process.symbols.TRACKS).
        width: Width of the track on the deck in metres; the deck is wider by its rails.
        coords: Centre line of the deck: easting, northing and height of the road surface.
        speed: Running speed factor on the deck.
        pillars: Distances (m) along the deck of the pillars under it.
    """

    kind: str
    width: float
    coords: list[tuple[float, float, float]]
    speed: float = 1.0
    pillars: tuple[float, ...] = ()

    @property
    def line(self) -> LineString:
        """The centre line in plan."""
        return LineString([(x, y) for x, y, _ in self.coords])

    @property
    def half_width(self) -> float:
        """Half the width of the deck, rails included."""
        return self.width / 2 + RAIL_M

    def outline(self, margin: float = 0.0) -> Polygon:
        """The deck seen from above, widened by ``margin`` (flat at the ends)."""
        outline: Polygon = self.line.buffer(self.half_width + margin, cap_style="flat")
        return outline


@dataclass(frozen=True)
class Deck:
    """Where a deck is on a track, before the track is cut.

    Attributes:
        track: Index of the track.
        start: Distance (m) along the track of the deck's first end.
        end: Distance (m) along the track of its last end.
        start_height: Height of the deck at ``start``.
        end_height: Height of the deck at ``end``.
    """

    track: int
    start: float
    end: float
    start_height: float
    end_height: float


def sample(
    grid: npt.NDArray[np.float32],
    extent: Extent,
    xs: npt.ArrayLike,
    ys: npt.ArrayLike,
) -> npt.NDArray[np.float64]:
    """Heights of a 1 m grid over ``extent`` at the points, interpolated.

    Examples:
        >>> grid = np.array([[0.0, 2.0], [4.0, 6.0]], dtype=np.float32)
        >>> sample(grid, Extent(0, 0, 2, 2), [0.5, 1.0], [1.5, 1.0]).tolist()
        [0.0, 3.0]
    """
    x = np.asarray(xs, dtype=np.float64)
    y = np.asarray(ys, dtype=np.float64)
    heights: npt.NDArray[np.float64] = ndimage.map_coordinates(
        grid.astype(np.float64, copy=False),
        [extent.y1 - y - 0.5, x - extent.x0 - 0.5],
        order=1,
        mode="nearest",
    )
    return heights


def _profile(
    line: LineString,
    start: float,
    end: float,
    dtm: npt.NDArray[np.float32],
    extent: Extent,
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Distances along ``line`` from ``start`` to ``end``, and the ground there."""
    count = max(2, math.ceil((end - start) / STEP_M) + 1)
    distances = np.linspace(start, end, count)
    xy = get_coordinates(line_interpolate_point(line, distances))
    return distances, sample(dtm, extent, xy[:, 0], xy[:, 1])


def deck_spans(
    distances: npt.ArrayLike,
    heights: npt.ArrayLike,
    *,
    max_span: float = math.inf,
    open_start: bool = False,
    open_end: bool = False,
) -> list[tuple[int, int, float, float]]:
    """Where a deck bridges a gap in the ground along a road.

    The ground drops away steeply at one end of a deck and climbs back at the other.
    A deck runs straight between the two, not too steep, with the ground nowhere above
    it and more than MIN_DIP_M below it somewhere.

    A road that starts or ends on a bridge (cut by the edge of the map) has a deck
    from that end, at the grade of the road leading onto it, if ``open_start`` or
    ``open_end``.

    Returns:
        The first and last index of each deck, and its heights there.

    Examples:
        >>> d = np.arange(61.0)
        >>> h = 100 + 0.01 * d
        >>> h[20:41] -= 5  # the gap under a bridge
        >>> [(a, b, round(ha, 2), round(hb, 2)) for a, b, ha, hb in deck_spans(d, h)]
        [(19, 41, 100.19, 100.41)]

        A dip in the road before the gap is not where the deck starts:

        >>> h2 = h.copy()
        >>> h2[8:12] -= 0.35
        >>> [(a, b) for a, b, _, _ in deck_spans(d, h2)]
        [(19, 41)]

        A valley the road runs through is not a bridge, however deep:

        >>> deck_spans(d, 100 + 0.002 * (d - 30) ** 2)
        []

        The road is cut by the map's edge in the middle of the bridge:

        >>> [(a, b, round(hb, 2)) for a, b, _, hb in deck_spans(d[:31], h[:31], open_end=True)]
        [(19, 30, 100.3)]
    """
    d = np.asarray(distances, dtype=np.float64)
    h = np.asarray(heights, dtype=np.float64)
    if len(d) < 3:
        return []
    slope = np.diff(h) / np.maximum(np.diff(d), 1e-9)
    down = slope < -WALL_GRADE
    up = slope > WALL_GRADE
    # The last road sample before the ground drops, and the first after it climbs back,
    # where it drops (or climbs) a wall's height, not just a wobble in the road.

    def wall(k: int, side: int) -> bool:
        reach = np.flatnonzero(np.abs(d - d[k]) <= WALL_RUN_M)
        near = reach[reach >= k] if side > 0 else reach[reach <= k]
        return bool(h[k] - h[near].min() >= WALL_DROP_M)

    starts = [
        int(k)
        for k in np.flatnonzero(down)
        if (k == 0 or not down[k - 1]) and wall(int(k), +1)
    ]
    ends = [
        int(k) + 1
        for k in np.flatnonzero(up)
        if (k + 1 == len(up) or not up[k + 1]) and wall(int(k) + 1, -1)
    ]
    last = len(d) - 1
    if open_start and (not starts or (ends and ends[0] < starts[0])):
        starts.insert(0, 0)
    if open_end:
        ends.append(last)

    def deck(a: int, b: int) -> tuple[float, float] | None:
        """Heights of a deck from a to b, or None if there is none."""
        if b <= a or d[b] - d[a] > max_span:
            return None
        if a == 0 and open_start and b < last:
            grade = _approach_grade(d, h, b, +1)
            ha, hb = h[b] - grade * (d[b] - d[a]), h[b]
        elif b == last and open_end:
            grade = _approach_grade(d, h, a, -1)
            ha, hb = h[a], h[a] + grade * (d[b] - d[a])
        else:
            ha, hb = h[a], h[b]
        grade = (hb - ha) / (d[b] - d[a])
        if abs(grade) > MAX_GRADE:
            return None
        gap = ha + grade * (d[a : b + 1] - d[a]) - h[a : b + 1]
        if gap.min() < -POKE_M or gap.max() <= MIN_DIP_M:
            return None
        return float(ha), float(hb)

    spans: list[tuple[int, int, float, float]] = []
    after = -1
    for a in starts:
        if a < after:
            continue
        for b in ends:
            found = deck(a, b)
            if found is not None:
                spans.append((a, b, *found))
                after = b
                break
    return spans


def _approach_grade(
    d: npt.NDArray[np.float64], h: npt.NDArray[np.float64], k: int, side: int
) -> float:
    """Grade of the road over the 10 m before index ``k``, on ``side`` (-1 before)."""
    j = int(np.clip(np.searchsorted(d, d[k] + side * 10.0), 0, len(d) - 1))
    if j == k:
        return 0.0
    grade = float((h[k] - h[j]) / (d[k] - d[j]))
    return float(np.clip(grade, -MAX_GRADE, MAX_GRADE))


@dataclass(frozen=True)
class OsmBridge:
    """A road on a bridge in OpenStreetMap.

    Attributes:
        line: The road's centre line on the bridge, projected.
        name: The road's name or number and the OSM way, for the build log.
    """

    line: LineString
    name: str


def osm_bridges(osm: Iterable[OsmFeature]) -> list[OsmBridge]:
    """OSM roads on bridges (not footbridges).

    Examples:
        >>> on = OsmFeature(LineString([(0, 0), (9, 0)]), {"highway": "trunk", "bridge": "yes", "name": "Arko-vegen"}, "way/1")
        >>> foot = OsmFeature(LineString([(0, 0), (9, 0)]), {"highway": "footway", "bridge": "yes"}, "way/2")
        >>> off = OsmFeature(LineString([(0, 0), (9, 0)]), {"highway": "trunk"}, "way/3")
        >>> [b.name for b in osm_bridges([on, foot, off])]
        ['Arko-vegen (way/1)']
    """
    return [
        OsmBridge(f.geometry, f"{_road_name(f.tags)} ({f.osm_id})")
        for f in osm
        if isinstance(f.geometry, LineString)
        and f.tags.get("bridge", "no") != "no"
        and f.tags.get("highway") not in _FOOT_HIGHWAYS
        and road_style(f.tags) is not None
    ]


def _road_name(tags: Mapping[str, str]) -> str:
    for key in ("bridge:name", "name", "ref"):
        if tags.get(key):
            return tags[key]
    return f"a {tags.get('highway', 'road')} road"


def _bearing(a: Sequence[float], b: Sequence[float]) -> float:
    return math.atan2(b[1] - a[1], b[0] - a[0])


def _angle(a: float, b: float) -> float:
    """Difference in degrees between two bearings (radians)."""
    return abs(math.degrees((a - b + math.pi) % (2 * math.pi) - math.pi))


def match_bridge(
    bridge: LineString, tracks: Sequence[Track], lines: Sequence[LineString]
) -> list[tuple[int, float, float]]:
    """The tracks an OSM bridge marks, and the stretch of each.

    A track is on the bridge where it runs along it, within MATCH_M and MATCH_DEG, for
    at least MATCH_SHARE of the bridge's length or up to its own end (where the map's
    edge cuts it).

    Examples:
        >>> road = Track("paved", 8, [(0, 0), (100, 0)])
        >>> across = Track("paved", 5.5, [(50, -50), (50, 50)])
        >>> lines = [LineString(t.coords) for t in (road, across)]
        >>> match_bridge(LineString([(40, 2), (60, 2)]), [road, across], lines)
        [(0, 40.0, 60.0)]
        >>> match_bridge(LineString([(40, 40), (60, 40)]), [road, across], lines)
        []
    """
    found = []
    first, last = bridge.coords[0], bridge.coords[-1]
    for i, (track, line) in enumerate(zip(tracks, lines, strict=True)):
        if track.kind not in BRIDGED_KINDS or line.distance(bridge) > MATCH_M:
            continue
        s0 = line.project(Point(first))
        s1 = line.project(Point(last))
        lo, hi = min(s0, s1), max(s0, s1)
        at_end = lo <= STEP_M or hi >= line.length - STEP_M
        if hi - lo < MATCH_SHARE * bridge.length and not (at_end and hi - lo >= 10):
            continue
        piece = substring(line, lo, hi)
        if not isinstance(piece, LineString):
            continue
        stations = line_interpolate_point(piece, np.arange(0, piece.length, 2.0))
        if max(bridge.distance(p) for p in stations) > MATCH_M:
            continue
        p0 = line.interpolate(s0).coords[0]
        p1 = line.interpolate(s1).coords[0]
        if _angle(_bearing(p0, p1), _bearing(first, last)) > MATCH_DEG:
            continue
        found.append((i, lo, hi))
    return found


def _merge(
    stretches: list[tuple[float, float, str]],
) -> list[tuple[float, float, str]]:
    """Join overlapping stretches of a track, and the names of their bridges."""
    merged: list[tuple[float, float, str]] = []
    for lo, hi, name in sorted(stretches):
        if merged and lo <= merged[-1][1]:
            last = merged[-1]
            names = last[2] if name in last[2] else f"{last[2]}, {name}"
            merged[-1] = (last[0], max(last[1], hi), names)
        else:
            merged.append((lo, hi, name))
    return merged


def find_decks(
    tracks: Sequence[Track],
    bridges: Sequence[OsmBridge],
    dtm: npt.NDArray[np.float32],
    dom: npt.NDArray[np.float32] | None,
    extent: Extent,
    area: Polygon | None = None,
) -> list[Deck]:
    """Decks on the tracks that OSM bridges mark, found in the terrain model.

    Bridges in ``area`` (the map) that get no deck are logged, with why.

    Args:
        tracks: Roads and paths.
        bridges: OSM roads on bridges (osm_bridges).
        dtm: Bare-ground heights at 1 m over ``extent``, decks removed.
        dom: Surface heights at 1 m over ``extent``, decks kept, or None.
        extent: Extent of the grids.
        area: Where to report bridges without a deck, or None for everywhere.

    Returns:
        The decks, in track order.
    """
    lines = [LineString(t.coords) for t in tracks]
    stretches: dict[int, list[tuple[float, float, str]]] = {}
    for bridge in bridges:
        found = match_bridge(bridge.line, tracks, lines)
        if not found and _reported(bridge.line, area):
            log.warning("%s", _unmatched(bridge, tracks, lines))
        for i, lo, hi in found:
            stretches.setdefault(i, []).append((lo, hi, bridge.name))

    decks: list[Deck] = []
    flat: list[str] = []
    for i in sorted(stretches):
        line = lines[i]
        for lo, hi, names in _merge(stretches[i]):
            start = max(lo - SEARCH_M, 0.0)
            end = min(hi + SEARCH_M, line.length)
            d, h = _profile(line, start, end, dtm, extent)
            spans = [
                span
                for span in deck_spans(
                    d,
                    h,
                    open_start=lo <= STEP_M,
                    open_end=open_end(hi, line),
                )
                if d[span[1]] >= lo and d[span[0]] <= hi
            ]
            middle = line.interpolate((lo + hi) / 2)
            if not spans and _reported(middle, area):
                flat.append(f"{names} at {_position(middle)}")
            for a, b, ha, hb in spans:
                if dom is not None and d[a] <= STEP_M and lo <= STEP_M:
                    ha = _open_end_height(line, d[a], d[b], dtm, dom, extent, ha)
                if (
                    dom is not None
                    and d[b] >= line.length - STEP_M
                    and open_end(hi, line)
                ):
                    hb = _open_end_height(line, d[b], d[a], dtm, dom, extent, hb)
                deck = Deck(i, float(d[a]), float(d[b]), ha, hb)
                if dom is not None and not _surface_agrees(deck, line, dom, extent):
                    if _reported(middle, area):
                        log.warning(
                            "OSM bridge %s at %s: the surface model shows no deck "
                            "along the map's road there; leaving it on the ground",
                            names,
                            _position(middle),
                        )
                    continue
                decks.append(deck)
    if flat:
        log.info(
            "No gap in the ground under %d OSM bridges, left on the ground: %s",
            len(flat),
            "; ".join(flat),
        )
    return decks


def open_end(hi: float, line: LineString) -> bool:
    """True if a bridge's stretch reaches the end of its track (cut by the map's edge)."""
    return hi >= line.length - STEP_M


def _open_end_height(
    line: LineString,
    end: float,
    other: float,
    dtm: npt.NDArray[np.float32],
    dom: npt.NDArray[np.float32],
    extent: Extent,
    guess: float,
) -> float:
    """Height of a deck at an end cut by the map's edge, from the surface model.

    Nothing else sees the deck there: the median of the surface model over the
    OPEN_END_M of the deck nearest the end, where it stands clear of the ground. The
    guess (the grade of the road leading onto the deck) is kept where trees or too few
    samples leave the surface model in doubt.
    """
    toward = 1.0 if other > end else -1.0
    reach = min(OPEN_END_M, abs(other - end))
    stations = end + toward * np.arange(0.0, reach, STEP_M)
    xy = get_coordinates(line_interpolate_point(line, stations))
    ground = sample(dtm, extent, xy[:, 0], xy[:, 1])
    surface = sample(dom, extent, xy[:, 0], xy[:, 1])
    clear = np.isfinite(surface) & (surface - ground > MIN_DIP_M)
    if clear.sum() < OPEN_END_SAMPLES:
        return guess
    height = float(np.median(surface[clear]))
    return height if abs(height - guess) <= OPEN_END_DOUBT_M else guess


def _reported(geometry: BaseGeometry, area: Polygon | None) -> bool:
    return area is None or area.intersects(geometry)


def _position(point: Point) -> str:
    return f"E {point.x:.0f} N {point.y:.0f}"


def _unmatched(
    bridge: OsmBridge, tracks: Sequence[Track], lines: Sequence[LineString]
) -> str:
    """Why an OSM bridge marks no road on the map: the nearest one along it, if any."""
    where = f"OSM bridge {bridge.name} at {_position(bridge.line.interpolate(0.5, normalized=True))}"
    nearest = _nearest_along(bridge.line, tracks, lines)
    if nearest is None:
        return (
            f"{where} is not on a road the map draws: no road runs along it within 30 m"
        )
    track, distance = nearest
    return (
        f"{where} is not on a road the map draws: the nearest road along it "
        f"({track.kind}, {track.width:g} m) is up to {distance:.1f} m from it, "
        f"more than {MATCH_M:g} m; move the road in the map to where it is on the ground"
    )


def _nearest_along(
    bridge: LineString, tracks: Sequence[Track], lines: Sequence[LineString]
) -> tuple[Track, float] | None:
    """The track running along a bridge nearest it, and its farthest distance from it."""
    first, last = bridge.coords[0], bridge.coords[-1]
    best: tuple[Track, float] | None = None
    for track, line in zip(tracks, lines, strict=True):
        if track.kind not in BRIDGED_KINDS or line.distance(bridge) > 30:
            continue
        s0 = line.project(Point(first))
        s1 = line.project(Point(last))
        if abs(s1 - s0) < STEP_M:
            continue
        p0 = line.interpolate(s0).coords[0]
        p1 = line.interpolate(s1).coords[0]
        if _angle(_bearing(p0, p1), _bearing(first, last)) > MATCH_DEG:
            continue
        lo, hi = min(s0, s1), max(s0, s1)
        stations = np.append(np.arange(lo, hi, 2.0), hi)
        distance = max(bridge.distance(line.interpolate(s)) for s in stations)
        if best is None or distance < best[1]:
            best = (track, float(distance))
    return best


def _deck_heights(deck: Deck, distances: npt.NDArray[np.float64]) -> Any:
    return np.interp(
        distances, [deck.start, deck.end], [deck.start_height, deck.end_height]
    )


def _surface_agrees(
    deck: Deck, line: LineString, dom: npt.NDArray[np.float32], extent: Extent
) -> bool:
    """True if the surface model is not well below the deck (cars may be on it)."""
    d = np.arange(deck.start, deck.end, STEP_M)
    xy = get_coordinates(line_interpolate_point(line, d))
    surface = sample(dom, extent, xy[:, 0], xy[:, 1])
    finite = np.isfinite(surface)
    if not finite.any():
        return True
    below = _deck_heights(deck, d)[finite] - surface[finite]
    return bool(np.median(below) <= DOM_BELOW_M)


def cut_tracks(
    tracks: Sequence[Track], decks: Sequence[Deck]
) -> tuple[list[Track], list[Bridge]]:
    """Take the decks out of their tracks and make them bridges.

    Examples:
        >>> road = Track("paved", 8, [(0, 0), (100, 0)])
        >>> rest, [bridge] = cut_tracks([road], [Deck(0, 40, 60, 10, 12)])
        >>> [t.coords for t in rest]
        [[(0.0, 0.0), (40.0, 0.0)], [(60.0, 0.0), (100.0, 0.0)]]
        >>> bridge.coords
        [(40.0, 0.0, 10.0), (60.0, 0.0, 12.0)]
    """
    by_track: dict[int, list[Deck]] = {}
    for deck in decks:
        by_track.setdefault(deck.track, []).append(deck)
    kept: list[Track] = []
    bridges: list[Bridge] = []
    for i, track in enumerate(tracks):
        own = sorted(by_track.get(i, []), key=lambda k: k.start)
        if not own:
            kept.append(track)
            continue
        line = LineString(track.coords)
        position = 0.0
        for deck in own:
            kept.extend(_piece(track, line, position, deck.start))
            span = substring(line, deck.start, deck.end)
            along = [0.0, *np.cumsum(np.hypot(*np.diff(span.xy, axis=1)))]
            heights = _deck_heights(deck, deck.start + np.asarray(along))
            bridges.append(
                Bridge(
                    kind=track.kind,
                    width=track.width,
                    coords=[
                        (float(x), float(y), round(float(z), 2))
                        for (x, y), z in zip(span.coords, heights, strict=True)
                    ],
                )
            )
            position = deck.end
        kept.extend(_piece(track, line, position, line.length))
    return kept, bridges


def _piece(track: Track, line: LineString, start: float, end: float) -> list[Track]:
    if end - start < STEP_M / 2:
        return []
    piece = substring(line, start, end)
    coords = [(float(x), float(y)) for x, y in piece.coords]
    return [replace(track, coords=coords)]


def _ends(track: Track) -> list[tuple[Point, float, bool]]:
    """Both ends of a track: the point, the bearing out of the track, and whether last.

    The bearing is taken over the last END_BEARING_M, not the last segment: an end
    snapped onto another track (terraino.process.tracks.snap_ends) may hook sideways.

    Examples:
        >>> hooked = Track("path", 1.2, [(0, 0), (0, 10), (0.6, 10.1)])
        >>> [round(math.degrees(b)) for _, b, _ in _ends(hooked)]
        [-90, 82]
    """
    line = LineString(track.coords)
    back = min(END_BEARING_M, line.length / 2)
    first = line.interpolate(back).coords[0]
    last = line.interpolate(line.length - back).coords[0]
    c = track.coords
    return [
        (Point(c[0]), _bearing(first, c[0]), False),
        (Point(c[-1]), _bearing(last, c[-1]), True),
    ]


def close_underpasses(
    tracks: Sequence[Track], bridges: Sequence[Bridge]
) -> tuple[list[Track], list[Track]]:
    """Join the ends of roads that stop on both sides of a bridge, under it.

    Mappers leave a gap in a road that passes under a bridge. Two ends of tracks of the
    same kind, on opposite sides of a deck, facing each other and at most
    UNDERPASS_WIDTHS times the width of the deck and the road together apart, are joined.

    Returns:
        The tracks, and the stretches added under the bridges.

    Examples:
        >>> bridge = Bridge("paved", 8, [(0, -20, 5), (0, 20, 5)])
        >>> west = Track("paved", 5.5, [(-50, 0), (-7, 0)])
        >>> east = Track("paved", 5.5, [(7, 1), (50, 1)])
        >>> [joined], [under] = close_underpasses([west, east], [bridge])
        >>> joined.coords
        [(-50, 0), (-7, 0), (7, 1), (50, 1)]
        >>> under.coords
        [(-7, 0), (7, 1)]
    """
    result = list(tracks)
    added: list[Track] = []
    for bridge in bridges:
        centre = bridge.line
        while True:
            pair = _underpass_pair(result, centre, bridge.width)
            if pair is None:
                break
            (i, last_i), (j, last_j) = pair
            a, b = result[i], result[j]
            first = a.coords if last_i else a.coords[::-1]
            second = b.coords[::-1] if last_j else b.coords
            joined = replace(a, coords=[*first, *second])
            added.append(replace(a, coords=[first[-1], second[0]]))
            result = [t for k, t in enumerate(result) if k not in (i, j)] + [joined]
    return result, added


def _underpass_pair(
    tracks: Sequence[Track], centre: LineString, width: float
) -> tuple[tuple[int, bool], tuple[int, bool]] | None:
    """The closest two track ends that face each other across ``centre``, or None."""
    near: list[tuple[int, Point, float, bool]] = []
    for i, track in enumerate(tracks):
        if len(track.coords) < 2:
            continue
        reach = UNDERPASS_WIDTHS * (width + track.width)
        for point, bearing, last in _ends(track):
            if STEP_M <= centre.distance(point) <= reach:
                near.append((i, point, bearing, last))
    best: tuple[float, tuple[int, bool], tuple[int, bool]] | None = None
    for k, (i, p, bp, last_p) in enumerate(near):
        for j, q, bq, last_q in near[k + 1 :]:
            a, b = tracks[i], tracks[j]
            if i == j or a.kind != b.kind or a.width != b.width:
                continue
            gap = p.distance(q)
            if gap > UNDERPASS_WIDTHS * (width + a.width) or not LineString(
                [p, q]
            ).crosses(centre):
                continue
            if _angle(bp, _bearing(p.coords[0], q.coords[0])) > UNDERPASS_DEG:
                continue
            if _angle(bq, _bearing(q.coords[0], p.coords[0])) > UNDERPASS_DEG:
                continue
            if best is None or gap < best[0]:
                best = (gap, (i, last_p), (j, last_q))
    return None if best is None else best[1:]


def _runs_along(geometry: BaseGeometry, bridge: Bridge, outline: Polygon) -> bool:
    """True if a line runs along the deck rather than across or under it."""
    inside = geometry.intersection(outline)
    return bool(inside.length >= MATCH_SHARE * bridge.line.length)


def open_underpasses(
    layers: GroundLayers,
    features: Sequence[Mapping[str, Any]],
    symbols: SymbolSet,
    bridges: Sequence[Bridge],
    under: Sequence[Track],
    extent: Extent,
) -> list[Bridge]:
    """Make the ground under the decks what the map has under the roads on them.

    The running speed under a deck is painted again without the road on it, the
    stretches of road joined under the decks get the speed of their road, and no trees
    grow within TREE_FREE_M of a deck.

    Returns:
        The bridges, with the speed of the road on them.
    """
    shape = layers.speed.shape
    with_speed = []
    for bridge in bridges:
        speeds = [
            _cell(layers.speed, extent, x, y, shape)
            for x, y in _beyond_ends(bridge, 2.0)
        ]
        known = [s for s in speeds if s is not None]
        speed = float(np.mean(known)) if known else 1.0
        with_speed.append(replace(bridge, speed=round(speed, 3)))

    geometries = [to_geometry(f.get("geometry")) for f in features]
    index = STRtree([g if g is not None else Point() for g in geometries])
    for bridge in bridges:
        outline = bridge.outline()
        near = index.query(outline.buffer(2.0))
        painted = []
        for k in near:
            geometry = geometries[k]
            if geometry is None:
                continue
            feature = features[k]
            rule = symbols.rule(feature["properties"]["sym"])
            if (
                rule is not None
                and rule.track is not None
                and _runs_along(geometry, bridge, outline)
            ):
                geometry = geometry.difference(outline)
                if geometry.is_empty:
                    continue
                feature = {**feature, "geometry": mapping(geometry)}
            painted.append(feature)
        repaint_speed(layers, painted, symbols, extent, outline)

    for track in under:
        line = LineString(track.coords)
        # The stretch starts at the end of its road, which has the road's speed.
        x, y = track.coords[0]
        road = _cell(layers.speed, extent, x, y, shape)
        if road is None:
            continue
        _set(layers.speed, extent, line.buffer(track.width / 2), road)
        _set(layers.clear, extent, line.buffer(track.width / 2), True)

    for bridge in bridges:
        _set(layers.clear, extent, bridge.outline(TREE_FREE_M), True)
    return with_speed


def _beyond_ends(bridge: Bridge, distance: float) -> list[tuple[float, float]]:
    (x0, y0, _), (x1, y1, _) = bridge.coords[0], bridge.coords[1]
    (xa, ya, _), (xb, yb, _) = bridge.coords[-2], bridge.coords[-1]
    out = []
    for (px, py), (qx, qy) in (((x1, y1), (x0, y0)), ((xa, ya), (xb, yb))):
        length = math.hypot(qx - px, qy - py) or 1.0
        out.append(
            (
                qx + (qx - px) / length * distance,
                qy + (qy - py) / length * distance,
            )
        )
    return out


def _cell(
    grid: npt.NDArray[Any],
    extent: Extent,
    x: float,
    y: float,
    shape: tuple[int, ...],
) -> float | None:
    r = math.floor(extent.y1 - y)
    c = math.floor(x - extent.x0)
    if 0 <= r < shape[0] and 0 <= c < shape[1]:
        return float(grid[r, c])
    return None


def _set(
    grid: npt.NDArray[Any], extent: Extent, area: BaseGeometry, value: object
) -> None:
    grid[deck_mask_of([area], extent, grid.shape)] = value


def deck_mask_of(
    areas: Iterable[BaseGeometry], extent: Extent, shape: tuple[int, ...]
) -> npt.NDArray[np.bool_]:
    """True in the 1 m cells over ``extent`` whose centres are in one of ``areas``."""
    shapes = [(a, 1) for a in areas if not a.is_empty]
    if not shapes:
        return np.zeros(shape[:2], dtype=bool)
    mask: npt.NDArray[np.bool_] = rasterize(
        shapes,
        out_shape=shape[:2],
        transform=extent.raster_transform(1),
        fill=0,
        dtype=np.uint8,
    ).astype(bool)
    return mask


def deck_mask(
    bridges: Sequence[Bridge], extent: Extent, shape: tuple[int, ...]
) -> npt.NDArray[np.bool_]:
    """True under the decks and TREE_FREE_M around them, on a 1 m grid over ``extent``."""
    return deck_mask_of([b.outline(TREE_FREE_M) for b in bridges], extent, shape)


def place_pillars(
    bridges: Sequence[Bridge],
    tracks: Sequence[Track],
    layers: GroundLayers | None,
    dtm: npt.NDArray[np.float32],
    extent: Extent,
) -> list[Bridge]:
    """Put pillars about every PILLAR_SPACING_M under long decks, off roads and water."""
    lines = [LineString(t.coords).buffer(t.width / 2 + 1) for t in tracks]
    index = STRtree(lines)
    placed = []
    for bridge in bridges:
        centre = bridge.line
        length = centre.length
        spans = math.ceil(length / PILLAR_SPACING_M)
        pillars: list[float] = []
        for k in range(1, spans):
            at = _pillar_place(
                bridge, centre, k * length / spans, lines, index, layers, dtm, extent
            )
            if at is not None:
                pillars.append(round(at, 2))
        placed.append(replace(bridge, pillars=tuple(pillars)))
    return placed


def _pillar_place(
    bridge: Bridge,
    centre: LineString,
    ideal: float,
    lines: Sequence[BaseGeometry],
    index: STRtree,
    layers: GroundLayers | None,
    dtm: npt.NDArray[np.float32],
    extent: Extent,
) -> float | None:
    heights = [z for _, _, z in bridge.coords]
    along = [0.0, *np.cumsum(np.hypot(*np.diff(centre.xy, axis=1)))]
    for shift in np.arange(0.0, PILLAR_SHIFT_M + 0.1, 1.0):
        for at in {ideal + shift, ideal - shift}:
            if not 2.0 <= at <= centre.length - 2.0:
                continue
            p = centre.interpolate(at)
            deck = float(np.interp(at, along, heights))
            ground = float(sample(dtm, extent, [p.x], [p.y])[0])
            if deck - ground < PILLAR_MIN_HEIGHT_M:
                continue
            row = _across(centre, at, bridge.half_width).buffer(0.6)
            if any(row.intersects(lines[k]) for k in index.query(row)):
                continue
            if layers is not None and _wet(layers, extent, row):
                continue
            return float(at)
    return None


def _across(centre: LineString, at: float, half: float) -> LineString:
    a = centre.interpolate(max(at - 0.5, 0.0))
    b = centre.interpolate(min(at + 0.5, centre.length))
    p = centre.interpolate(at)
    length = math.hypot(b.x - a.x, b.y - a.y) or 1.0
    nx, ny = -(b.y - a.y) / length, (b.x - a.x) / length
    return LineString(
        [(p.x - nx * half, p.y - ny * half), (p.x + nx * half, p.y + ny * half)]
    )


def _wet(layers: GroundLayers, extent: Extent, area: BaseGeometry) -> bool:
    x0, y0, x1, y1 = area.bounds
    r0 = max(math.floor(extent.y1 - y1), 0)
    r1 = min(math.ceil(extent.y1 - y0), layers.ground.shape[0])
    c0 = max(math.floor(x0 - extent.x0), 0)
    c1 = min(math.ceil(x1 - extent.x0), layers.ground.shape[1])
    window = layers.ground[r0:r1, c0:c1]
    return bool((window == int(Ground.WATER)).any())


def suspected_bridges(
    tracks: Sequence[Track],
    bridges: Sequence[Bridge],
    tagged: Sequence[LineString],
    dtm: npt.NDArray[np.float32],
    dom: npt.NDArray[np.float32],
    extent: Extent,
    area: Polygon | None,
) -> list[tuple[float, float, float]]:
    """Places on roads that look like bridges but have no OSM bridge.

    The ground drops away under the road as under a deck (deck_spans), and the surface
    model runs straight across, within SUSPECT_DOM_M of the deck along most of it.

    Args:
        tracks: Roads and paths, decks cut out.
        bridges: The bridges built.
        tagged: OSM roads on bridges (bridge_lines), built or not.
        dtm: Bare-ground heights at 1 m over ``extent``, decks removed.
        dom: Surface heights at 1 m over ``extent``, decks kept.
        extent: Extent of the grids.
        area: Only look inside this area (the map), or everywhere if None.

    Returns:
        Easting, northing and depth of the gap, for each place.
    """
    known = STRtree([b.line for b in bridges] + list(tagged))
    found: list[tuple[float, float, float]] = []
    for track in tracks:
        if track.kind not in ("paved", "gravel") or len(track.coords) < 2:
            continue
        line = LineString(track.coords)
        if area is not None and not line.intersects(area):
            continue
        d, h = _profile(line, 0.0, line.length, dtm, extent)
        step = int(SUSPECT_WINDOW_M / STEP_M / 2)
        seen: set[int] = set()
        for w in range(0, max(len(d) - step, 1), step):
            window = slice(w, w + 2 * step + 1)
            spans = deck_spans(d[window], h[window], max_span=SUSPECT_WINDOW_M)
            for a, b, ha, hb in spans:
                a, b = a + w, b + w
                if a in seen:
                    continue
                seen.add(a)
                deck = Deck(0, float(d[a]), float(d[b]), ha, hb)
                middle = line.interpolate((deck.start + deck.end) / 2)
                if area is not None and not area.contains(middle):
                    continue
                if len(
                    known.query(middle, predicate="dwithin", distance=SUSPECT_KNOWN_M)
                ):
                    continue
                inside = np.arange(a, b + 1)
                xy = get_coordinates(line_interpolate_point(line, d[inside]))
                surface = sample(dom, extent, xy[:, 0], xy[:, 1])
                top = _deck_heights(deck, d[inside])
                if np.mean(np.abs(surface - top) <= SUSPECT_DOM_M) < SUSPECT_DOM_SHARE:
                    continue
                found.append((middle.x, middle.y, float(np.max(top - h[inside]))))
    return found
