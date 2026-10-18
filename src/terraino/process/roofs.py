"""Roofs found in a fine surface model by the way the surface faces.

A roof is made of planes, and in a shaded relief the cells of one plane all face the
same way. Inside a building's footprint each 0.5 m surface cell is given the direction
its slope faces, relative to the building's axes (one of four), or none if it is level.
Connected cells facing both ways across a ridge form a wing with a gable roof; cells
facing one way at the end of such a wing make a hipped end; other sloping patches are
shed roofs, and level patches flat roofs. Each wing gets its own rectangle and roof, so
crossing and adjoining wings give cross gables and L- and T-shaped houses.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt
from scipy import ndimage
from shapely import LineString, Point, Polygon, box

# Slopes below this (rise per metre) are level.
FLAT_SLOPE = 0.15
# The two sides of a ridge may be this many cells apart (level cells along the ridge).
RIDGE_GAP_CELLS = 2
# Parts smaller than this are ignored (chimneys, dormers, trees over the roof).
MIN_PART_M2 = 4.0
# A wing needs at least this share of its cells on each side of the ridge.
MIN_SIDE_SHARE = 0.15
# Cells are this far inside the walls; rectangle edges this close to the outline's
# extent are moved out to it.
INSET_M = 0.5
SNAP_M = 1.2
# A wing's extent: strips across it holding at least this share of the fullest strip.
CORE_SHARE = 0.4
# Wings along the same ridge (this close, at this height difference) are one wing.
MERGE_RIDGE_M = 0.8
MERGE_HEIGHT_M = 0.6
# Pitches outside this range are measurement errors.
PITCH_RANGE = (0.1, 1.5)
# The parts must explain this share of the roof, each with at most MAX_PART_RMS_M.
MIN_EXPLAINED = 0.6
MAX_PART_RMS_M = 0.4
# Roof lines from a map: pieces of one ridge lie this close; a ridge is within this share
# of the width from the middle; a ridge end this far (in half widths) short of the
# outline's end makes a hip.
LINE_MERGE_M = 0.5
MIN_RIDGE_M = 2.0
RIDGE_MIDDLE_SHARE = 0.2
HIP_SHARE = 0.5


@dataclass(frozen=True)
class RoofPart:
    """One roof over a rectangle: a wing of the building.

    Attributes:
        roof_type: ``"gable"``, ``"shed"`` or ``"flat"``.
        centre: Centre of the rectangle, projected coordinates.
        angle: Direction of the ridge (radians from east). For a shed roof, the
            direction of its high edge, the roof rising to the right of it.
        half_length: Half the rectangle's size along the ridge.
        half_width: Half its size across the ridge.
        eave: Height of the lower roof edges above the building's base.
        ridge: Height of the ridge (shed: the high edge) above the base.
        hips: Whether the start and the end of the ridge are hipped (gable only).
    """

    roof_type: str
    centre: tuple[float, float]
    angle: float
    half_length: float
    half_width: float
    eave: float
    ridge: float
    hips: tuple[bool, bool] = (False, False)

    @property
    def area(self) -> float:
        """Area of the rectangle."""
        return 4 * self.half_length * self.half_width


def robust_fit(
    feature: npt.NDArray[np.float64] | None, z: npt.NDArray[np.float64]
) -> tuple[float, float, float]:
    """Fit ``z = a + b * feature`` (or ``z = a``), ignoring chimneys and overhanging trees.

    Returns:
        ``a``, ``b`` and the RMS of the residuals of the points kept (infinite if too
        many points had to be dropped).
    """
    ones = np.ones_like(z)
    design = ones[:, None] if feature is None else np.column_stack([ones, feature])
    keep = np.ones(len(z), dtype=bool)
    coef = np.zeros(design.shape[1])
    for _ in range(2):
        coef = np.linalg.lstsq(design[keep], z[keep], rcond=None)[0]
        residual = z - design @ coef
        mad = float(np.median(np.abs(residual[keep])))
        keep = np.abs(residual) <= max(3 * 1.4826 * mad, 0.25)
        if keep.sum() < max(0.7 * len(z), 4):
            return float(coef[0]), 0.0, math.inf
    rms = float(np.sqrt(np.mean((z[keep] - design[keep] @ coef) ** 2)))
    return float(coef[0]), float(coef[1]) if len(coef) > 1 else 0.0, rms


def _frame(
    x: npt.NDArray[np.float64], y: npt.NDArray[np.float64], angle: float
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Coordinates along ``angle`` (s) and across it, to its right (t)."""
    cos, sin = math.cos(angle), math.sin(angle)
    return x * cos + y * sin, x * sin - y * cos


