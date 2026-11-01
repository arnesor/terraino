"""Building outlines and roof lines traced from Kartverket's topographic map (CC BY 4.0).

The Topografisk Norgeskart WMS draws buildings from Kartverket's detailed base map: each
building filled in one colour, with a dark outline and its roof lines (ridges, hips,
valleys, roof sections) in grey. Its building layer can be requested on its own, on a
transparent background, at 0.1 m per pixel. The fill gives the outline, the grey
lines the roof lines. Shapes drawn as an outline only (no fill) are left out.
"""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import numpy.typing as npt
from rasterio.features import shapes
from rasterio.transform import from_origin
from scipy import ndimage
from shapely import Polygon
from shapely.geometry import shape

from terraino.fetch.cache import DownloadError
from terraino.fetch.topo import ATTRIBUTION as ATTRIBUTION
from terraino.fetch.topo import read_layer
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)
# The map tiles are read in several threads, but rasterio's shapes() is traced in one at
# a time: it hides a warning about the dataset it makes with warnings.catch_warnings(),
# which is not thread-safe, so the warning slips out of a thread that overlaps another.
_SHAPES_LOCK = threading.Lock()

LAYER = "fkb_bygning"
PIXEL_M = 0.1
TILE_M = 400
# Tiles overlap by this much, so buildings on a tile edge are whole in one of them.
OVERLAP_M = 40
# The map fills buildings by use, and these fills hint at the kind of building.
FILL = (196, 135, 35)  # dwellings, farms and most others
FILLS: dict[tuple[int, int, int], str | None] = {
    FILL: None,
    (115, 163, 212): "public",  # schools, health, culture
    (220, 170, 40): "industry",  # industry and commerce
    (196, 95, 25): None,
}
ROOF_LINE = (110, 100, 80)
FILL_DISTANCE = 45.0
# Roof lines are neither close to a fill colour nor as dark as the outlines.
LINE_FILL_DISTANCE = 30.0
OUTLINE_BRIGHTNESS_MAX = 200
CROP_MARGIN = 4
EDGE_PIXELS = 3
LINE_BRIGHTNESS_MIN = 150
MIN_AREA_M2 = 4.0
SIMPLIFY_M = 0.15
# A shape filling this much of its oriented rectangle is that rectangle.
RECTANGLE_FILL = 0.96
# Roof lines: at least this long; pixels this close to a line belong to it.
MIN_LINE_M = 1.5
LINE_GAP_M = 1.0
LINE_WIDTH_M = 0.15
# Pieces of one line: this close in direction and offset, with gaps up to MERGE_GAP_M.
MERGE_ANGLE = math.radians(4)
MERGE_OFFSET_M = 0.35
MERGE_GAP_M = 1.5


@dataclass(frozen=True)
class RoofLine:
    """A straight roof line (ridge, hip, valley or roof section edge) in projected metres."""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def length(self) -> float:
        """Length in metres."""
        return math.hypot(self.x1 - self.x0, self.y1 - self.y0)

    @property
    def angle(self) -> float:
        """Direction in radians from east, in [0, pi)."""
        return math.atan2(self.y1 - self.y0, self.x1 - self.x0) % math.pi


@dataclass(frozen=True)
class TopoBuilding:
    """A building from the topographic map: its outline, roof lines and use.

    Attributes:
        footprint: Outline, projected coordinates.
        lines: Roof lines.
        category: Kind of building its fill colour stands for ("public", "industry"),
            or None.
        complex: Wings drawn against each other (one building complex, e.g. a school)
            share this key.
    """

    footprint: Polygon
    lines: tuple[RoofLine, ...]
    category: str | None = None
    complex: str = ""


def _colour_distance(
    rgb: npt.NDArray[np.uint8], colour: tuple[int, int, int]
) -> npt.NDArray[np.float64]:
    diff = rgb[..., :3].astype(np.float64) - np.array(colour, dtype=np.float64)
    result: npt.NDArray[np.float64] = np.sqrt((diff**2).sum(axis=-1))
    return result


def _main_angle(poly: Polygon) -> float:
    rect = poly.minimum_rotated_rectangle
    if not isinstance(rect, Polygon):
        return 0.0
    c = list(rect.exterior.coords)
    edges = [(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]) for i in range(2)]
    long = max(edges, key=lambda e: math.hypot(*e))
    return math.atan2(long[1], long[0])


def _tidy(traced: Polygon) -> Polygon | None:
    """Simplify the traced outline; a nearly rectangular one becomes its rectangle."""
    # Out to the middle of the outline: half a pixel, and the pixel cut beside it.
    poly = traced.buffer(PIXEL_M * 1.5, join_style="mitre").simplify(SIMPLIFY_M)
    if not isinstance(poly, Polygon):
        return None
    rect = poly.minimum_rotated_rectangle
    if (
        isinstance(rect, Polygon)
        and rect.area > 0
        and poly.area / rect.area >= RECTANGLE_FILL
    ):
        return rect
    return poly


