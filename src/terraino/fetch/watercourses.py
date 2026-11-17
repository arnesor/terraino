"""Watercourses and water channels traced from Kartverket's topographic map (CC BY 4.0).

The map's ``vannkontur`` layer draws streams in blue and ditches in pale blue, as on
the topographic map, from Kartverket's detailed data; lake and river shores are drawn in
the same blue (terraino.process.watercourses leaves them out). At 0.25 m per pixel the
lines are about one pixel wide; they are thinned to one pixel and followed from pixel
to pixel into lines.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from pathlib import Path

import numpy as np
import numpy.typing as npt
from shapely import LineString, Polygon, box
from shapely.ops import linemerge

from terraino.fetch.cache import DownloadError
from terraino.fetch.topo import read_layer
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

LAYER = "vannkontur"
PIXEL_M = 0.25
TILE_M = 800
OVERLAP_M = 20
# Anti-aliased pixels at least this opaque are part of a line; fewer break diagonal
# lines into dashes.
MIN_ALPHA = 64
# Pale blue (ditches) has a high red channel, blue (streams and shores) none.
PALE_RED = 150
KINDS = ("small_stream", "water_channel")
# Ends of traced pieces this close are one point (where tiles meet).
JOIN_M = 1.0
# Traced pieces shorter than this are noise.
MIN_LENGTH_M = 5.0

type Traced = tuple[str, LineString]


def thin(mask: npt.NDArray[np.bool_]) -> npt.NDArray[np.bool_]:
    """Thin drawn lines to one pixel wide (Zhang and Suen), keeping them connected.

    Examples:
        >>> m = np.zeros((4, 10), bool)
        >>> m[1:3, 1:9] = True   # a line two pixels thick
        >>> thin(m).astype(int)
        array([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
               [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
               [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
               [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]])
    """
    img = np.pad(mask, 1).astype(np.uint8)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            p = img
            # Neighbours P2..P9, clockwise from north.
            n = [
                p[:-2, 1:-1],
                p[:-2, 2:],
                p[1:-1, 2:],
                p[2:, 2:],
                p[2:, 1:-1],
                p[2:, :-2],
                p[1:-1, :-2],
                p[:-2, :-2],
            ]
            b = sum(x.astype(np.int16) for x in n)
            a = sum(
                ((n[i] == 0) & (n[(i + 1) % 8] == 1)).astype(np.int16) for i in range(8)
            )
            if step == 0:
                c1 = n[0] * n[2] * n[4]
                c2 = n[2] * n[4] * n[6]
            else:
                c1 = n[0] * n[2] * n[6]
                c2 = n[0] * n[4] * n[6]
            centre = p[1:-1, 1:-1]
            remove = (
                (centre == 1) & (b >= 2) & (b <= 6) & (a == 1) & (c1 == 0) & (c2 == 0)
            )
            if remove.any():
                centre[remove] = 0
                changed = True
    return img[1:-1, 1:-1].astype(bool)


_NEIGHBOURS = [(-1, 0), (0, 1), (1, 0), (0, -1), (-1, 1), (1, 1), (1, -1), (-1, -1)]


def chains(skeleton: npt.NDArray[np.bool_]) -> list[list[tuple[int, int]]]:
    """Follow a one-pixel skeleton into chains of pixels between ends and junctions.

    Examples:
        >>> s = np.zeros((5, 5), bool)
        >>> s[2, :] = True   # a line across
        >>> s[:2, 2] = True  # and a branch north from its middle
        >>> sorted(len(c) for c in chains(s))
        [3, 3, 3]
    """
    pixels = set(zip(*np.nonzero(skeleton), strict=True))
    links: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    for r, c in pixels:
        for dr, dc in _NEIGHBOURS:
            q = (r + dr, c + dc)
            if q not in pixels:
                continue
            # A diagonal step is left out where two straight steps join the pixels.
            if dr and dc and ((r + dr, c) in pixels or (r, c + dc) in pixels):
                continue
            links[(r, c)].append(q)
    nodes = {p for p in pixels if len(links[p]) != 2}
    seen: set[frozenset[tuple[int, int]]] = set()
    found = []

    def follow(start: tuple[int, int], nxt: tuple[int, int]) -> list[tuple[int, int]]:
        chain = [start, nxt]
        seen.add(frozenset((start, nxt)))
        while chain[-1] not in nodes and chain[-1] != start:
            here, before = chain[-1], chain[-2]
            step = next((q for q in links[here] if q != before), None)
            if step is None:
                break
            seen.add(frozenset((here, step)))
            chain.append(step)
        return chain

    for node in nodes:
        for nxt in links[node]:
            if frozenset((node, nxt)) not in seen:
                found.append(follow(node, nxt))
    # Rings without ends or junctions.
    for p in pixels:
        for nxt in links[p]:
            if frozenset((p, nxt)) not in seen:
                found.append(follow(p, nxt))
    return found


def trace_tile(
    rgba: npt.NDArray[np.uint8], x0: float, y1: float, keep: Polygon
) -> list[Traced]:
    """The watercourses and water channels drawn in a rendering of the layer.

    Returns:
        (kind, line) for each traced piece within ``keep``.
    """
    drawn = rgba[..., 3] >= MIN_ALPHA
    pale = drawn & (rgba[..., 0] > PALE_RED)
    found: list[Traced] = []
    for kind, mask in (("small_stream", drawn & ~pale), ("water_channel", pale)):
        if not mask.any():
            continue
        for chain in chains(thin(mask)):
            if len(chain) < 2:
                continue
            coords = [
                (x0 + (c + 0.5) * PIXEL_M, y1 - (r + 0.5) * PIXEL_M) for r, c in chain
            ]
            line = LineString(coords).simplify(PIXEL_M)
            found.extend((kind, part) for part in _parts(line.intersection(keep)))
    return found


def join_pieces(pieces: list[Traced]) -> list[Traced]:
    """Join pieces whose ends meet (within JOIN_M), and drop short leftovers.

    Examples:
        >>> a = ("small_stream", LineString([(0, 0), (10, 0)]))
        >>> b = ("small_stream", LineString([(10.3, 0.2), (20, 0)]))
        >>> c = ("small_stream", LineString([(50, 0), (53, 0)]))
        >>> [(k, round(line.length)) for k, line in join_pieces([a, b, c])]
        [('small_stream', 20)]
    """
    ends: list[tuple[float, float]] = []
    for _, line in pieces:
        (x0, y0), (x1, y1) = line.coords[0][:2], line.coords[-1][:2]
        ends.extend(((x0, y0), (x1, y1)))
    snapped = _snap_points(ends)
    joined: list[Traced] = []
    for kind in KINDS:
        lines = []
        for i, (k, line) in enumerate(pieces):
            if k != kind:
                continue
            coords = list(line.coords)
            coords[0], coords[-1] = snapped[2 * i], snapped[2 * i + 1]
            if len(coords) > 2 or coords[0] != coords[-1]:
                lines.append(LineString(coords))
        if lines:
            joined.extend(
                (kind, line)
                for line in _parts(linemerge(lines))
                if line.length >= MIN_LENGTH_M
            )
    return joined


def _snap_points(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Each point moved to the first of the points within JOIN_M of it."""
    cells: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    out = []
    for x, y in points:
        cx, cy = int(x // JOIN_M), int(y // JOIN_M)
        near = next(
            (
                q
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                for q in cells[(cx + dx, cy + dy)]
                if (q[0] - x) ** 2 + (q[1] - y) ** 2 <= JOIN_M**2
            ),
            None,
        )
        if near is None:
            near = (x, y)
            cells[(cx, cy)].append(near)
        out.append(near)
    return out


def fetch_watercourses(
    epsg: int, extent: Extent, cache_dir: Path
) -> list[Traced] | None:
    """Watercourses, water channels and shores drawn on Kartverket's map in ``extent``.

    Returns:
        (kind, line) pairs, or None (with a warning) if the map cannot be read.
    """
    try:
        pieces = read_layer(
            LAYER,
            epsg,
            extent,
            cache_dir,
            pixel_m=PIXEL_M,
            tile_m=TILE_M,
            overlap_m=OVERLAP_M,
            reader=trace_tile,
        )
    except DownloadError as exc:
        log.warning("No watercourses from Kartverket's map: %s", exc)
        return None
    # The tiles reach beyond the world.
    window = box(*extent.as_tuple())
    return [
        (kind, part)
        for kind, line in join_pieces(pieces)
        for part in _parts(line.intersection(window))
        if part.length >= MIN_LENGTH_M
    ]


def _parts(geometry: object) -> list[LineString]:
    if isinstance(geometry, LineString):
        return [geometry] if geometry.length > 0 else []
    return [g for g in getattr(geometry, "geoms", []) if isinstance(g, LineString)]
