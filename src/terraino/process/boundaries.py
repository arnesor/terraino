"""Distinct vegetation boundaries (symbol 416), seen and followed in the forest.

A vegetation boundary is a line where the forest changes sharply, in tree height, age
or species, or where the forest ends. The trees come from the laser data and SR16;
this module keeps their species and trees below the canopy apart on the two sides of
each boundary, and where the trees still do not differ, invents the difference the
map shows, since the map is almost always newer than the laser data (see
docs/adr/0004-map-wins-over-laser-at-vegetation-boundaries.md).

The map's 2 m tree-free strip along each boundary is the symbol's ``clear`` key.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from scipy import ndimage
from shapely import (
    LineString,
    get_coordinates,
    line_interpolate_point,
    line_locate_point,
)
from shapely import points as shapely_points
from shapely.ops import substring

from terraino.ingest.georef import Extent
from terraino.process.layers import GroundLayers
from terraino.process.trees import (
    Trees,
    allowed_tree_cells,
    crown_radius,
    pick_species,
)

# Cells this close to a boundary are on one of its sides. They are searched for around
# pieces of the boundary this long.
BAND_M = 50.0
SEARCH_PIECE_M = 100.0
# Trees within this distance of a boundary take their species from SR16 cells this far
# out on their own side; SR16's 16 m cells there lie wholly on that side.
SPECIES_SAMPLE_M = 20.0
# Cells this close to a boundary fill up trees below the canopy per side. A 16 m block
# a boundary passes through lies within this distance of it.
SIDE_REACH_M = 24.0
# The contrast between the two sides is measured per stretch of this length, on trees
# this far out from the line (the 2 m strip along the line has none).
STRETCH_M = 20.0
MEASURE_M = (2.0, 12.0)
# Sides are different stands when the median height of the laser trees on one is this
# many times that on the other, and this much higher; or when SR16's dominant species
# differ by this share (half the sum of the share differences).
HEIGHT_RATIO = 1.5
HEIGHT_CONTRAST_M = 5.0
SPECIES_CONTRAST = 0.3
# Map pieces of one boundary, ends this close and facing each other within this angle,
# are joined before the sides are compared.
JOIN_M = 15.0
JOIN_ANGLE_DEG = 45.0
# A side with fewer laser trees than this on a stretch is open: a forest edge.
MIN_SIDE_TREES = 3
# The map shows a side as slower or greener when its running speed is this much lower,
# or it has this many more young trees and thickets per 100 m².
SLOWER_SPEED = 0.05
GREENER_PER_100_M2 = 0.5
# Otherwise the side with laser trees this much lower, or this share fewer, changes.
LOWER_M = 1.0
FEWER_SHARE = 0.1
# The invented stand reaches this far into the forest, fades out over the next
# BAND_FADE_M and along the line over ALONG_FADE_M.
BAND_FULL_M = 30.0
BAND_FADE_M = BAND_M - BAND_FULL_M
ALONG_FADE_M = 10.0
# Edges, roads, paths and streams this close to the boundary run along it, as the
# boundary itself or beside it; farther out they end the stand.
BARRIER_FROM_M = 8.0
# A side is cut off when less than this share of it, from BARRIER_FROM_M out to
# BAND_FULL_M, is not behind such an edge: then the other side changes instead.
CUT_OFF_SHARE = 0.5
# Lowered stands: the trees keep their places, lowered to at most this share of their
# height and of the other side's median height. If the other side is lower than
# LOW_FOREST_M, the side becomes a young stand instead.
LOWERED_SHARE = 0.5
LOW_FOREST_M = 10.0
# A young stand: tree heights, and one tree per this many square metres. Beside forest
# lower than twice its middle height, it is lowered to half that forest's height.
YOUNG_STAND_HEIGHT_M = (4.0, 8.0)
YOUNG_STAND_M2_PER_TREE = 5.0


@dataclass
class ContrastReport:
    """What invent_contrast changed.

    Attributes:
        stretches: Stretches of boundary line, along all boundaries.
        lacking: Stretches whose two sides did not differ.
        young: Boundaries along which a side became a young stand.
        lowered: Boundaries along which a side's trees were lowered.
        trees: Trees removed, added or lowered.
    """

    stretches: int = 0
    lacking: int = 0
    young: int = 0
    lowered: int = 0
    trees: int = 0


@dataclass
class VegetationBoundaries:
    """The cells within BAND_M of the map's vegetation boundaries.

    Each cell belongs to its nearest boundary; the arrays hold one value per cell,
    sorted by the cell's flat index in the world's 1 m rasters.

    Attributes:
        lines: The boundaries, in projected coordinates.
        extent: The world's extent.
        shape: Rows and columns of the world's 1 m rasters.
        cell: Flat index of each cell.
        line: Index of the cell's boundary in ``lines``.
        along: Distance in metres along the boundary to the point nearest the cell.
        distance: Distance in metres from that point to the cell's centre.
        side: 1 left of the boundary (looking along it), -1 right of it.
        near_x: Easting of the nearest point on the boundary.
        near_y: Northing of the nearest point.
        away_x: East component of the unit vector from that point to the cell.
        away_y: North component of it.
    """

    lines: list[LineString]
    extent: Extent
    shape: tuple[int, int]
    cell: npt.NDArray[np.int64]
    line: npt.NDArray[np.int32]
    along: npt.NDArray[np.float32]
    distance: npt.NDArray[np.float32]
    side: npt.NDArray[np.int8]
    near_x: npt.NDArray[np.float64]
    near_y: npt.NDArray[np.float64]
    away_x: npt.NDArray[np.float32]
    away_y: npt.NDArray[np.float32]

    @classmethod
    def find(
        cls, lines: Sequence[LineString], extent: Extent, shape: tuple[int, int]
    ) -> VegetationBoundaries:
        """Find the cells near each boundary, after joining its pieces (join_pieces).

        Examples:
            >>> b = VegetationBoundaries.find(
            ...     [LineString([(10, 50), (90, 50)])], Extent(0, 0, 100, 100), (100, 100))
            >>> i = int(np.searchsorted(b.cell, 30 * 100 + 40))  # 19.5 m north of it
            >>> float(b.distance[i]), int(b.side[i]), float(b.along[i])
            (19.5, 1, 30.5)
        """
        lines = join_pieces(lines)
        parts = [
            _near_one(i, piece, start, extent, shape)
            for i, line in enumerate(lines)
            for piece, start in _search_pieces(line)
        ]
        if not parts:
            parts = [_near_one(0, LineString([(0, 0), (0, 0)]), 0, extent, (0, 0))]
        columns = [np.concatenate(c) for c in zip(*parts, strict=True)]
        cell, distance = columns[0], columns[3]
        order = np.lexsort((distance, cell))
        cell = cell[order]
        first = np.ones(len(cell), dtype=bool)
        first[1:] = cell[1:] != cell[:-1]
        keep = order[first]
        c = [col[keep] for col in columns]
        return cls(
            lines=list(lines),
            extent=extent,
            shape=shape,
            cell=c[0].astype(np.int64),
            line=c[1].astype(np.int32),
            along=c[2].astype(np.float32),
            distance=c[3].astype(np.float32),
            side=c[4].astype(np.int8),
            near_x=c[5],
            near_y=c[6],
            away_x=c[7].astype(np.float32),
            away_y=c[8].astype(np.float32),
        )

    def species(self, species_map: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint8]:
        """SR16's dominant species, each side of a boundary from its own side only.

        SR16 gives the species of 16 m cells, and a cell the boundary passes through
        has one species for both sides. Within SPECIES_SAMPLE_M of a boundary, each
        cell takes the species SPECIES_SAMPLE_M out on its own side.

        Examples:
            >>> species = np.ones((100, 100), dtype=np.uint8)
            >>> species[:40] = 3  # deciduous in the north; the boundary is at row 50
            >>> b = VegetationBoundaries.find(
            ...     [LineString([(0, 50), (100, 50)])], Extent(0, 0, 100, 100), (100, 100))
            >>> sharp = b.species(species)
            >>> [int(s) for s in sharp[[35, 45, 49, 50, 55, 75], 50]]
            [3, 3, 3, 1, 1, 1]
        """
        out = species_map.copy()
        m = self.distance < SPECIES_SAMPLE_M
        x = self.near_x[m] + self.away_x[m] * SPECIES_SAMPLE_M
        y = self.near_y[m] + self.away_y[m] * SPECIES_SAMPLE_M
        rows, cols = self._cells_at(x, y)
        out.ravel()[self.cell[m]] = species_map[rows, cols]
        return out

    def sides(self) -> npt.NDArray[np.int32]:
        """The side of its nearest boundary each cell within SIDE_REACH_M is on.

        Returns:
            0 far from the boundaries, else a number for each side of each boundary.
        """
        out = np.zeros(self.shape, dtype=np.int32)
        m = self.distance <= SIDE_REACH_M
        out.ravel()[self.cell[m]] = 1 + 2 * self.line[m] + (self.side[m] < 0)
        return out

    def invent_contrast(
        self,
        trees: Trees,
        layers: GroundLayers,
        species_map: npt.NDArray[np.uint8],
        seed: int = 0,
    ) -> tuple[Trees, ContrastReport]:
        """Make the two sides different stands where the trees do not differ.

        Per STRETCH_M of each boundary, the two sides are compared MEASURE_M out: the
        median heights of their laser trees, and their SR16 species. They are alike
        when neither side is HEIGHT_RATIO times and HEIGHT_CONTRAST_M higher than the
        other, their species differ by less than SPECIES_CONTRAST, and both have
        trees. Then one side is changed, out to BAND_FULL_M into the forest and fading
        out by BAND_M, but not beyond an edge between the map's areas, a road, path or
        stream, or another boundary, that lies more than BARRIER_FROM_M out. The side
        is the same along the whole boundary: the side the map shows as slower or
        greener; else the one with lower or fewer laser trees, or the smaller stand,
        unless it is cut off (CUT_OFF_SHARE). A side the map shows as slower or
        greener, or whose other side is under LOW_FOREST_M, becomes a young stand;
        otherwise its trees are lowered to half the other side's height. Species are
        never invented.

        Returns:
            The trees, and what was changed.
        """
        report = ContrastReport()
        if not len(self.cell):
            return trees, report
        rng = np.random.default_rng([seed, 2])
        n_lines = len(self.lines)
        n_stretches = np.array(
            [max(math.ceil(line.length / STRETCH_M), 1) for line in self.lines]
        )
        report.stretches = int(n_stretches.sum())
        offsets = np.concatenate([[0], np.cumsum(n_stretches)])

        def stretch_side(k: npt.NDArray[np.int64]) -> npt.NDArray[np.int64]:
            line = self.line[k]
            stretch = offsets[line] + np.minimum(
                (self.along[k] // STRETCH_M).astype(np.int64), n_stretches[line] - 1
            )
            return np.asarray(stretch * 2 + (self.side[k] < 0), dtype=np.int64)

        # The laser trees and SR16's species on each side of each stretch.
        entry = self._entries(trees)
        measure = (
            trees.flags("laser")
            & (entry >= 0)
            & _within(self.distance, entry, MEASURE_M)
        )
        k = entry[measure]
        heights = trees.height[measure]
        cells = np.flatnonzero(
            (self.distance >= MEASURE_M[0]) & (self.distance <= MEASURE_M[1])
        )
        lacking = _lacking(
            stretch_side(k),
            heights,
            stretch_side(cells),
            species_map.ravel()[self.cell[cells]].astype(np.int64),
            report.stretches,
        )
        report.lacking = int(lacking.sum())
        if not lacking.any():
            return trees, report

        # Per boundary: which side changes, and how.
        line_side = self.line[k].astype(np.int64) * 2 + (self.side[k] < 0)
        lines_lacking = np.zeros(n_lines, dtype=bool)
        line_of_stretch = np.repeat(np.arange(n_lines), n_stretches)
        lines_lacking[line_of_stretch[lacking]] = True
        visible = self._visible(layers, lines_lacking)
        weight = np.zeros(len(self.cell), dtype=np.float32)
        change = np.zeros((n_lines, 3), dtype=np.float32)  # young, lowered to, scale
        cells_by_line = np.argsort(self.line, kind="stable")
        starts = np.searchsorted(self.line[cells_by_line], np.arange(n_lines + 1))
        evidence = _SideEvidence.gather(self, layers, line_side, heights, visible)
        for i in np.flatnonzero(lines_lacking):
            side, change[i] = evidence.choose(int(i))
            mine = cells_by_line[starts[i] : starts[i + 1]]
            mine = mine[(self.side[mine] == side) & visible[mine]]
            stretches = lacking[offsets[i] : offsets[i + 1]]
            weight[mine] = self._weight(mine, stretches, self.lines[i].length)
        young = change[:, 0] > 0
        report.young = int((young & lines_lacking).sum())
        report.lowered = int((~young & lines_lacking).sum())
        return self._apply(trees, layers, species_map, weight, change, rng, report)

    def _entries(self, trees: Trees) -> npt.NDArray[np.int64]:
        """The index of each tree's cell in ``cell``, or -1 far from the boundaries."""
        rows = np.clip(trees.row.astype(np.int64), 0, self.shape[0] - 1)
        cols = np.clip(trees.col.astype(np.int64), 0, self.shape[1] - 1)
        flat = rows * self.shape[1] + cols
        pos = np.minimum(np.searchsorted(self.cell, flat), len(self.cell) - 1)
        return np.where(self.cell[pos] == flat, pos, -1)

    def _cells_at(
        self, x: npt.NDArray[np.float64], y: npt.NDArray[np.float64]
    ) -> tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]]:
        rows = np.clip((self.extent.y1 - y).astype(np.intp), 0, self.shape[0] - 1)
        cols = np.clip((x - self.extent.x0).astype(np.intp), 0, self.shape[1] - 1)
        return rows, cols

    def _visible(
        self, layers: GroundLayers, lines: npt.NDArray[np.bool_]
    ) -> npt.NDArray[np.bool_]:
        """Cells of these boundaries that no edge, track or boundary separates from them.

        Each cell is looked at straight from the nearest point of its boundary, from
        BARRIER_FROM_M out; the stand behind an edge belongs to something else.
        """
        barrier = _barriers(layers)
        visible = np.ones(len(self.cell), dtype=bool)
        open_ = np.flatnonzero(lines[self.line] & (self.distance > BARRIER_FROM_M))
        for step in np.arange(BARRIER_FROM_M, BAND_M, 1.0):
            open_ = open_[self.distance[open_] > step]
            if not len(open_):
                break
            x = self.near_x[open_] + self.away_x[open_] * step
            y = self.near_y[open_] + self.away_y[open_] * step
            hit = barrier[self._cells_at(x, y)]
            visible[open_[hit]] = False
            open_ = open_[~hit]
        return visible

    def _weight(
        self,
        cells: npt.NDArray[np.intp],
        lacking: npt.NDArray[np.bool_],
        length: float,
    ) -> npt.NDArray[np.float32]:
        """How much these cells of one boundary change: 1 fully, 0 not at all."""
        metres = math.ceil(length) + 1
        bad = np.zeros(metres, dtype=bool)
        for s in np.flatnonzero(lacking):
            bad[int(s * STRETCH_M) : int((s + 1) * STRETCH_M) + 1] = True
        gap = (
            ndimage.distance_transform_edt(~bad) if not bad.all() else np.zeros(metres)
        )
        along = np.clip(1 - gap / ALONG_FADE_M, 0, 1)
        at = np.clip(np.rint(self.along[cells]).astype(np.intp), 0, metres - 1)
        across = np.clip((BAND_M - self.distance[cells]) / BAND_FADE_M, 0, 1)
        weight: npt.NDArray[np.float32] = (along[at] * across).astype(np.float32)
        return weight

    def _apply(
        self,
        trees: Trees,
        layers: GroundLayers,
        species_map: npt.NDArray[np.uint8],
        weight: npt.NDArray[np.float32],
        change: npt.NDArray[np.float32],
        rng: np.random.Generator,
        report: ContrastReport,
    ) -> tuple[Trees, ContrastReport]:
        """Lower the trees, or replace them with a young stand, by ``weight``.

        ``change`` holds per boundary: 1 for a young stand, the share of their height
        to lower the trees to, and the share of YOUNG_STAND_HEIGHT_M a young stand has.
        """
        young = change[:, 0] > 0
        entry = self._entries(trees)
        line = self.line[np.maximum(entry, 0)]
        w = np.where(entry >= 0, weight[np.maximum(entry, 0)], 0)
        w[trees.flags("thicket")] = 0
        to_young = (w > 0) & young[line]
        lower = (w > 0) & ~to_young
        factor = 1 - (1 - change[line[lower], 1]) * w[lower]
        removed = to_young & (rng.random(len(trees)) < w)
        trees = trees.take(np.ones(len(trees), dtype=bool))  # a copy, changed below
        trees.height[lower] *= factor
        trees.crown[lower] *= factor
        trees = trees.take(~removed)

        stand = np.flatnonzero((weight > 0) & young[self.line])
        stand = stand[allowed_tree_cells(layers).ravel()[self.cell[stand]]]
        p = weight[stand] / YOUNG_STAND_M2_PER_TREE
        stand = stand[rng.random(len(stand)) < p]
        rows, cols = np.unravel_index(self.cell[stand], self.shape)
        n = len(stand)
        scale = change[self.line[stand], 2]
        height = (rng.uniform(*YOUNG_STAND_HEIGHT_M, size=n) * scale).astype(np.float32)
        kind = pick_species(species_map[rows, cols], layers.ground[rows, cols], rng)
        jitter = rng.uniform(-0.45, 0.45, size=(2, n))
        added = Trees(
            col=(cols + 0.5 + jitter[0]).astype(np.float32),
            row=(rows + 0.5 + jitter[1]).astype(np.float32),
            height=height,
            crown=crown_radius(height, kind),
            species=kind,
        )
        report.trees = int(lower.sum() + removed.sum() + n)
        return trees.join(added), report