def _segments(
    px: npt.NDArray[np.float64],
    py: npt.NDArray[np.float64],
    directions: Sequence[float],
) -> list[RoofLine]:
    """Straight lines through roof-line pixels, along the given directions in turn."""
    lines: list[RoofLine] = []
    free = np.ones(len(px), dtype=bool)
    for angle in directions:
        if free.sum() < MIN_LINE_M / PIXEL_M:
            break
        cos, sin = math.cos(angle), math.sin(angle)
        along = px * cos + py * sin
        across = -px * sin + py * cos
        bins = np.floor(across / LINE_WIDTH_M).astype(np.int64)
        for b in np.unique(bins[free]):
            near = free & (np.abs(bins - b) <= 1)
            if near.sum() < MIN_LINE_M / PIXEL_M:
                continue
            order = np.argsort(along[near])
            idx = np.flatnonzero(near)[order]
            positions = along[idx]
            breaks = np.flatnonzero(np.diff(positions) > LINE_GAP_M) + 1
            for run in np.split(np.arange(len(idx)), breaks):
                if len(run) == 0:
                    continue
                a0, a1 = float(positions[run[0]]), float(positions[run[-1]])
                if a1 - a0 < MIN_LINE_M:
                    continue
                offset = float(np.median(across[idx[run]]))
                lines.append(
                    RoofLine(
                        a0 * cos - offset * sin,
                        a0 * sin + offset * cos,
                        a1 * cos - offset * sin,
                        a1 * sin + offset * cos,
                    )
                )
                free[idx[run]] = False
    return _merge_lines(lines)


def _merge_lines(lines: list[RoofLine]) -> list[RoofLine]:
    """Join collinear pieces of one roof line.

    Examples:
        >>> pieces = [RoofLine(0, 0, 3, 0), RoofLine(3.8, 0.1, 9, 0.1), RoofLine(0, 5, 4, 5)]
        >>> [round(line.length, 1) for line in _merge_lines(pieces)]
        [9.0, 4.0]
    """
    merged = list(lines)
    joined = True
    while joined:
        joined = False
        for i in range(len(merged)):
            for j in range(i + 1, len(merged)):
                a, b = merged[i], merged[j]
                turn = abs(a.angle - b.angle)
                if min(turn, math.pi - turn) > MERGE_ANGLE:
                    continue
                cos, sin = math.cos(a.angle), math.sin(a.angle)
                ends = [(a.x0, a.y0), (a.x1, a.y1), (b.x0, b.y0), (b.x1, b.y1)]
                along = [x * cos + y * sin for x, y in ends]
                across = [-x * sin + y * cos for x, y in ends]
                if (
                    abs((across[0] + across[1]) / 2 - (across[2] + across[3]) / 2)
                    > MERGE_OFFSET_M
                ):
                    continue
                a0, a1 = sorted(along[:2])
                b0, b1 = sorted(along[2:])
                if max(a0, b0) - min(a1, b1) > MERGE_GAP_M:
                    continue
                lo, hi = min(a0, b0), max(a1, b1)
                offset = sum(across) / 4
                merged[i] = RoofLine(
                    lo * cos - offset * sin,
                    lo * sin + offset * cos,
                    hi * cos - offset * sin,
                    hi * sin + offset * cos,
                )
                del merged[j]
                joined = True
                break
            if joined:
                break
    return merged


def trace_buildings(
    rgba: npt.NDArray[np.uint8], x0: float, y1: float, keep: Polygon | None = None
) -> list[TopoBuilding]:
    """Buildings in one rendered tile of the building layer.

    Args:
        rgba: The tile, PIXEL_M per pixel.
        x0: Easting of its west edge.
        y1: Northing of its north edge.
        keep: Only buildings whose centre lies in this area (the tile without its
            overlap); None keeps all.

    Examples:
        >>> img = np.zeros((100, 120, 4), np.uint8)
        >>> img[20:60, 10:90] = (*FILL, 255)           # an 8 x 4 m building
        >>> img[39:41, 10:90] = (*ROOF_LINE, 255)      # its ridge, east-west
        >>> img[70:90, 10:50, 3] = 255                 # an outline only: no building
        >>> (b,) = trace_buildings(img, 1000.0, 2000.0)
        >>> round(b.footprint.area), [round(line.length) for line in b.lines]
        (36, [7])
        >>> round(math.degrees(b.lines[0].angle)) % 180
        0
    """
    # Most of a tile is empty: trace each group of buildings on its own crop. The crop
    # has a margin of empty pixels, except where it meets the tile's edge, so buildings
    # cut by the tile's edge still touch the crop's edge.
    alpha = rgba[..., 3] > 0
    groups, n = ndimage.label(ndimage.binary_dilation(alpha, iterations=CROP_MARGIN))
    buildings: list[TopoBuilding] = []
    for found in ndimage.find_objects(groups) if n else ():
        if found is None:
            continue
        rows, cols = found
        crop = rgba[rows, cols]
        cx0, cy1 = x0 + cols.start * PIXEL_M, y1 - rows.start * PIXEL_M
        # Wings in one group touch each other: they are one building complex.
        key = f"{cx0:.1f}_{cy1:.1f}"
        buildings.extend(
            replace(w, complex=key) for w in _trace_crop(crop, cx0, cy1, keep)
        )
    return buildings