def _point(s: float, t: float, angle: float) -> tuple[float, float]:
    cos, sin = math.cos(angle), math.sin(angle)
    return s * cos + t * sin, s * sin - t * cos


def _snap(
    lo: float, hi: float, outline_lo: float, outline_hi: float
) -> tuple[float, float]:
    lo, hi = lo - INSET_M, hi + INSET_M
    if lo - outline_lo < SNAP_M:
        lo = outline_lo
    if outline_hi - hi < SNAP_M:
        hi = outline_hi
    return max(lo, outline_lo), min(hi, outline_hi)


def _core_range(
    values: npt.NDArray[np.float64], step: float = 0.5
) -> tuple[float, float]:
    """Range of the strips (``step`` wide) holding at least CORE_SHARE of the fullest.

    A wing's cells may run on into a narrower neighbour (the end of a crossing wing);
    the wing itself is where it is (nearly) full width.

    Examples:
        >>> values = np.concatenate([np.repeat(np.arange(0, 10, 0.5), 20), [10.2, 10.7]])
        >>> _core_range(values)
        (0.0, 9.5)
    """
    bins = np.floor(values / step).astype(np.intp)
    bins -= bins.min()
    counts = np.bincount(bins)
    full = np.flatnonzero(counts >= CORE_SHARE * counts.max())
    core = values[(bins >= full[0]) & (bins <= full[-1])]
    return float(core.min()), float(core.max())


def _rectangle(
    s: npt.NDArray[np.float64], t: npt.NDArray[np.float64], outline: Polygon
) -> tuple[float, float, float, float]:
    """Rectangle (s0, s1, t0, t1) around the cells, out to the outline where it is near.

    ``outline`` is in the same (s, t) frame. Each side snaps to the outline's extent
    within the cells' band, so a wing does not reach into a neighbouring wing.
    """
    s_lo, s_hi = _core_range(s)
    t_lo, t_hi = _core_range(t)
    big = 1e4
    across = outline.intersection(box(s_lo, -big, s_hi, big))
    along = outline.intersection(box(-big, t_lo, big, t_hi))
    if across.is_empty or along.is_empty:
        return s_lo - INSET_M, s_hi + INSET_M, t_lo - INSET_M, t_hi + INSET_M
    _, a0, _, a1 = across.bounds
    b0, _, b1, _ = along.bounds
    s0, s1 = _snap(s_lo, s_hi, b0, b1)
    t0, t1 = _snap(t_lo, t_hi, a0, a1)
    return s0, s1, t0, t1


@dataclass
class _Patch:
    """Cells of one part: positions (relative to the building centre) and heights."""

    x: npt.NDArray[np.float64]
    y: npt.NDArray[np.float64]
    z: npt.NDArray[np.float64]
    group: int  # 0: ridge along the building's axis, 1: across it; -1 level
    side: npt.NDArray[np.bool_] = field(default_factory=lambda: np.zeros(0, bool))


def _line(direction: float, cells: int) -> npt.NDArray[np.bool_]:
    """A line of cells through the centre, along ``direction`` (radians from east)."""
    size = 2 * cells + 1
    line = np.zeros((size, size), dtype=bool)
    for k in range(-cells, cells + 1):
        # Rows run south, so north is -row.
        line[
            cells - round(k * math.sin(direction)),
            cells + round(k * math.cos(direction)),
        ] = True
    return line


def _components(
    mask: npt.NDArray[np.bool_], across: float | None = None
) -> list[npt.NDArray[np.intp]]:
    """Cells of each connected part of ``mask``.

    With ``across`` (a direction), parts separated by a gap of up to RIDGE_GAP_CELLS
    in that direction join: the two sides of a ridge.
    """
    joined = mask
    if across is not None:
        joined = ndimage.binary_closing(mask, _line(across, RIDGE_GAP_CELLS)) | mask
    labels, n = ndimage.label(joined, structure=np.ones((3, 3)))
    labels[~mask] = 0
    flat = labels.ravel()
    order = np.argsort(flat, kind="stable")
    bounds = np.searchsorted(flat[order], np.arange(1, n + 2))
    return [c for c in (order[bounds[i] : bounds[i + 1]] for i in range(n)) if len(c)]


