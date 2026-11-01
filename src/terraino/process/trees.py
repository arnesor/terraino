"""Individual trees from the laser canopy height model, adjusted to the map.

Canopy trees are found as local maxima of the canopy height model (surface minus
terrain). Trees below the canopy cannot be seen from above, so smaller trees are added
under it until each 16 m cell has as many trees as SR16 reports (or a typical number).
The orienteering map then decides where trees may stand: in forest the canopy is filled
up as above, on open land, farmland and gardens only the trees the laser finds stand,
on open land with scattered trees only a few of them, and young trees and thickets are
added where the map shows dense forest. Species come from SR16, mixed a little, because SR16 only gives the dominant species per 16 m cell; trees far from
SR16's forest, and outside it on open land, are birch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt
from scipy import ndimage

from terraino.fetch.nibio import Species
from terraino.process.layers import (
    TREES_KEEP,
    TREES_LIDAR,
    TREES_NONE,
    TREES_SCATTERED,
    GroundLayers,
)
from terraino.process.symbols import Ground

MIN_TREE_HEIGHT_M = 2.5
MAX_CANOPY_M = 60.0
# Canopy at least this high counts as forest when adding trees below the canopy.
CANOPY_M = 3.0
BLOCK_M = 16
# Trees per hectare of canopy when SR16 gives no count.
DEFAULT_TREES_PER_HA = 750.0
# Never more than one tree per this many square metres of canopy.
MIN_AREA_PER_TREE_M2 = 4.0
UNDERSTOREY_HEIGHT = (0.45, 0.9)
# Low vegetation (bushes, young trees) in the laser data: height range in metres, how
# much it must rise above the median of a LOW_VEGETATION_WINDOW wide neighbourhood.
LOW_VEGETATION_M = (0.5, MIN_TREE_HEIGHT_M)
LOW_VEGETATION_PROMINENCE_M = 0.4
LOW_VEGETATION_WINDOW = 9
YOUNG_HEIGHT_M = (1.2, 4.5)
# Thickets: dense clumps of young trees or brush that block the view, height and crown
# radius ranges in metres. They are spruce or deciduous; pine grows as spruce.
THICKET_HEIGHT_M = (3.0, 5.0)
THICKET_RADIUS_M = (1.25, 2.0)
# Scattered trees stand at least this far apart (about 40 per hectare).
SCATTERED_SPACING_M = 12.0
# Laser tree tops on the 0.5 m canopy: smoothing, and the search window (in fine cells)
# for low and for tall (TALL_TREE_M and more) trees.
FINE_SIGMA = 1.0
FINE_WINDOW = (5, 9)
TALL_TREE_M = 16.0
# Crowns end where the canopy drops below this.
CROWN_EDGE_M = 2.0
CROWN_RADIUS_M = (0.4, 7.0)
# A crown's base: this quantile of the lowest vegetation return in each of its cells.
# The laser mostly hits the upper crown; low branches show only in some cells.
CROWN_BASE_QUANTILE = 0.25
# Returns lower than this were not counted (terraino.ingest.lidar.CROWN_MIN_M), so a crown
# reaching that low has branches to the ground.
CROWN_BASE_FLOOR_M = 1.0

# Probability of each species given SR16's dominant species (spruce, pine, deciduous).
_MIX = {
    Species.SPRUCE: (0.75, 0.08, 0.17),
    Species.PINE: (0.12, 0.73, 0.15),
    Species.DECIDUOUS: (0.15, 0.10, 0.75),
    Species.NONE: (0.35, 0.25, 0.40),
}
# Where SR16 has no forest: bog and rock grow pine and birch, gardens mostly broadleaf.
_GROUND_MIX = {
    Ground.MARSH: (0.05, 0.55, 0.40),
    Ground.ROCK: (0.10, 0.75, 0.15),
    Ground.LAWN: (0.20, 0.10, 0.70),
}
# Trees outside SR16 forest are birch on open ground (verges, field edges, gardens), and
# on any ground farther than this (m) from SR16 forest, measured on a grid of this step
# (m). On bog and bare rock they keep their mix above, leaning to pine.
BIRCH_BEYOND_FOREST_M = 50.0
FOREST_DISTANCE_STEP = 4
_BIRCH_GROUND = (Ground.OPEN, Ground.ROUGH, Ground.FIELD, Ground.GRAIN, Ground.LAWN)
_PINE_GROUND = (Ground.MARSH, Ground.ROCK)
# Crown radius = a * height + b, per species (spruce narrow, broadleaf wide).
_CROWN = {
    Species.SPRUCE: (0.11, 0.4),
    Species.PINE: (0.12, 0.6),
    Species.DECIDUOUS: (0.17, 0.6),
}


@dataclass
class Trees:
    """Tree positions and sizes in grid coordinates of the world's 1 m rasters.

    Attributes:
        col: Column (east) position, in cells from the west edge, fractional.
        row: Row (south) position, in cells from the north edge, fractional.
        height: Tree height in metres.
        crown: Crown radius in metres.
        species: Species values.
        stand_grown: True for trees that grew up in a stand but now stand alone (seed
            trees left after a cut): long bare trunks, not branches to the ground.
            None means none are.
        crown_base: Where the live crown begins, as a share of the height (from the
            laser point cloud); NaN where unknown, None if unknown for all.
        thicket: True for thickets: dense clumps of young trees or brush, not single
            trees. None means none are.
        laser: True for trees found in the laser data, as opposed to those added below
            the canopy or where the map shows young forest. None means none are.
    """

    col: npt.NDArray[np.float32]
    row: npt.NDArray[np.float32]
    height: npt.NDArray[np.float32]
    crown: npt.NDArray[np.float32]
    species: npt.NDArray[np.uint8]
    stand_grown: npt.NDArray[np.bool_] | None = None
    crown_base: npt.NDArray[np.float32] | None = None
    thicket: npt.NDArray[np.bool_] | None = None
    laser: npt.NDArray[np.bool_] | None = None

    def __len__(self) -> int:
        """Number of trees."""
        return len(self.col)

    def flags(self, name: str) -> npt.NDArray[np.bool_]:
        """One of the optional flags (stand_grown, thicket, laser), all False if None."""
        value: npt.NDArray[np.bool_] | None = getattr(self, name)
        return np.zeros(len(self), dtype=bool) if value is None else value

    def take(self, mask: npt.NDArray[np.bool_]) -> Trees:
        """The trees where ``mask`` is True."""

        def part(a: npt.NDArray[Any] | None) -> npt.NDArray[Any] | None:
            return None if a is None else a[mask]

        return Trees(
            col=self.col[mask],
            row=self.row[mask],
            height=self.height[mask],
            crown=self.crown[mask],
            species=self.species[mask],
            stand_grown=part(self.stand_grown),
            crown_base=part(self.crown_base),
            thicket=part(self.thicket),
            laser=part(self.laser),
        )

    def join(self, other: Trees) -> Trees:
        """These trees and ``other``'s together."""

        def both(name: str, fill: float) -> npt.NDArray[Any] | None:
            a, b = getattr(self, name), getattr(other, name)
            if a is None and b is None:
                return None
            if name == "crown_base":
                a = np.full(len(self), fill, np.float32) if a is None else a
                b = np.full(len(other), fill, np.float32) if b is None else b
                return np.concatenate([a, b])
            return np.concatenate([self.flags(name), other.flags(name)])

        return Trees(
            col=np.concatenate([self.col, other.col]),
            row=np.concatenate([self.row, other.row]),
            height=np.concatenate([self.height, other.height]),
            crown=np.concatenate([self.crown, other.crown]),
            species=np.concatenate([self.species, other.species]),
            stand_grown=both("stand_grown", 0),
            crown_base=both("crown_base", np.nan),
            thicket=both("thicket", 0),
            laser=both("laser", 0),
        )


