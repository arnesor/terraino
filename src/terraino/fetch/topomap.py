"""Kartverket's topographic map (Topo), from its WMTS tile cache.

A mapless world shows this map on the ground and in the map view, in place of an
orienteering map. The cache serves it in ETRS89 / UTM zones 32, 33 and 35, so the
tiles are fetched in the world's own zone and need no reprojection. Licensed CC BY 4.0.
"""

from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.transform import Affine

from terraino.fetch.cache import cached_download
from terraino.ingest.georef import Extent
from terraino.ingest.image import ImageMap

log = logging.getLogger(__name__)

TILE_URL = (
    "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/"
    "{matrix_set}/{level}/{row}/{col}.png"
)
ATTRIBUTION = "© Kartverket (topographic map, CC BY 4.0)"
# Tile matrix sets of the cache (from its WMTSCapabilities.xml): name and west edge.
MATRIX_SETS = {
    25832: ("utm32n", -2_000_000.0),
    25833: ("utm33n", -2_500_000.0),
    25835: ("utm35n", -3_500_000.0),
}
MATRIX_TOP = 9_045_984.0
LEVEL_0_M_PER_PX = 21_664.0
TILE_PX = 256
# 0.66 m per pixel: the finest level that is still drawn for a map, not a plan.
LEVEL = 15
PARALLEL_DOWNLOADS = 4


def tile_size_m(level: int = LEVEL) -> float:
    """Ground size of one tile at ``level``.

    Examples:
        >>> tile_size_m(15)
        169.25
    """
    return TILE_PX * LEVEL_0_M_PER_PX / float(2**level)


def tile_range(epsg: int, extent: Extent, level: int = LEVEL) -> tuple[range, range]:
    """Rows and columns of the tiles covering ``extent``.

    Examples:
        >>> tile_range(25833, Extent(193986, 6622759, 194186, 6622959))
        (range(14316, 14318), range(15917, 15919))
    """
    _, west = MATRIX_SETS[epsg]
    size = tile_size_m(level)
    col0 = math.floor((extent.x0 - west) / size)
    col1 = math.ceil((extent.x1 - west) / size)
    row0 = math.floor((MATRIX_TOP - extent.y1) / size)
    row1 = math.ceil((MATRIX_TOP - extent.y0) / size)
    return range(row0, row1), range(col0, col1)


def _download_tile(cache_dir: Path, epsg: int, row: int, col: int) -> Path:
    matrix_set, _ = MATRIX_SETS[epsg]
    url = TILE_URL.format(matrix_set=matrix_set, level=LEVEL, row=row, col=col)
    path = cache_dir / "kartverket" / f"topo_{matrix_set}_{LEVEL}" / f"{row}_{col}.png"
    return cached_download(url, {}, path, expect_content_type="image/png")


def fetch_topo_map(epsg: int, extent: Extent, cache_dir: Path) -> ImageMap:
    """Download and join the topographic map tiles covering ``extent``.

    Args:
        epsg: ETRS89 / UTM EPSG code of the world (25832, 25833 or 25835).
        extent: Area to cover.
        cache_dir: Folder for downloaded tiles.

    Returns:
        The map over the tiles' extent, which covers ``extent``.
    """
    rows, cols = tile_range(epsg, extent)
    cells = [(r, c) for r in rows for c in cols]
    log.info("Fetching %d topographic map tiles from Kartverket", len(cells))
    with ThreadPoolExecutor(PARALLEL_DOWNLOADS) as pool:
        paths = list(pool.map(lambda rc: _download_tile(cache_dir, epsg, *rc), cells))

    rgb = np.full((len(rows) * TILE_PX, len(cols) * TILE_PX, 3), 255, dtype=np.uint8)
    for (row, col), path in zip(cells, paths, strict=True):
        with Image.open(path) as tile:
            top = (row - rows.start) * TILE_PX
            left = (col - cols.start) * TILE_PX
            rgb[top : top + TILE_PX, left : left + TILE_PX] = np.asarray(
                tile.convert("RGB")
            )
    _, west = MATRIX_SETS[epsg]
    size = tile_size_m()
    m_per_px = size / TILE_PX
    transform = Affine(
        m_per_px,
        0,
        west + cols.start * size,
        0,
        -m_per_px,
        MATRIX_TOP - rows.start * size,
    )
    return ImageMap(rgb=rgb, transform=transform, epsg=epsg)