def segment_roof(
    z: npt.NDArray[np.float64],
    valid: npt.NDArray[np.bool_],
    cell_x: npt.NDArray[np.float64],
    cell_y: npt.NDArray[np.float64],
    axis: float,
    outline_x: npt.NDArray[np.float64],
    outline_y: npt.NDArray[np.float64],
    cell: float,
) -> list[RoofPart] | None:
    """Split a roof into wings and parts.

    Args:
        z: Surface heights above the building's base on a regular grid (rows north to
            south).
        valid: Cells inside the footprint (inset from the walls) with a roof height.
        cell_x: Easting of each cell centre, relative to the building's centre.
        cell_y: Northing of each cell centre, relative to the building's centre.
        axis: The building's long axis, radians from east.
        outline_x: Footprint vertices, relative to the building's centre.
        outline_y: The same, northings.
        cell: Cell size in metres.

    Returns:
        The roof parts, or None if they do not explain the surface well enough.
    """
    m = valid.astype(np.float64)
    weight = ndimage.gaussian_filter(m, 1.0)
    smooth = ndimage.gaussian_filter(np.where(valid, z, 0.0), 1.0) / np.maximum(
        weight, 1e-6
    )
    grow, gcol = np.gradient(smooth, cell)
    dzdx, dzdy = gcol, -grow
    slope = np.hypot(dzdx, dzdy)
    facing = np.arctan2(-dzdy, -dzdx)  # downhill direction
    k = np.rint(((facing - axis) % (2 * math.pi)) / (math.pi / 2)).astype(np.intp) % 4
    sloped = valid & (slope >= FLAT_SLOPE)
    min_cells = MIN_PART_M2 / cell**2

    # Wings: group 0 has its ridge along the axis (cells facing across it: k 1 and 3),
    # group 1 across it (facing along it: k 0 and 2). The high-t side faces k 3 / k 0.
    groups = ((axis, (1, 3), 3), (axis + math.pi / 2, (0, 2), 0))
    wings: list[_Patch] = []
    singles: list[_Patch] = []
    for g, (angle, classes, high) in enumerate(groups):
        mask = sloped & np.isin(k, classes)
        # The smoothed surface is level along a ridge; bridge that gap (across it).
        for idx in _components(mask, across=angle - math.pi / 2):
            r, c = np.unravel_index(idx, z.shape)
            if len(idx) < min_cells:
                continue
            side = k[r, c] == high
            patch = _Patch(cell_x[r, c], cell_y[r, c], z[r, c], g, side)
            share = side.mean()
            if MIN_SIDE_SHARE <= share <= 1 - MIN_SIDE_SHARE:
                wings.append(patch)
            else:
                singles.append(patch)
    wings = _merge_wings(wings, groups)

    outline_frames = [
        Polygon(np.column_stack(_frame(outline_x, outline_y, a))).buffer(0)
        for a, _, _ in groups
    ]
    parts: list[RoofPart] = []
    explained = 0
    wing_extents = []
    for w in wings:
        angle = groups[w.group][0]
        part, ext = _fit_wing(w, angle, outline_frames[w.group])
        if part is None:
            continue
        parts.append(part)
        wing_extents.append((len(parts) - 1, w.group, ext))
        explained += len(w.z)

    for single in singles:
        if _attach_hip(single, parts, wing_extents):
            explained += len(single.z)
            continue
        angle = groups[single.group][0]
        shed = _fit_shed(single, angle, outline_frames[single.group])
        if shed is not None:
            parts.append(shed)
            explained += len(single.z)

    level = valid & (slope < FLAT_SLOPE)
    for idx in _components(level):
        if len(idx) < min_cells:
            continue
        r, c = np.unravel_index(idx, z.shape)
        flat = _fit_flat(cell_x[r, c], cell_y[r, c], z[r, c], axis, outline_frames[0])
        if flat is not None:
            parts.append(flat)
            explained += len(idx)

    total = int(valid.sum())
    if not parts or total == 0 or explained < MIN_EXPLAINED * total:
        return None
    return _drop_hidden(parts)