@dataclass
class TreeTops:
    """Tree tops found in the laser data, on the world's 1 m grid.

    Attributes:
        row: Row position in cells from the north edge, fractional (cell centres at .5).
        col: Column position in cells from the west edge, fractional.
        height: Tree height in metres.
        crown: Crown radius in metres; NaN where unknown.
        crown_base: Where the live crown begins, as a share of the height; NaN where
            unknown.
        cell: Size in metres of the grid the tops were found on; positions are jittered
            within a cell of this size, so the forest does not look gridded.
    """

    row: npt.NDArray[np.float32]
    col: npt.NDArray[np.float32]
    height: npt.NDArray[np.float32]
    crown: npt.NDArray[np.float32]
    crown_base: npt.NDArray[np.float32]
    cell: float = 1.0

    def __len__(self) -> int:
        """Number of tops."""
        return len(self.row)

    def take(self, mask: npt.NDArray[np.bool_]) -> TreeTops:
        """The tops where ``mask`` is True."""
        return TreeTops(
            self.row[mask],
            self.col[mask],
            self.height[mask],
            self.crown[mask],
            self.crown_base[mask],
            self.cell,
        )

    @property
    def cells(self) -> tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]]:
        """Rows and columns of the 1 m cells the tops are in."""
        return self.row.astype(np.intp), self.col.astype(np.intp)