@dataclass
class _SideEvidence:
    """What each side of each boundary looks like, to choose the side to change."""

    speed: npt.NDArray[np.float64]
    green: npt.NDArray[np.float64]
    height: npt.NDArray[np.float64]
    count: npt.NDArray[np.float64]
    room: npt.NDArray[np.float64]
    cells: npt.NDArray[np.float64]

    @classmethod
    def gather(
        cls,
        b: VegetationBoundaries,
        layers: GroundLayers,
        line_side: npt.NDArray[np.int64],
        heights: npt.NDArray[np.float32],
        visible: npt.NDArray[np.bool_],
    ) -> _SideEvidence:
        size = 2 * len(b.lines)
        key = b.line.astype(np.int64) * 2 + (b.side < 0)
        near = (b.distance >= MEASURE_M[0]) & (b.distance <= MEASURE_M[1])
        cells = b.cell[near]
        cells_per_side = np.maximum(np.bincount(key[near], minlength=size), 1)

        def mean(values: npt.NDArray[np.float32]) -> npt.NDArray[np.float64]:
            total = np.bincount(key[near], values.ravel()[cells], minlength=size)
            return np.asarray(total / cells_per_side, dtype=np.float64)

        green = (layers.young + layers.thicket).astype(np.float32)
        stand = (b.distance > BARRIER_FROM_M) & (b.distance <= BAND_FULL_M)
        median = np.full(size, np.nan)
        order = np.argsort(line_side, kind="stable")
        keys, starts = np.unique(line_side[order], return_index=True)
        for key_, part in zip(keys, np.split(heights[order], starts[1:]), strict=True):
            median[key_] = np.median(part)
        return cls(
            speed=mean(layers.speed),
            green=mean(green),
            height=median,
            count=np.bincount(line_side, minlength=size).astype(np.float64),
            room=np.bincount(key[visible & stand], minlength=size).astype(np.float64),
            cells=np.bincount(key[stand], minlength=size).astype(np.float64),
        )

    def choose(self, line: int) -> tuple[int, tuple[float, float, float]]:
        """The side of ``line`` to change (1 left, -1 right), and how.

        Returns:
            The side, and 1 for a young stand (else 0), the share of their height to
            lower its trees to, and the share of YOUNG_STAND_HEIGHT_M a young stand has.
        """
        sides = {1: 2 * line, -1: 2 * line + 1}
        left, right = sides[1], sides[-1]
        by_map = True
        if abs(self.speed[left] - self.speed[right]) >= SLOWER_SPEED:
            side = 1 if self.speed[left] < self.speed[right] else -1
        elif abs(self.green[left] - self.green[right]) >= GREENER_PER_100_M2:
            side = 1 if self.green[left] > self.green[right] else -1
        else:
            by_map = False
            hl, hr = self.height[left], self.height[right]
            cl, cr = self.count[left], self.count[right]
            if abs(hl - hr) >= LOWER_M:
                side = 1 if hl < hr else -1
            elif abs(cl - cr) >= FEWER_SHARE * max(cl, cr):
                side = 1 if cl < cr else -1
            else:
                side = 1 if self.room[left] <= self.room[right] else -1
            mine, theirs = sides[side], sides[-side]
            cut_off = self.room[mine] < CUT_OFF_SHARE * self.cells[mine]
            if cut_off and self.room[theirs] > self.room[mine]:
                side = -side
        own, other = self.height[sides[side]], self.height[sides[-side]]
        middle = sum(YOUNG_STAND_HEIGHT_M) / 2
        if not np.isfinite(other):
            return side, (1.0, LOWERED_SHARE, 1.0)
        scale = float(min(1.0, other / (2 * middle)))
        if by_map or other < LOW_FOREST_M:
            return side, (1.0, LOWERED_SHARE, scale)
        lowered = LOWERED_SHARE * min(1.0, other / own) if own > 0 else LOWERED_SHARE
        return side, (0.0, float(lowered), scale)