def _wing_fit(
    patch: _Patch, angle: float
) -> tuple[
    float, float, float, float, npt.NDArray[np.float64], npt.NDArray[np.float64]
]:
    """Ridge position (t), ridge height, pitch and RMS of a two-sided patch."""
    s, t = _frame(patch.x, patch.y, angle)
    lo, hi = np.percentile(t, [20, 80])
    best = (0.0, 0.0, 0.0, math.inf)
    for t0 in np.arange(lo, hi + 0.01, 0.25):
        ridge, pitch, rms = robust_fit(-np.abs(t - t0), patch.z)
        if pitch > 0 and rms < best[3]:
            best = (float(t0), ridge, pitch, rms)
    return (*best, s, t)


def _merge_wings(
    wings: list[_Patch], groups: tuple[tuple[float, tuple[int, int], int], ...]
) -> list[_Patch]:
    """Join wings of a group that share a ridge (split by a crossing wing)."""
    merged = True
    while merged:
        merged = False
        fits = [_wing_fit(w, groups[w.group][0]) for w in wings]
        for i in range(len(wings)):
            for j in range(i + 1, len(wings)):
                a, b = wings[i], wings[j]
                fa, fb = fits[i], fits[j]
                if a.group != b.group or not (
                    math.isfinite(fa[3]) and math.isfinite(fb[3])
                ):
                    continue
                if (
                    abs(fa[0] - fb[0]) < MERGE_RIDGE_M
                    and abs(fa[1] - fb[1]) < MERGE_HEIGHT_M
                ):
                    wings[i] = _Patch(
                        np.concatenate([a.x, b.x]),
                        np.concatenate([a.y, b.y]),
                        np.concatenate([a.z, b.z]),
                        a.group,
                        np.concatenate([a.side, b.side]),
                    )
                    del wings[j]
                    merged = True
                    break
            if merged:
                break
    return wings


def _fit_wing(
    patch: _Patch,
    angle: float,
    outline: Polygon,
) -> tuple[RoofPart | None, tuple[float, float, float, float]]:
    t0, ridge, pitch, rms, s, t = _wing_fit(patch, angle)
    nothing = (0.0, 0.0, 0.0, 0.0)
    if not math.isfinite(rms) or rms > MAX_PART_RMS_M:
        return None, nothing
    pitch = float(np.clip(pitch, *PITCH_RANGE))
    s0, s1, t_lo, t_hi = _rectangle(s, t, outline)
    half_width = max(t0 - t_lo, t_hi - t0)
    eave = ridge - pitch * half_width
    centre = _point((s0 + s1) / 2, t0, angle)
    part = RoofPart("gable", centre, angle, (s1 - s0) / 2, half_width, eave, ridge)
    return part, (s0, s1, t0, half_width)


def _attach_hip(
    single: _Patch,
    parts: list[RoofPart],
    wings: list[tuple[int, int, tuple[float, float, float, float]]],
) -> bool:
    """Make ``single`` the hipped end of a wing whose ridge it faces along, if any."""
    for index, group, (s0, s1, t0, half_width) in wings:
        part = parts[index]
        if group == single.group:
            continue  # facing across this wing's ridge: not one of its ends
        s, t = _frame(single.x, single.y, part.angle)
        sc, tc = float(np.median(s)), float(np.median(t))
        if abs(tc - t0) > half_width:
            continue
        start = bool(sc < s0 + half_width)
        end = bool(sc > s1 - half_width)
        if not (start or end):
            continue
        hips = (part.hips[0] or start, part.hips[1] or end)
        parts[index] = RoofPart(
            part.roof_type,
            part.centre,
            part.angle,
            part.half_length,
            part.half_width,
            part.eave,
            part.ridge,
            hips,
        )
        return True
    return False


def _fit_shed(
    patch: _Patch,
    angle: float,
    outline: Polygon,
) -> RoofPart | None:
    s, t = _frame(patch.x, patch.y, angle)
    middle, slope, rms = robust_fit(t, patch.z)
    if not math.isfinite(rms) or rms > MAX_PART_RMS_M or abs(slope) < PITCH_RANGE[0]:
        return None
    s0, s1, t0, t1 = _rectangle(s, t, outline)
    tc, half = (t0 + t1) / 2, (t1 - t0) / 2
    slope = float(np.clip(abs(slope), *PITCH_RANGE)) * (1 if slope > 0 else -1)
    centre_height = middle + slope * tc
    rise = abs(slope) * half
    high = angle if slope > 0 else angle + math.pi
    # The frame of a flipped shed turns by half a turn; its centre stays put.
    centre = _point((s0 + s1) / 2, tc, angle)
    return RoofPart(
        "shed",
        centre,
        high,
        (s1 - s0) / 2,
        half,
        centre_height - rise,
        centre_height + rise,
    )