def canopy_height(
    dom: npt.NDArray[np.float32], dtm: npt.NDArray[np.float32]
) -> npt.NDArray[np.float32]:
    """Height of vegetation and buildings above the ground, 0 where unknown.

    Examples:
        >>> canopy_height(np.array([[110.0, np.nan]]), np.array([[100.0, 50.0]])).tolist()
        [[10.0, 0.0]]
    """
    chm: npt.NDArray[np.float32] = np.clip(
        np.nan_to_num(dom - dtm, nan=0.0), 0, MAX_CANOPY_M
    ).astype(np.float32)
    return chm


def find_tree_tops(
    chm: npt.NDArray[np.float32], min_height: float = MIN_TREE_HEIGHT_M
) -> tuple[npt.NDArray[np.intp], npt.NDArray[np.intp], npt.NDArray[np.float32]]:
    """Find tree tops as local maxima of the smoothed canopy.

    Taller trees have wider crowns, so the search window grows with height.

    Returns:
        Rows, columns and heights of the tree tops.
    """
    smooth = ndimage.gaussian_filter(chm, sigma=0.5)
    window = np.where(
        smooth < 16,
        ndimage.maximum_filter(smooth, size=3),
        ndimage.maximum_filter(smooth, size=5),
    )
    peaks = (smooth >= window) & (smooth >= min_height)
    rows, cols = np.nonzero(peaks)
    heights = ndimage.maximum_filter(chm, size=3)[rows, cols]
    return rows, cols, heights


def tops_from_canopy(chm: npt.NDArray[np.float32]) -> TreeTops:
    """Tree tops of a 1 m canopy height model (no crown sizes)."""
    rows, cols, heights = find_tree_tops(chm)
    nan = np.full(len(rows), np.nan, dtype=np.float32)
    return TreeTops(
        row=rows.astype(np.float32) + 0.5,
        col=cols.astype(np.float32) + 0.5,
        height=heights.astype(np.float32),
        crown=nan,
        crown_base=nan.copy(),
    )


