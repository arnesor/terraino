"""Layers of Kartverket's topographic map (Topografisk Norgeskart WMS, CC BY 4.0).

The map is drawn from Kartverket's national data, including the detailed base map, and
single layers can be requested alone on a transparent background. Buildings
(terraino.fetch.topo_buildings) and masts of power lines (terraino.fetch.masts) are read back
from such renderings.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image
from shapely import Polygon, box

from terraino.fetch.cache import cached_download
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

WMS_URL = "https://wms.geonorge.no/skwms1/wms.topo"
ATTRIBUTION = "© Kartverket (Topografisk Norgeskart, CC BY 4.0)"
PARALLEL_DOWNLOADS = 3

# Reads one tile: (pixels, west edge, north edge, the tile without its overlap).
type Reader[T] = Callable[[npt.NDArray[np.uint8], float, float, Polygon], list[T]]


def read_layer[T](
    layer: str,
    epsg: int,
    extent: Extent,
    cache_dir: Path,
    *,
    pixel_m: float,
    tile_m: float,
    overlap_m: float,
    reader: Reader[T],
) -> list[T]:
    """Render ``layer`` over ``extent`` in overlapping tiles and read each with ``reader``.

    Tiles are cached in ``cache_dir/topo``. Empty tiles are not read.

    Raises:
        DownloadError: If a tile cannot be downloaded.
    """
    size = round((tile_m + 2 * overlap_m) / pixel_m)
    tiles = [
        (float(tx), float(ty))
        for ty in np.arange(extent.y0, extent.y1, tile_m)
        for tx in np.arange(extent.x0, extent.x1, tile_m)
    ]

    def read(tile: tuple[float, float]) -> list[T]:
        tx, ty = tile
        x0, y0 = tx - overlap_m, ty - overlap_m
        x1, y1 = tx + tile_m + overlap_m, ty + tile_m + overlap_m
        params = {
            "service": "WMS",
            "version": "1.3.0",
            "request": "GetMap",
            "layers": layer,
            "styles": "",
            "crs": f"EPSG:{epsg}",
            "bbox": f"{x0},{y0},{x1},{y1}",
            "width": str(size),
            "height": str(size),
            "format": "image/png",
            "transparent": "true",
        }
        name = f"{layer}_{epsg}_{tx:.0f}_{ty:.0f}_{pixel_m}.png"
        path = cached_download(
            WMS_URL, params, cache_dir / "topo" / name, expect_content_type="image/png"
        )
        with Image.open(path) as img:
            if img.getbbox() is None:  # nothing drawn
                return []
            rgba = np.asarray(img.convert("RGBA"))
        return reader(rgba, x0, y1, box(tx, ty, tx + tile_m, ty + tile_m))

    log.info("Reading %s in %d tiles of Kartverket's map", layer, len(tiles))
    with ThreadPoolExecutor(PARALLEL_DOWNLOADS) as pool:
        parts = list(pool.map(read, tiles))
    return [item for part in parts for item in part]