def _fit_flat(
    x: npt.NDArray[np.float64],
    y: npt.NDArray[np.float64],
    z: npt.NDArray[np.float64],
    angle: float,
    outline: Polygon,
) -> RoofPart | None:
    height, _, rms = robust_fit(None, z)
    if not math.isfinite(rms) or rms > MAX_PART_RMS_M:
        return None
    s, t = _frame(x, y, angle)
    s0, s1, t0, t1 = _rectangle(s, t, outline)
    centre = _point((s0 + s1) / 2, (t0 + t1) / 2, angle)
    return RoofPart("flat", centre, angle, (s1 - s0) / 2, (t1 - t0) / 2, height, height)


def _inside(p: RoofPart, q: RoofPart) -> bool:
    """True if the centre of ``p`` lies within the rectangle of ``q``."""
    s, t = _frame(
        np.array([p.centre[0] - q.centre[0]]),
        np.array([p.centre[1] - q.centre[1]]),
        q.angle,
    )
    return bool(abs(s[0]) < q.half_length and abs(t[0]) < q.half_width)


def _drop_hidden(parts: list[RoofPart]) -> list[RoofPart]:
    """Drop level parts within a pitched one: the cells along a ridge are level too."""
    pitched = [p for p in parts if p.roof_type != "flat"]
    return [
        p
        for p in parts
        if p.roof_type != "flat" or not any(_inside(p, q) for q in pitched)
    ]


def parts_from_lines(
    footprint: Polygon,
    lines: Sequence[tuple[float, float, float, float]],
    wall: float,
    pitch: float,
    flat: bool = False,
) -> list[RoofPart]:
    """Roof wings from a map's roof lines, with heights from a wall height and a pitch.

    A ridge is a roof line along one of the footprint's axes, in the middle of the
    footprint's width there (lines off the middle are edges of roof sections). Each
    ridge is a gable wing across the footprint; where the ridge stops well short of the
    footprint's end, that end is hipped. Without a ridge the roof is a gable along the
    long side (or flat).

    Args:
        footprint: The outline, projected coordinates.
        lines: Roof lines as (x0, y0, x1, y1).
        wall: Height of the eaves above the base.
        pitch: Roof pitch in radians.
        flat: Make a roof without ridges flat instead of a gable.

    Examples:
        >>> from shapely import box
        >>> (p,) = parts_from_lines(box(0, 0, 10, 6), [(0.5, 3, 9.5, 3)], 2.5, math.radians(30))
        >>> p.roof_type, round(math.degrees(p.angle)) % 180, p.hips, round(p.ridge, 2)
        ('gable', 0, (False, False), 4.23)
        >>> (p,) = parts_from_lines(box(0, 0, 10, 6), [(3, 3, 7, 3)], 2.5, math.radians(30))
        >>> p.hips
        (True, True)
    """
    rect = footprint.minimum_rotated_rectangle
    if not isinstance(rect, Polygon) or footprint.area <= 0:
        return []
    corners = list(rect.exterior.coords)
    edges = [
        (corners[i + 1][0] - corners[i][0], corners[i + 1][1] - corners[i][1])
        for i in range(2)
    ]
    long_edge = max(edges, key=lambda e: math.hypot(*e))
    axis = math.atan2(long_edge[1], long_edge[0])
    centre = rect.centroid
    rise = math.tan(pitch)
    found: list[tuple[float, float, float, float]] = []  # angle, offset, s0, s1
    for x0, y0, x1, y1 in lines:
        angle = math.atan2(y1 - y0, x1 - x0) % math.pi
        for a in (axis % math.pi, (axis + math.pi / 2) % math.pi):
            turn = abs(angle - a)
            if min(turn, math.pi - turn) > math.radians(10):
                continue
            s, t = _frame(
                np.array([x0 - centre.x, x1 - centre.x]),
                np.array([y0 - centre.y, y1 - centre.y]),
                a,
            )
            found.append((a, float(t.mean()), float(s.min()), float(s.max())))
    ridges: list[tuple[float, float, float, float]] = []
    for a, offset, s0, s1 in sorted(found, key=lambda f: f[3] - f[2], reverse=True):
        same = [
            i
            for i, r in enumerate(ridges)
            if abs(r[0] - a) < 1e-6 and abs(r[1] - offset) < LINE_MERGE_M
        ]
        if same:
            r = ridges[same[0]]
            ridges[same[0]] = (a, r[1], min(r[2], s0), max(r[3], s1))
        else:
            ridges.append((a, offset, s0, s1))

    ox, oy = np.asarray(footprint.exterior.coords).T
    short_half = min(math.hypot(*e) for e in edges) / 2
    candidates: list[tuple[float, RoofPart]] = []
    for a, offset, s0, s1 in ridges:
        if s1 - s0 < MIN_RIDGE_M:
            continue
        outline = Polygon(
            np.column_stack(_frame(ox - centre.x, oy - centre.y, a))
        ).buffer(0)
        band = _narrowest_band(outline, offset, s0, s1)
        if band is None:
            continue
        t0, t1 = band
        if abs(offset - (t0 + t1) / 2) > RIDGE_MIDDLE_SHARE * (t1 - t0):
            continue  # an edge between roof sections, not a ridge
        half_width = max(offset - t0, t1 - offset)
        if half_width > short_half * 1.15:
            continue  # wider than the building: a line on a roof, not a wing's ridge
        along = outline.intersection(
            box(-1e4, offset - half_width / 2, 1e4, offset + half_width / 2)
        )
        if along.is_empty:
            continue
        e0, _, e1, _ = along.bounds
        hips = (
            bool(s0 - e0 > HIP_SHARE * half_width),
            bool(e1 - s1 > HIP_SHARE * half_width),
        )
        part = RoofPart(
            "gable",
            _offset(_point((e0 + e1) / 2, offset, a), centre),
            a,
            (e1 - e0) / 2,
            half_width,
            wall,
            wall + rise * half_width,
            hips,
        )
        candidates.append((abs(offset - (t0 + t1) / 2) / (t1 - t0), part))
    # Of parallel ridges over the same stretch, the one nearest the middle is the ridge.
    parts: list[RoofPart] = []
    for _, part in sorted(candidates, key=lambda c: c[0]):
        if not any(_overlapping(part, other) for other in parts):
            parts.append(part)
    if parts:
        return parts
    long_half = max(math.hypot(*e) for e in edges) / 2
    if flat:
        return [
            RoofPart(
                "flat", (centre.x, centre.y), axis, long_half, short_half, wall, wall
            )
        ]
    return [
        RoofPart(
            "gable",
            (centre.x, centre.y),
            axis,
            long_half,
            short_half,
            wall,
            wall + rise * short_half,
        )
    ]