def _search_pieces(line: LineString) -> list[tuple[LineString, float]]:
    """The line in pieces of at most SEARCH_PIECE_M, and where along it each starts.

    The cells around a long, bent line fill only a small part of its bounding box,
    and finding the nearest point takes longer the more points the line has.
    """
    n = max(math.ceil(line.length / SEARCH_PIECE_M), 1)
    step = line.length / n
    pieces = []
    for k in range(n):
        piece = substring(line, k * step, (k + 1) * step)
        if isinstance(piece, LineString) and piece.length > 0:
            pieces.append((piece, k * step))
    return pieces


def _near_one(
    index: int,
    line: LineString,
    start: float,
    extent: Extent,
    shape: tuple[int, int],
) -> tuple[npt.NDArray[np.generic], ...]:
    """The cells within BAND_M of a piece of a boundary, with the values kept for them.

    ``start`` is where along the boundary the piece starts. A cell near two pieces is
    found twice; VegetationBoundaries.find keeps the nearer.
    """
    x0, y0, x1, y1 = line.bounds
    c0 = max(math.floor(x0 - BAND_M - extent.x0), 0)
    c1 = min(math.ceil(x1 + BAND_M - extent.x0), shape[1])
    r0 = max(math.floor(extent.y1 - y1 - BAND_M), 0)
    r1 = min(math.ceil(extent.y1 - y0 + BAND_M), shape[0])
    if r0 >= r1 or c0 >= c1:
        empty = np.zeros(0)
        return (empty.astype(np.int64), *(empty,) * 8)
    rows, cols = np.mgrid[r0:r1, c0:c1]
    rows, cols = rows.ravel(), cols.ravel()
    x = extent.x0 + cols + 0.5
    y = extent.y1 - rows - 0.5
    t = line_locate_point(line, shapely_points(x, y))
    near = get_coordinates(line_interpolate_point(line, t))
    dx, dy = x - near[:, 0], y - near[:, 1]
    d = np.hypot(dx, dy)
    keep = d <= BAND_M
    t, near, dx, dy, d = t[keep], near[keep], dx[keep], dy[keep], d[keep]
    ahead = get_coordinates(
        line_interpolate_point(line, np.minimum(t + 0.5, line.length))
    )
    behind = get_coordinates(line_interpolate_point(line, np.maximum(t - 0.5, 0)))
    tangent = ahead - behind
    tangent /= np.maximum(np.hypot(tangent[:, 0], tangent[:, 1]), 1e-9)[:, None]
    across = dy * tangent[:, 0] - dx * tangent[:, 1]
    side = np.where(across >= 0, 1, -1)
    on_line = d < 1e-6
    safe = np.maximum(d, 1e-6)
    away_x = np.where(on_line, -tangent[:, 1], dx / safe)
    away_y = np.where(on_line, tangent[:, 0], dy / safe)
    cell = rows[keep].astype(np.int64) * shape[1] + cols[keep]
    return (
        cell,
        np.full(len(cell), index),
        start + t,
        d,
        side,
        near[:, 0],
        near[:, 1],
        away_x,
        away_y,
    )