def tops_from_lidar(
    canopy: npt.NDArray[np.float32],
    crown_base: npt.NDArray[np.float32],
    fine: int = 2,
    min_height: float = MIN_TREE_HEIGHT_M,
) -> TreeTops:
    """Tree tops, crown sizes and crown bases from the laser point cloud.

    The tops are local maxima of the fine canopy height model. Each crown is the area
    that drains to its top (a watershed of the canopy, down to CROWN_EDGE_M); its size
    gives the crown radius. The crown base comes from the lowest vegetation in the
    crown's 1 m cells (see CROWN_BASE_QUANTILE), measured from CROWN_BASE_FLOOR_M.

    Args:
        canopy: Canopy height on a grid ``fine`` times finer than the 1 m grid, without
            NaN.
        crown_base: Lower edge of the vegetation on the 1 m grid (NaN where unknown).
        fine: Fine cells per metre.
        min_height: Lower tops are not trees.

    Examples:
        >>> yy, xx = np.mgrid[0:40, 0:40]
        >>> cone = 10 - 1.2 * np.hypot(yy - 20, xx - 20)  # one tree, 20 x 20 m grid
        >>> canopy = np.maximum(cone, 0).astype(np.float32)
        >>> base = np.full((20, 20), 3.7, dtype=np.float32)  # crown from 3.7 m
        >>> tops = tops_from_lidar(canopy, base)
        >>> len(tops), float(tops.row[0]), float(tops.height[0])
        (1, 10.25, 10.0)
        >>> round(float(tops.crown[0]), 1), round(float(tops.crown_base[0]), 2)
        (3.3, 0.3)
    """
    smooth = ndimage.gaussian_filter(canopy, sigma=FINE_SIGMA)
    small, large = FINE_WINDOW
    window = np.where(
        smooth < TALL_TREE_M,
        ndimage.maximum_filter(smooth, size=small),
        ndimage.maximum_filter(smooth, size=large),
    )
    peaks = (smooth >= window) & (smooth >= min_height)
    del window
    fr, fc = np.nonzero(peaks)
    del peaks
    heights = ndimage.maximum_filter(canopy, size=3)[fr, fc].astype(np.float32)

    # Crowns: flood the inverted canopy from the tops.
    markers = np.zeros(canopy.shape, dtype=np.int32)
    markers[fr, fc] = np.arange(1, len(fr) + 1, dtype=np.int32)
    depth = np.clip((60.0 - smooth) * 100, 0, 65535).astype(np.uint16)
    del smooth
    labels = ndimage.watershed_ift(depth, markers)
    del depth, markers
    labels[canopy < CROWN_EDGE_M] = 0
    area = np.bincount(labels.ravel().clip(0), minlength=len(fr) + 1)[1:] / fine**2
    lo, hi = CROWN_RADIUS_M
    crown = np.clip(np.sqrt(area / np.pi), lo, hi).astype(np.float32)

    # Crown base: median over the crown's 1 m cells.
    coarse = labels[fine // 2 :: fine, fine // 2 :: fine][
        : crown_base.shape[0], : crown_base.shape[1]
    ]
    del labels
    valid = (coarse > 0) & np.isfinite(crown_base[: coarse.shape[0], : coarse.shape[1]])
    ids = coarse[valid]
    values = crown_base[: coarse.shape[0], : coarse.shape[1]][valid]
    base = np.full(len(fr), np.nan, dtype=np.float32)
    if len(ids):
        order = np.lexsort((values, ids))
        ids, values = ids[order], values[order]
        unique, start, counts = np.unique(ids, return_index=True, return_counts=True)
        base[unique - 1] = values[
            start + ((counts - 1) * CROWN_BASE_QUANTILE).astype(np.intp)
        ]
    floor = CROWN_BASE_FLOOR_M
    share = (base - floor) / np.maximum(heights - floor, 0.1)
    share = np.clip(share, 0.0, 0.95).astype(np.float32)

    return TreeTops(
        row=((fr + 0.5) / fine).astype(np.float32),
        col=((fc + 0.5) / fine).astype(np.float32),
        height=heights,
        crown=crown,
        crown_base=share,
        cell=1.0 / fine,
    )