def _trace_crop(
    rgba: npt.NDArray[np.uint8], x0: float, y1: float, keep: Polygon | None
) -> list[TopoBuilding]:
    """Buildings in a crop; those touching its edge are left out (see trace_buildings)."""
    alpha = rgba[..., 3] > 0
    distances = np.stack([_colour_distance(rgba, c) for c in FILLS])
    nearest = distances.argmin(axis=0)
    closest = distances.min(axis=0)
    fill = alpha & (closest < FILL_DISTANCE)
    # Roof lines are grey: away from every fill colour, and brighter than the outline.
    brightness = rgba[..., :3].astype(np.int32).sum(axis=-1)
    line = alpha & (closest >= LINE_FILL_DISTANCE) & (brightness > LINE_BRIGHTNESS_MIN)
    # Dark outlines (with the blended pixels beside them) separate buildings and the
    # wings of one; grey roof lines are drawn inside and join the pieces of one roof.
    outline = ndimage.binary_dilation(alpha & (brightness < OUTLINE_BRIGHTNESS_MAX))
    line &= ~outline
    core = (fill | (line & ndimage.binary_dilation(fill, iterations=2))) & ~outline
    labels, n = ndimage.label(core)
    if n == 0:
        return []
    transform = from_origin(x0, y1, PIXEL_M, PIXEL_M)
    touching = set(
        np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    )
    buildings = []
    # Roof lines lie inside; the outline's blended edge pixels look alike, so skip them.
    inner = ndimage.binary_erosion(core, iterations=EDGE_PIXELS)
    rows, cols = np.nonzero(line & inner)
    line_label = labels[rows, cols]
    with _SHAPES_LOCK:
        traced = list(shapes(labels.astype(np.int32), mask=core, transform=transform))
    for geometry, value in traced:
        label = int(value)
        if label in touching:
            continue  # cut by the tile edge; whole in the neighbouring tile
        poly = shape(geometry)
        if not isinstance(poly, Polygon) or poly.area < MIN_AREA_M2:
            continue
        if keep is not None and not keep.contains(poly.centroid):
            continue
        tidy = _tidy(Polygon(poly.exterior))
        if tidy is None or tidy.is_empty:
            continue
        mine = line_label == label
        px = x0 + (cols[mine] + 0.5) * PIXEL_M
        py = y1 - (rows[mine] + 0.5) * PIXEL_M
        lines: list[RoofLine] = []
        if len(px):
            angle = _main_angle(tidy)
            cx, cy = tidy.centroid.x, tidy.centroid.y
            directions = [
                angle,
                angle + math.pi / 2,
                angle + math.pi / 4,
                angle - math.pi / 4,
            ]
            found = _segments(px - cx, py - cy, directions)
            lines = [
                RoofLine(s.x0 + cx, s.y0 + cy, s.x1 + cx, s.y1 + cy) for s in found
            ]
        # The building's use: its most common fill colour.
        kinds = nearest[(labels == label) & fill]
        category = (
            list(FILLS.values())[int(np.bincount(kinds).argmax())]
            if len(kinds)
            else None
        )
        buildings.append(TopoBuilding(tidy, tuple(lines), category))
    return buildings


def fetch_topo_buildings(
    epsg: int, extent: Extent, cache_dir: Path
) -> list[TopoBuilding]:
    """Buildings with roof lines within ``extent``; empty (with a warning) on failure."""
    try:
        buildings = read_layer(
            LAYER,
            epsg,
            extent,
            cache_dir,
            pixel_m=PIXEL_M,
            tile_m=TILE_M,
            overlap_m=OVERLAP_M,
            reader=lambda rgba, x0, y1, keep: trace_buildings(rgba, x0, y1, keep),
        )
    except DownloadError as exc:
        log.warning("No buildings from Kartverket's map: %s", exc)
        return []
    log.info(
        "Traced %d buildings (%d with roof lines) from Kartverket's map",
        len(buildings),
        sum(bool(b.lines) for b in buildings),
    )
    return buildings
