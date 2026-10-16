"""Individual trees from the laser canopy height model, adjusted to the map.

Canopy trees are found as local maxima of the canopy height model (surface minus
terrain). Trees below the canopy cannot be seen from above, so smaller trees are added
under it until each 16 m cell has as many trees as SR16 reports (or a typical number).
The orienteering map then decides where trees may stand, thins them on open land, and
adds young trees where the map shows dense forest. Species come from SR16, mixed a
little, because SR16 only gives the dominant species per 16 m cell.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from scipy import ndimage

from otest.fetch.nibio import Species
from otest.process.layers import TREES_NONE, TREES_SCATTERED, GroundLayers
from otest.process.symbols import Ground

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
# Share of canopy trees kept on open land with scattered trees.
SCATTERED_KEEP = 0.12
YOUNG_HEIGHT_M = (1.2, 4.5)

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
    """

    col: npt.NDArray[np.float32]
    row: npt.NDArray[np.float32]
    height: npt.NDArray[np.float32]
    crown: npt.NDArray[np.float32]
    species: npt.NDArray[np.uint8]

    def __len__(self) -> int:
        """Number of trees."""
        return len(self.col)


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


def understorey_cells(
    chm: npt.NDArray[np.float32],
    allowed: npt.NDArray[np.bool_],
    tops: tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]],
    trees_per_ha: npt.NDArray[np.float32] | None,
    rng: np.random.Generator,
) -> tuple[npt.NDArray[np.intp], npt.NDArray[np.intp]]:
    """Pick cells for trees below the canopy, so each 16 m block reaches its target.

    The target is SR16's trees per hectare (or DEFAULT_TREES_PER_HA) times the block's
    canopy share, capped at one tree per MIN_AREA_PER_TREE_M2 of canopy.

    Returns:
        Rows and columns of the new trees.
    """
    rows, cols = chm.shape
    brow = np.arange(rows) // BLOCK_M
    bcol = np.arange(cols) // BLOCK_M
    nbc = int(bcol[-1]) + 1
    block = brow[:, None] * nbc + bcol[None, :]
    nblocks = int(block.max()) + 1

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
    cand = np.flatnonzero(canopy.ravel() & (need[block.ravel()] > 0))
    cand_block = block.ravel()[cand]
    order = np.lexsort((rng.random(len(cand)), cand_block))
    cand, cand_block = cand[order], cand_block[order]
    first = np.searchsorted(cand_block, cand_block, side="left")
    rank = np.arange(len(cand)) - first
    chosen = cand[rank < need[cand_block]]
    r, c = np.unravel_index(chosen, chm.shape)
    return r.astype(np.intp), c.astype(np.intp)


def _pick_species(
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


def _crowns(
    height: npt.NDArray[np.float32], species: npt.NDArray[np.uint8]
) -> npt.NDArray[np.float32]:
    crown = np.empty_like(height)
    for sp, (a, b) in _CROWN.items():
        m = species == sp
        crown[m] = a * height[m] + b
    return np.clip(crown, 0.4, 7.0).astype(np.float32)


def _allowed(layers: GroundLayers) -> npt.NDArray[np.bool_]:
    """Cells where trees may stand according to the map."""
    allowed: npt.NDArray[np.bool_] = (
        (layers.tree_rule != TREES_NONE)
        & ~layers.clear
        & (layers.speed > 0)
        & ~np.isin(layers.ground, [Ground.WATER, Ground.BUILDING, Ground.PAVED])
    )
    return allowed


def place_trees(
    chm: npt.NDArray[np.float32],
    layers: GroundLayers,
    species_map: npt.NDArray[np.uint8],
    trees_per_ha: npt.NDArray[np.float32] | None = None,
    seed: int = 0,
) -> Trees:
    """Combine laser tree tops and the map into the final set of trees.

    Args:
        chm: Canopy height model on the 1 m grid.
        layers: Ground layers from the orienteering map.
        species_map: Dominant SR16 species on the 1 m grid.
        trees_per_ha: SR16 tree count on the 1 m grid, if available.
        seed: Random seed; the same inputs and seed give the same forest.

    Returns:
        All trees.
    """
    rng = np.random.default_rng(seed)
    allowed_cells = _allowed(layers)
    rows, cols, heights = find_tree_tops(chm)
    keep = allowed_cells[rows, cols]
    rows, cols, heights = rows[keep], cols[keep], heights[keep]

    ur, uc = understorey_cells(
        chm, allowed_cells & (layers.tree_rule == 0), (rows, cols), trees_per_ha, rng
    )
    uh = chm[ur, uc] * rng.uniform(*UNDERSTOREY_HEIGHT, size=len(ur)).astype(np.float32)
    rows = np.concatenate([rows, ur])
    cols = np.concatenate([cols, uc])
    heights = np.concatenate([heights, uh]).astype(np.float32)

    scattered = layers.tree_rule[rows, cols] == TREES_SCATTERED
    keep = ~scattered | (rng.random(len(rows)) < SCATTERED_KEEP)
    rows, cols, heights = rows[keep], cols[keep], heights[keep]

    # Young trees where the map shows dense forest: Bernoulli draw per 1 m cell.
    young_p = layers.young / 100.0
    young_p[layers.clear] = 0
    young_cells = np.flatnonzero(young_p > 0)
    draw = rng.random(len(young_cells)) < young_p.ravel()[young_cells]
    yr, yc = np.unravel_index(young_cells[draw], young_p.shape)
    yh = rng.uniform(*YOUNG_HEIGHT_M, size=len(yr)).astype(np.float32)

    all_rows = np.concatenate([rows, yr]).astype(np.float32)
    all_cols = np.concatenate([cols, yc]).astype(np.float32)
    all_heights = np.concatenate([heights, yh]).astype(np.float32)
    ir, ic = all_rows.astype(np.intp), all_cols.astype(np.intp)
    species = _pick_species(species_map[ir, ic], layers.ground[ir, ic], rng)

    # Laser tops sit on cell centres; jitter so the forest does not look gridded.
    jitter = rng.uniform(-0.45, 0.45, size=(2, len(all_rows))).astype(np.float32)
    return Trees(
        col=all_cols + 0.5 + jitter[0],
        row=all_rows + 0.5 + jitter[1],
        height=all_heights,
        crown=_crowns(all_heights, species),
        species=species,
    )


def effective_canopy(
    chm: npt.NDArray[np.float32], layers: GroundLayers
) -> npt.NDArray[np.float32]:
    """Canopy height where the map allows trees, 0 elsewhere (for distant shading)."""
    canopy = chm.copy()
    canopy[(layers.tree_rule != 0) | layers.clear] = 0
    canopy[np.isin(layers.ground, [Ground.WATER, Ground.BUILDING, Ground.PAVED])] = 0
    return canopy