def understorey_cells(
    chm: npt.NDArray[np.float32],
    allowed: npt.NDArray[np.bool_],
    tops: tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]],
    trees_per_ha: npt.NDArray[np.float32] | None,
    rng: np.random.Generator,
    weight: npt.NDArray[np.float32] | None = None,
    parts: npt.NDArray[np.int32] | None = None,
) -> tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]]:
    """Pick cells for trees below the canopy, so each 16 m block reaches its target.

    The target is SR16's trees per hectare (or DEFAULT_TREES_PER_HA) times the block's
    canopy share, capped at one tree per MIN_AREA_PER_TREE_M2 of canopy. Within a block
    the cells are drawn at random, more likely where ``weight`` is high (the laser hit
    vegetation below the canopy there). Cells with different non-zero ``parts`` (the
    sides of vegetation boundaries) count as blocks of their own.

    Returns:
        Rows and columns of the new trees.
    """
    rows, cols = chm.shape
    brow = np.arange(rows) // BLOCK_M
    bcol = np.arange(cols) // BLOCK_M
    nbc = int(bcol[-1]) + 1
    block = brow[:, None] * nbc + bcol[None, :]
    nblocks = int(block.max()) + 1
    if parts is not None:
        split = np.flatnonzero(parts.ravel())
        keys = block.ravel()[split] * (int(parts.max()) + 1) + parts.ravel()[split]
        unique, inverse = np.unique(keys, return_inverse=True)
        block = block.copy()
        block.ravel()[split] = nblocks + inverse
        nblocks += len(unique)

    canopy = (chm >= CANOPY_M) & allowed
    canopy_cells = np.bincount(block[canopy], minlength=nblocks)
    if trees_per_ha is None:
        density = np.full(nblocks, DEFAULT_TREES_PER_HA)
    else:
        per_ha = np.nan_to_num(trees_per_ha, nan=0.0)
        density = np.bincount(block.ravel(), per_ha.ravel(), minlength=nblocks)
        density /= np.maximum(np.bincount(block.ravel(), minlength=nblocks), 1)
    target = np.minimum(
        canopy_cells * density / 1e4, canopy_cells / MIN_AREA_PER_TREE_M2
    )
    existing = np.bincount(block[tops], minlength=nblocks)
    need = np.maximum(np.rint(target - existing), 0).astype(np.int64)

    # Random canopy cells, ranked within their block; keep the first `need` of each.
    # Weighted draw: the key u ** (1 / w) favours cells with a high weight.
    cand = np.flatnonzero(canopy.ravel() & (need[block.ravel()] > 0))
    cand_block = block.ravel()[cand]
    key = rng.random(len(cand))
    if weight is not None:
        key = -(key ** (1.0 / np.maximum(weight.ravel()[cand], 1e-3)))
    order = np.lexsort((key, cand_block))
    cand, cand_block = cand[order], cand_block[order]
    first = np.searchsorted(cand_block, cand_block, side="left")
    rank = np.arange(len(cand)) - first
    chosen = cand[rank < need[cand_block]]
    r, c = np.unravel_index(chosen, chm.shape)
    return r.astype(np.intp), c.astype(np.intp)


def pick_species(
    dominant: npt.NDArray[np.uint8],
    ground: npt.NDArray[np.uint8],
    rng: np.random.Generator,
) -> npt.NDArray[np.uint8]:
    """Draw a species for each tree from its cell's dominant species and ground."""
    probs = np.array([_MIX[Species(int(d))] for d in range(4)], dtype=np.float64)
    p = probs[dominant]
    for ground_class, mix in _GROUND_MIX.items():
        p[(dominant == Species.NONE) & (ground == ground_class)] = mix
    u = rng.random(len(dominant))
    choice = (u[:, None] > np.cumsum(p, axis=1)).sum(axis=1)
    return (np.minimum(choice, 2) + 1).astype(np.uint8)