def _within(
    values: npt.NDArray[np.float32],
    entry: npt.NDArray[np.int64],
    limits: tuple[float, float],
) -> npt.NDArray[np.bool_]:
    v = values[np.maximum(entry, 0)]
    return (v >= limits[0]) & (v <= limits[1])


def _lacking(
    key: npt.NDArray[np.int64],
    heights: npt.NDArray[np.float32],
    cell_key: npt.NDArray[np.int64],
    species: npt.NDArray[np.int64],
    stretches: int,
) -> npt.NDArray[np.bool_]:
    """Stretches whose two sides (``key`` = stretch * 2 + right) are alike.

    Args:
        key: The stretch side of each laser tree.
        heights: The laser trees' heights.
        cell_key: The stretch side of each cell.
        species: SR16's dominant species in each cell.
        stretches: The number of stretches.

    Examples:
        >>> key = np.repeat([0, 1, 2, 3, 4, 5], 3)  # 3 stretches: 20 vs 16, 22 vs 9, 20 m
        >>> heights = np.array([19, 20, 21, 15, 16, 17, 21, 22, 23, 8, 9, 10,
        ...                     19, 20, 21, 19, 20, 21], np.float32)
        >>> species = np.array([1, 1, 1, 1, 1, 3])  # the third: spruce and deciduous
        >>> _lacking(key, heights, np.arange(6), species, 3).tolist()
        [True, False, False]
    """
    size = 2 * stretches
    count = np.bincount(key, minlength=size)
    per_species = np.bincount(cell_key * 4 + species, minlength=size * 4).reshape(
        size, 4
    )
    shares = per_species / np.maximum(per_species.sum(axis=1), 1)[:, None]
    median = np.full(size, np.nan)
    order = np.argsort(key, kind="stable")
    keys, starts = np.unique(key[order], return_index=True)
    for k, part in zip(keys, np.split(heights[order], starts[1:]), strict=True):
        median[k] = np.median(part)
    left, right = slice(0, size, 2), slice(1, size, 2)
    both = (count[left] >= MIN_SIDE_TREES) & (count[right] >= MIN_SIDE_TREES)
    low = np.minimum(median[left], median[right])
    high = np.maximum(median[left], median[right])
    taller = (high >= HEIGHT_RATIO * low) & (high - low >= HEIGHT_CONTRAST_M)
    same_species = (
        np.abs(shares[left] - shares[right]).sum(axis=1) / 2 < SPECIES_CONTRAST
    )
    lacking: npt.NDArray[np.bool_] = both & ~taller & same_species
    return lacking