def _narrowest_band(
    outline: Polygon, offset: float, s0: float, s1: float
) -> tuple[float, float] | None:
    """Across-range (t0, t1) of the outline where it is narrowest along a ridge.

    At several points along the ridge, the outline's extent across it is measured on
    the piece holding the ridge; a wing crossing a wider block is as wide as its own
    narrowest part.
    """
    best: tuple[float, float] | None = None
    for f in np.linspace(0.1, 0.9, 7):
        s = s0 + (s1 - s0) * float(f)
        cut = outline.intersection(LineString([(s, -1e4), (s, 1e4)]))
        for piece in getattr(cut, "geoms", [cut]):
            if piece.is_empty or piece.geom_type != "LineString":
                continue
            _, t0, _, t1 = piece.bounds
            if t0 - 0.2 <= offset <= t1 + 0.2 and (
                best is None or t1 - t0 < best[1] - best[0]
            ):
                best = (t0, t1)
    return best


def _overlapping(p: RoofPart, q: RoofPart) -> bool:
    """True if two parallel wings cover much of the same ground."""
    turn = abs(p.angle - q.angle) % math.pi
    if min(turn, math.pi - turn) > 1e-3:
        return False
    s, t = _frame(
        np.array([p.centre[0] - q.centre[0]]),
        np.array([p.centre[1] - q.centre[1]]),
        q.angle,
    )
    overlap_s = min(p.half_length, q.half_length) - max(
        abs(float(s[0])) - max(p.half_length, q.half_length), 0
    )
    return abs(float(t[0])) < max(p.half_width, q.half_width) and overlap_s > 0.5 * min(
        p.half_length, q.half_length
    )


def _offset(point: tuple[float, float], centre: Point) -> tuple[float, float]:
    return point[0] + centre.x, point[1] + centre.y