def _birch(
    dominant: npt.NDArray[np.uint8],
    ground: npt.NDArray[np.uint8],
    rows: npt.NDArray[np.intp],
    cols: npt.NDArray[np.intp],
    stand_grown: npt.NDArray[np.bool_],
) -> npt.NDArray[np.bool_]:
    """True for trees outside SR16 forest that are birch (see BIRCH_BEYOND_FOREST_M).

    Seed trees left after a cut grew up in the forest and keep their species on open
    ground. All False if SR16 has no forest in the world at all: then it is missing.
    """
    step = FOREST_DISTANCE_STEP
    no_forest = dominant[::step, ::step] == Species.NONE
    if no_forest.all():
        return np.zeros(len(rows), dtype=bool)
    distance = ndimage.distance_transform_edt(no_forest, sampling=step)
    far = distance[rows // step, cols // step] > BIRCH_BEYOND_FOREST_M
    here = ground[rows, cols]
    open_ground = (
        (dominant[rows, cols] == Species.NONE)
        & np.isin(here, _BIRCH_GROUND)
        & ~stand_grown
    )
    birch: npt.NDArray[np.bool_] = (far | open_ground) & ~np.isin(here, _PINE_GROUND)
    return birch


def crown_radius(
    height: npt.NDArray[np.float32], species: npt.NDArray[np.uint8]
) -> npt.NDArray[np.float32]:
    """Typical crown radius of trees of these heights and species."""
    crown = np.empty_like(height)
    for sp, (a, b) in _CROWN.items():
        m = species == sp
        crown[m] = a * height[m] + b
    return np.clip(crown, 0.4, 7.0).astype(np.float32)


def allowed_tree_cells(layers: GroundLayers) -> npt.NDArray[np.bool_]:
    """Cells where trees may stand according to the map."""
    allowed: npt.NDArray[np.bool_] = (
        (layers.tree_rule != TREES_NONE)
        & ~layers.clear
        & (layers.speed > 0)
        & ~np.isin(layers.ground, [Ground.WATER, Ground.BUILDING, Ground.PAVED])
    )
    return allowed


def thin_scattered(
    rows: npt.NDArray[np.integer[Any]] | npt.NDArray[np.floating[Any]],
    cols: npt.NDArray[np.integer[Any]] | npt.NDArray[np.floating[Any]],
    heights: npt.NDArray[np.float32],
    spacing: float = SCATTERED_SPACING_M,
) -> npt.NDArray[np.bool_]:
    """Pick scattered trees: the tallest first, none closer than ``spacing`` to another.

    Where the map shows open land with scattered trees, the forest has usually been
    cut since the laser scan, leaving a few seed trees: the tallest ones.

    Returns:
        Which of the trees to keep.

    Examples:
        >>> rows = np.array([0, 0, 0, 30])
        >>> cols = np.array([0, 5, 20, 0])
        >>> heights = np.array([10, 20, 15, 5], dtype=np.float32)
        >>> thin_scattered(rows, cols, heights, spacing=12).tolist()
        [False, True, True, True]
    """
    keep = np.zeros(len(rows), dtype=bool)
    taken: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for i in np.argsort(-heights, kind="stable"):
        r, c = float(rows[i]), float(cols[i])
        gr, gc = int(r // spacing), int(c // spacing)
        near = (taken.get((gr + a, gc + b), []) for a in (-1, 0, 1) for b in (-1, 0, 1))
        if any(
            math.hypot(r - tr, c - tc) < spacing for cell in near for tr, tc in cell
        ):
            continue
        keep[i] = True
        taken.setdefault((gr, gc), []).append((r, c))
    return keep


def place_trees(
    chm: npt.NDArray[np.float32],
    layers: GroundLayers,
    species_map: npt.NDArray[np.uint8],
    trees_per_ha: npt.NDArray[np.float32] | None = None,
    seed: int = 0,
    tops: TreeTops | None = None,
    understorey_weight: npt.NDArray[np.float32] | None = None,
    sides: npt.NDArray[np.int32] | None = None,
) -> Trees:
    """Combine laser tree tops and the map into the final set of trees.

    Args:
        chm: Canopy height model on the 1 m grid.
        layers: Ground layers from the orienteering map.
        species_map: Dominant SR16 species on the 1 m grid.
        trees_per_ha: SR16 tree count on the 1 m grid, if available.
        seed: Random seed; the same inputs and seed give the same forest.
        tops: Tree tops from the laser point cloud; found in ``chm`` if not given.
        understorey_weight: Where to prefer trees below the canopy (see
            understorey_cells).
        sides: The sides of the vegetation boundaries (see
            terraino.process.boundaries); each side gets its own trees below the
            canopy.

    Returns:
        All trees.
    """
    rng = np.random.default_rng(seed)
    allowed_cells = allowed_tree_cells(layers)
    found, scattered, keep = _laser_tops(chm, layers, allowed_cells, tops)
    seed_trees = scattered[keep]
    laser = found.take(keep)
    rows, cols = laser.cells
    heights = laser.height

    ur, uc = understorey_cells(
        chm,
        allowed_cells & (layers.tree_rule == TREES_KEEP),
        (rows, cols),
        trees_per_ha,
        rng,
        understorey_weight,
        sides,
    )
    uh = chm[ur, uc] * rng.uniform(*UNDERSTOREY_HEIGHT, size=len(ur)).astype(np.float32)
    rows = np.concatenate([rows, ur])
    cols = np.concatenate([cols, uc])
    heights = np.concatenate([heights, uh]).astype(np.float32)

    # Young trees where the map shows dense forest.
    yr, yc = _draw_cells(layers.young, layers.clear, rng)
    yh = rng.uniform(*YOUNG_HEIGHT_M, size=len(yr)).astype(np.float32)

    all_rows = np.concatenate([rows, yr]).astype(np.float32)
    all_cols = np.concatenate([cols, yc]).astype(np.float32)
    all_heights = np.concatenate([heights, yh]).astype(np.float32)
    ir, ic = all_rows.astype(np.intp), all_cols.astype(np.intp)
    n = len(all_rows)
    stand_grown = np.zeros(n, dtype=bool)
    stand_grown[: len(seed_trees)] = seed_trees
    species = pick_species(species_map[ir, ic], layers.ground[ir, ic], rng)
    species[_birch(species_map, layers.ground, ir, ic, stand_grown)] = Species.DECIDUOUS

    # Tops sit on cell centres; jitter so the forest does not look gridded. The laser
    # tops keep their own (finer) positions.
    jitter = rng.uniform(-0.45, 0.45, size=(2, n)).astype(np.float32)
    jitter[:, : len(laser)] *= laser.cell
    row = all_rows + 0.5
    col = all_cols + 0.5
    row[: len(laser)] = laser.row
    col[: len(laser)] = laser.col
    crown = crown_radius(all_heights, species)
    measured = np.isfinite(laser.crown)
    crown[: len(laser)][measured] = laser.crown[measured]
    crown_base = np.full(n, np.nan, dtype=np.float32)
    crown_base[: len(laser)] = laser.crown_base
    trees = Trees(
        col=col + jitter[0],
        row=row + jitter[1],
        height=all_heights,
        crown=crown,
        species=species,
        stand_grown=stand_grown,
        crown_base=crown_base,
        laser=np.arange(n) < len(laser),
    )
    return _add_thickets(trees, layers, species_map, seed)


def _add_thickets(
    trees: Trees,
    layers: GroundLayers,
    species_map: npt.NDArray[np.uint8],
    seed: int,
) -> Trees:
    """Add thickets where the map shows dense forest, after the trees.

    Thickets draw from their own random numbers, so the trees stay the same whether
    the map has thickets or not.
    """
    rng = np.random.default_rng([seed, 1])
    rows, cols = _draw_cells(layers.thicket, layers.clear, rng)
    n = len(rows)
    height = rng.uniform(*THICKET_HEIGHT_M, size=n).astype(np.float32)
    species = pick_species(species_map[rows, cols], layers.ground[rows, cols], rng)
    no_seed_trees = np.zeros(n, dtype=bool)
    birch = _birch(species_map, layers.ground, rows, cols, no_seed_trees)
    species[birch] = Species.DECIDUOUS
    species[species == Species.PINE] = Species.SPRUCE
    jitter = rng.uniform(-0.45, 0.45, size=(2, n)).astype(np.float32)
    crown = rng.uniform(*THICKET_RADIUS_M, size=n).astype(np.float32)
    thickets = Trees(
        col=(cols + 0.5 + jitter[0]).astype(np.float32),
        row=(rows + 0.5 + jitter[1]).astype(np.float32),
        height=height,
        crown=crown,
        species=species,
        stand_grown=no_seed_trees,
        crown_base=np.full(n, np.nan, np.float32),
        thicket=np.ones(n, dtype=bool),
    )
    return trees.join(thickets)


def _draw_cells(
    per_100_m2: npt.NDArray[np.float32],
    clear: npt.NDArray[np.bool_],
    rng: np.random.Generator,
) -> tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]]:
    """Rows and columns of cells drawn with a chance of ``per_100_m2`` / 100 each.

    Examples:
        >>> density = np.full((100, 100), 10, dtype=np.float32)
        >>> rows, cols = _draw_cells(density, density < 0, np.random.default_rng(1))
        >>> 900 < len(rows) < 1100
        True
    """
    p = per_100_m2 / 100.0
    p[clear] = 0
    cells = np.flatnonzero(p > 0)
    draw = rng.random(len(cells)) < p.ravel()[cells]
    rows, cols = np.unravel_index(cells[draw], p.shape)
    return rows, cols


