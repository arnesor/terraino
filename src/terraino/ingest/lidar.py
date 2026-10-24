"""Laser point clouds (LAZ tiles from hoydedata.no) summed up on the world's grid.

The points are read tile by tile, in parallel, and reduced to rasters:

- the canopy height model on a 0.5 m grid: the highest return above the ground,
- per 1 m cell, how much of the laser reaching the lowest layers (0.5-3 m and 3-8 m
  above the ground) is stopped there: undergrowth and understorey density,
- per 1 m cell, the lower edge of the vegetation (the lowest return 1 m or more above
  the ground): where the crowns begin.

Several datasets can be given in order of preference, for example a dense scan that
covers part of the map and a sparser one for the rest. Each cell takes its values from
the first dataset that covers it. The result is cached, as reading hundreds of
millions of points takes a while.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import laspy
import numpy as np
import numpy.typing as npt
from pyproj import Transformer
from scipy import ndimage

from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)
# laspy cannot decode the Norwegian letters in the tiles' CRS description; harmless.
logging.getLogger("laspy").setLevel(logging.ERROR)

ATTRIBUTION = "© Kartverket (laser point cloud, hoydedata.no, CC BY 4.0)"
# Bump when the rasters are computed differently, so old cache files are not used.
VERSION = 2
# Fine cells per metre for the canopy height model.
FINE = 2
GROUND_CLASS = 2
NOISE_CLASSES = (7, 18)
LOW_LAYER_M = (0.5, 3.0)
MID_LAYER_M = (3.0, 8.0)
# Vegetation returns at least this high above the ground show where crowns begin: the
# lowest of them in each cell (needing at least MIN_CROWN_RETURNS, against stray ones).
CROWN_MIN_M = 1.0
CROWN_PERCENTILE = 0.0
MIN_CROWN_RETURNS = 2
# Returns more than this far below the ground model, or above it, are noise.
BELOW_GROUND_M = 2.0
MAX_HEIGHT_M = 60.0
# A dataset covers cells within this distance of its returns.
COVERAGE_GAP_M = 2
MAX_WORKERS = 6


@dataclass
class LidarRasters:
    """Point cloud summaries on the world grid (north-up, rows from the north edge).

    Attributes:
        canopy: Highest return above the ground on a 0.5 m grid (twice the rows and
            columns of the 1 m grid); NaN where no return fell in the cell.
        coverage: True on the 1 m grid where a dataset has data.
        low: Share of the returns reaching the 0.5-3 m layer that stop in it
            (undergrowth density, 0-1); NaN without such returns.
        mid: The same for the 3-8 m layer (understorey density).
        crown_base: Lowest vegetation return 1 m or more above the ground, in metres;
            NaN where there is too little vegetation.
    """

    canopy: npt.NDArray[np.float32]
    coverage: npt.NDArray[np.bool_]
    low: npt.NDArray[np.float32]
    mid: npt.NDArray[np.float32]
    crown_base: npt.NDArray[np.float32]


@dataclass(frozen=True)
class _Tile:
    path: Path
    bounds: tuple[float, float, float, float]
    epsg: int | None


def find_tiles(folder: Path) -> list[Path]:
    """All LAZ and LAS files below ``folder``."""
    return sorted(p for p in folder.rglob("*") if p.suffix.lower() in (".laz", ".las"))


def _read_tile_info(path: Path) -> _Tile:
    with laspy.open(path) as reader:
        header = reader.header
        try:
            crs = header.parse_crs()
        except Exception:
            crs = None
        epsg = crs.to_epsg() if crs is not None else None
        return _Tile(
            path=path,
            bounds=(
                float(header.mins[0]),
                float(header.mins[1]),
                float(header.maxs[0]),
                float(header.maxs[1]),
            ),
            epsg=epsg,
        )


@dataclass
class _TileResult:
    window: tuple[int, int, int, int]  # rows r0:r1, columns c0:c1 on the 1 m grid
    canopy: npt.NDArray[np.float32]  # fine grid
    count: npt.NDArray[np.int32]
    low_hit: npt.NDArray[np.int32]
    low_reach: npt.NDArray[np.int32]
    mid_hit: npt.NDArray[np.int32]
    mid_reach: npt.NDArray[np.int32]
    crown_base: npt.NDArray[np.float32]


def _bilinear(
    grid: npt.NDArray[np.float32],
    rows: npt.NDArray[np.float64],
    cols: npt.NDArray[np.float64],
) -> npt.NDArray[np.float64]:
    """Bilinear lookup at fractional sample positions (clamped to the grid)."""
    h, w = grid.shape
    r = np.clip(rows, 0, h - 1.001)
    c = np.clip(cols, 0, w - 1.001)
    r0 = r.astype(np.intp)
    c0 = c.astype(np.intp)
    fr = r - r0
    fc = c - c0
    top = grid[r0, c0] * (1 - fc) + grid[r0, c0 + 1] * fc
    bottom = grid[r0 + 1, c0] * (1 - fc) + grid[r0 + 1, c0 + 1] * fc
    result: npt.NDArray[np.float64] = top * (1 - fr) + bottom * fr
    return result


def summarize_points(
    x: npt.NDArray[np.float64],
    y: npt.NDArray[np.float64],
    z: npt.NDArray[np.float64],
    classification: npt.NDArray[np.uint8],
    window: tuple[int, int, int, int],
    extent: Extent,
    dtm: npt.NDArray[np.float32],
) -> _TileResult:
    """Reduce points to rasters for one window of the 1 m grid.

    Args:
        x: Eastings.
        y: Northings.
        z: Heights.
        classification: ASPRS classes (2 ground, 7 and 18 noise).
        window: Rows ``r0:r1`` and columns ``c0:c1`` of the world's 1 m grid.
        extent: World extent.
        dtm: The world's terrain heights (samples at 1 m cell centres).
    """
    r0, r1, c0, c1 = window
    rows, cols = r1 - r0, c1 - c0
    fx = (x - extent.x0) * FINE - c0 * FINE
    fy = (extent.y1 - y) * FINE - r0 * FINE
    inside = (fx >= 0) & (fx < cols * FINE) & (fy >= 0) & (fy < rows * FINE)
    inside &= ~np.isin(classification, NOISE_CLASSES)
    fx, fy, z, cls = fx[inside], fy[inside], z[inside], classification[inside]
    # Height above the ground model (its samples sit at cell centres).
    ground = _bilinear(dtm, fy / FINE + r0 - 0.5, fx / FINE + c0 - 0.5)
    hz = z - ground
    ok = (hz > -BELOW_GROUND_M) & (hz < MAX_HEIGHT_M)
    fx, fy, hz, cls = fx[ok], fy[ok], hz[ok], cls[ok]

    fine_cell = fy.astype(np.intp) * (cols * FINE) + fx.astype(np.intp)
    canopy = np.full(rows * FINE * cols * FINE, -np.inf, dtype=np.float32)
    np.maximum.at(canopy, fine_cell, np.maximum(hz, 0).astype(np.float32))
    canopy[np.isinf(canopy)] = np.nan

    cell = (fy // FINE).astype(np.intp) * cols + (fx // FINE).astype(np.intp)
    n = rows * cols
    vegetation = cls != GROUND_CLASS

    def count(mask: npt.NDArray[np.bool_]) -> npt.NDArray[np.int32]:
        return np.bincount(cell[mask], minlength=n).astype(np.int32)

    lo, hi = LOW_LAYER_M
    low_hit = count(vegetation & (hz >= lo) & (hz < hi))
    low_reach = count(hz < hi)
    lo, hi = MID_LAYER_M
    mid_hit = count(vegetation & (hz >= lo) & (hz < hi))
    mid_reach = count(hz < hi)

    # Lower edge of the vegetation: a low percentile of each cell's return heights.
    crown = np.full(n, np.nan, dtype=np.float32)
    sel = vegetation & (hz >= CROWN_MIN_M)
    cc, ch = cell[sel], hz[sel]
    if len(cc):
        order = np.lexsort((ch, cc))
        cc, ch = cc[order], ch[order]
        cells, start, counts = np.unique(cc, return_index=True, return_counts=True)
        enough = counts >= MIN_CROWN_RETURNS
        pick = start + np.floor(CROWN_PERCENTILE * (counts - 1)).astype(np.intp)
        crown[cells[enough]] = ch[pick[enough]]

    return _TileResult(
        window=window,
        canopy=canopy.reshape(rows * FINE, cols * FINE),
        count=np.bincount(cell, minlength=n).astype(np.int32).reshape(rows, cols),
        low_hit=low_hit.reshape(rows, cols),
        low_reach=low_reach.reshape(rows, cols),
        mid_hit=mid_hit.reshape(rows, cols),
        mid_reach=mid_reach.reshape(rows, cols),
        crown_base=crown.reshape(rows, cols),
    )


def _window(
    bounds: tuple[float, float, float, float], extent: Extent, shape: tuple[int, int]
) -> tuple[int, int, int, int] | None:
    x0, y0, x1, y1 = bounds
    c0 = max(int(np.floor(x0 - extent.x0)), 0)
    c1 = min(int(np.ceil(x1 - extent.x0)), shape[1])
    r0 = max(int(np.floor(extent.y1 - y1)), 0)
    r1 = min(int(np.ceil(extent.y1 - y0)), shape[0])
    if c0 >= c1 or r0 >= r1:
        return None
    return r0, r1, c0, c1


def _process_tile(
    tile: _Tile,
    epsg: int,
    extent: Extent,
    window: tuple[int, int, int, int],
    dtm: npt.NDArray[np.float32],
) -> _TileResult:
    las = laspy.read(tile.path)
    x = np.asarray(las.x, dtype=np.float64)
    y = np.asarray(las.y, dtype=np.float64)
    if tile.epsg is not None and tile.epsg != epsg:
        transformer = Transformer.from_crs(tile.epsg, epsg, always_xy=True)
        x, y = transformer.transform(x, y)
    return summarize_points(
        x,
        y,
        np.asarray(las.z, dtype=np.float64),
        np.asarray(las.classification, dtype=np.uint8),
        window,
        extent,
        dtm,
    )


class _Accumulator:
    """Rasters of one dataset, filled tile by tile."""

    def __init__(self, shape: tuple[int, int]) -> None:
        self.canopy = np.full(
            (shape[0] * FINE, shape[1] * FINE), np.nan, dtype=np.float32
        )
        self.count = np.zeros(shape, dtype=np.int32)
        self.low_hit = np.zeros(shape, dtype=np.int32)
        self.low_reach = np.zeros(shape, dtype=np.int32)
        self.mid_hit = np.zeros(shape, dtype=np.int32)
        self.mid_reach = np.zeros(shape, dtype=np.int32)
        self.crown_base = np.full(shape, np.nan, dtype=np.float32)

    def add(self, t: _TileResult) -> None:
        r0, r1, c0, c1 = t.window
        fine = self.canopy[r0 * FINE : r1 * FINE, c0 * FINE : c1 * FINE]
        np.fmax(fine, t.canopy, out=fine)
        for name in ("count", "low_hit", "low_reach", "mid_hit", "mid_reach"):
            getattr(self, name)[r0:r1, c0:c1] += getattr(t, name)
        crown = self.crown_base[r0:r1, c0:c1]
        np.fmin(crown, t.crown_base, out=crown)

    def coverage(self) -> npt.NDArray[np.bool_]:
        covered: npt.NDArray[np.bool_] = ndimage.binary_dilation(
            self.count > 0, iterations=COVERAGE_GAP_M
        )
        return covered


def _cache_key(datasets: Sequence[Sequence[Path]], epsg: int, extent: Extent) -> str:
    files = [
        [[p.name, p.stat().st_size, p.stat().st_mtime_ns] for p in tiles]
        for tiles in datasets
    ]
    text = json.dumps(
        [VERSION, epsg, [extent.x0, extent.y0, extent.x1, extent.y1], files]
    )
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _share(
    hit: npt.NDArray[np.int32], reach: npt.NDArray[np.int32]
) -> npt.NDArray[np.float32]:
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(reach > 0, hit / np.maximum(reach, 1), np.nan)
    return share.astype(np.float32)


def load_lidar(
    folders: Sequence[Path],
    epsg: int,
    extent: Extent,
    dtm: npt.NDArray[np.float32],
    cache_dir: Path,
) -> LidarRasters | None:
    """Summarize the point clouds in ``folders`` (most preferred first) on the world grid.

    Args:
        folders: One folder per dataset, searched recursively for LAZ/LAS files.
        epsg: The world's coordinate system; tiles in another one are reprojected.
        extent: World extent.
        dtm: Terrain heights on the world's 1 m grid.
        cache_dir: Folder for the cached result.

    Returns:
        The rasters, or None if no tile touches the world.
    """
    shape = dtm.shape
    datasets: list[list[_Tile]] = []
    for folder in folders:
        tiles = [_read_tile_info(p) for p in find_tiles(folder)]
        touching = [t for t in tiles if _window(t.bounds, extent, shape) is not None]
        log.info(
            "Laser data in %s: %d of %d tiles touch the world",
            folder,
            len(touching),
            len(tiles),
        )
        datasets.append(touching)
    if not any(datasets):
        return None

    key = _cache_key([[t.path for t in d] for d in datasets], epsg, extent)
    cache = cache_dir / "lidar" / f"lidar_{key}.npz"
    if cache.is_file():
        log.info("Using cached laser rasters %s", cache)
        with np.load(cache) as data:
            return LidarRasters(
                canopy=data["canopy"].astype(np.float32),
                coverage=data["coverage"],
                low=data["low"].astype(np.float32),
                mid=data["mid"].astype(np.float32),
                crown_base=data["crown_base"].astype(np.float32),
            )

    merged: LidarRasters | None = None
    workers = min(MAX_WORKERS, os.cpu_count() or 1)
    for tiles in datasets:
        acc = _Accumulator(shape)
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = []
            for t in tiles:
                window = _window(t.bounds, extent, shape)
                if window is None:
                    continue
                r0, r1, c0, c1 = window
                # One extra sample around the window for the ground lookup.
                pr0, pc0 = max(r0 - 1, 0), max(c0 - 1, 0)
                pad = dtm[pr0 : min(r1 + 1, shape[0]), pc0 : min(c1 + 1, shape[1])]
                sub = Extent(
                    extent.x0 + pc0,
                    extent.y1 - pr0 - pad.shape[0],
                    extent.x0 + pc0 + pad.shape[1],
                    extent.y1 - pr0,
                )
                local = (r0 - pr0, r1 - pr0, c0 - pc0, c1 - pc0)
                futures.append(
                    (
                        window,
                        local,
                        pool.submit(_process_tile, t, epsg, sub, local, pad),
                    )
                )
            for done, (window, _local, future) in enumerate(futures, 1):
                result = future.result()
                result.window = window
                acc.add(result)
                if done % 10 == 0 or done == len(futures):
                    log.info("Read %d of %d laser tiles", done, len(futures))
        rasters = LidarRasters(
            canopy=acc.canopy,
            coverage=acc.coverage(),
            low=_share(acc.low_hit, acc.low_reach),
            mid=_share(acc.mid_hit, acc.mid_reach),
            crown_base=acc.crown_base,
        )
        del acc
        merged = rasters if merged is None else _prefer(merged, rasters)

    if merged is None:
        return None
    log.info("Laser data covers %.0f %% of the world", 100 * merged.coverage.mean())
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp.npz")
    np.savez(
        tmp,
        canopy=merged.canopy.astype(np.float16),
        coverage=merged.coverage,
        low=merged.low.astype(np.float16),
        mid=merged.mid.astype(np.float16),
        crown_base=merged.crown_base.astype(np.float16),
    )
    tmp.replace(cache)
    return merged


def _prefer(first: LidarRasters, second: LidarRasters) -> LidarRasters:
    """Values from ``first`` where it has data, from ``second`` elsewhere."""
    use = first.coverage
    fine_use = np.repeat(np.repeat(use, FINE, axis=0), FINE, axis=1)
    return LidarRasters(
        canopy=np.where(fine_use, first.canopy, second.canopy),
        coverage=first.coverage | second.coverage,
        low=np.where(use, first.low, second.low),
        mid=np.where(use, first.mid, second.mid),
        crown_base=np.where(use, first.crown_base, second.crown_base),
    )


def filled_canopy(
    lidar: LidarRasters, chm: npt.NDArray[np.float32]
) -> npt.NDArray[np.float32]:
    """The fine canopy height model without gaps.

    Empty fine cells take the highest neighbour; where the laser data has no returns
    nearby (or no coverage), the 1 m canopy height model fills in.
    """
    canopy = lidar.canopy.copy()
    gaps = np.isnan(canopy)
    neighbours = ndimage.maximum_filter(np.where(gaps, -np.inf, canopy), size=3)
    fill = gaps & np.isfinite(neighbours)
    canopy[fill] = neighbours[fill]
    del neighbours
    gaps = np.isnan(canopy)
    coarse = np.repeat(np.repeat(chm, FINE, axis=0), FINE, axis=1)
    canopy[gaps] = coarse[gaps]
    return canopy


def coarse_canopy(canopy: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Highest of each 1 m cell's fine canopy cells."""
    parts = [canopy[i::FINE, j::FINE] for i in range(FINE) for j in range(FINE)]
    result: npt.NDArray[np.float32] = np.fmax.reduce(parts)
    return result