def join_pieces(lines: Sequence[LineString]) -> list[LineString]:
    """Join the pieces of a boundary that the map draws as separate lines.

    Mappers break a boundary where a path crosses it, or draw it in parts. Ends within
    JOIN_M of each other, each facing the other within JOIN_ANGLE_DEG, are joined with
    a straight line, nearest ends first; a boundary is never closed into a ring.

    Examples:
        >>> pieces = [LineString([(0, 0), (40, 0)]), LineString([(90, 0), (50, 0)]),
        ...           LineString([(60, 5), (60, 40)])]  # the last one crosses at an angle
        >>> [(round(line.length), line.coords[0]) for line in join_pieces(pieces)]
        [(90, (0.0, 0.0)), (35, (60.0, 5.0))]
    """
    lines = [line for line in lines if line.length > 0]
    ends = np.array([_end(line, at_end) for line in lines for at_end in (False, True)])
    if not len(ends):
        return []
    point, out = ends[:, :2], ends[:, 2:]
    gap = point[None, :, :] - point[:, None, :]
    distance = np.hypot(gap[..., 0], gap[..., 1])
    toward = np.einsum("ik,ijk->ij", out, gap) / np.maximum(distance, 1e-9)
    facing = np.cos(np.radians(JOIN_ANGLE_DEG))
    close = (distance <= JOIN_M) & (
        (distance < 1) | ((toward >= facing) & (toward.T >= facing))
    )
    owner = np.arange(len(ends)) // 2
    close &= owner[:, None] < owner[None, :]
    group = list(range(len(lines)))

    def root(i: int) -> int:
        while group[i] != i:
            i = group[i]
        return i

    link: dict[int, int] = {}
    for a, b in sorted(
        zip(*np.nonzero(close), strict=True), key=lambda ab: distance[ab]
    ):
        a, b = int(a), int(b)
        if a in link or b in link or root(a // 2) == root(b // 2):
            continue
        link[a], link[b] = b, a
        group[root(a // 2)] = root(b // 2)

    joined = []
    done = [False] * len(lines)
    for first in range(len(ends)):
        if done[first // 2] or first in link:
            continue
        coords: list[tuple[float, ...]] = []
        end = first
        while True:
            line = end // 2
            done[line] = True
            part = list(lines[line].coords)
            coords += part if end % 2 == 0 else part[::-1]
            other = end ^ 1
            if other not in link:
                break
            end = link[other]
        joined.append(LineString(coords))
    return joined


def _end(line: LineString, at_end: bool) -> tuple[float, float, float, float]:
    """An end of the line, and the direction out of the line there."""
    length = line.length
    tip = line.interpolate(length if at_end else 0)
    inner = line.interpolate(max(length - 5, 0) if at_end else min(5, length))
    dx, dy = tip.x - inner.x, tip.y - inner.y
    norm = math.hypot(dx, dy) or 1.0
    return tip.x, tip.y, dx / norm, dy / norm


def _barriers(layers: GroundLayers) -> npt.NDArray[np.bool_]:
    """Cells that end a stand: edges between the map's areas, and cleared strips.

    The cleared strips are along roads, paths, streams, power lines and the other
    vegetation boundaries.
    """
    barrier = layers.clear.copy()
    for values, tolerance in (
        (layers.ground, 0.0),
        (layers.tree_rule, 0.0),
        (layers.speed, 0.02),
        (layers.young, 0.01),
        (layers.thicket, 0.01),
    ):
        v = values.astype(np.float32)
        for axis in (0, 1):
            edge = np.abs(np.diff(v, axis=axis)) > tolerance
            if axis == 0:
                barrier[:-1] |= edge
                barrier[1:] |= edge
            else:
                barrier[:, :-1] |= edge
                barrier[:, 1:] |= edge
    return barrier