def _laser_tops(
    chm: npt.NDArray[np.float32],
    layers: GroundLayers,
    allowed_cells: npt.NDArray[np.bool_],
    tops: TreeTops | None,
) -> tuple[TreeTops, npt.NDArray[np.bool_], npt.NDArray[np.bool_]]:
    """Laser tree tops where the map allows trees.

    Returns:
        The tops; which are in scattered-tree areas; which to keep (all but the
        scattered ones thinned out).
    """
    found = tops if tops is not None else tops_from_canopy(chm)
    rows, cols = found.cells
    found = found.take(allowed_cells[rows, cols])
    rows, cols = found.cells
    scattered = layers.tree_rule[rows, cols] == TREES_SCATTERED
    keep = ~scattered
    keep[scattered] = thin_scattered(
        found.row[scattered], found.col[scattered], found.height[scattered]
    )
    return found, scattered, keep


def scattered_stumps(
    chm: npt.NDArray[np.float32], layers: GroundLayers, tops: TreeTops | None = None
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    """Stumps of the trees cut where the map shows scattered trees.

    The laser tree tops that ``place_trees`` leaves out of scattered-tree areas were
    usually felled after the laser scan.

    Returns:
        Rows and columns (fractional, cell centres at .5) and heights of the felled
        trees.
    """
    found, scattered, keep = _laser_tops(chm, layers, allowed_tree_cells(layers), tops)
    cut = scattered & ~keep
    return found.row[cut], found.col[cut], found.height[cut]


def low_vegetation(chm: npt.NDArray[np.float32]) -> npt.NDArray[np.bool_]:
    """Cells with bushes or young trees: low vegetation that stands out around it.

    The vegetation must be between LOW_VEGETATION_M high and stand at least
    LOW_VEGETATION_PROMINENCE_M above the median of its surroundings, so an even crop
    on a field does not count, but a bush or a small tree in the field does.

    Examples:
        >>> chm = np.zeros((20, 20), dtype=np.float32)
        >>> chm[10, 10] = 1.2  # a bush in a mown field
        >>> chm[0:5, :] = 0.8  # an even grain field
        >>> veg = low_vegetation(chm)
        >>> bool(veg[10, 10]), bool(veg[2, 10])
        (True, False)
    """
    low, high = LOW_VEGETATION_M
    surroundings = ndimage.median_filter(chm, size=LOW_VEGETATION_WINDOW)
    stands_out = chm - surroundings >= LOW_VEGETATION_PROMINENCE_M
    found: npt.NDArray[np.bool_] = (chm >= low) & (chm < high) & stands_out
    return found


def effective_canopy(
    chm: npt.NDArray[np.float32], layers: GroundLayers
) -> npt.NDArray[np.float32]:
    """Canopy height where the map allows trees, 0 elsewhere (for distant shading)."""
    canopy = chm.copy()
    # Scattered trees are too few to make a canopy.
    canopy[~np.isin(layers.tree_rule, [TREES_KEEP, TREES_LIDAR]) | layers.clear] = 0
    canopy[np.isin(layers.ground, [Ground.WATER, Ground.BUILDING, Ground.PAVED])] = 0
    return canopy
