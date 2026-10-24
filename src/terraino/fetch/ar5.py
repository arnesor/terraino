"""Land cover from NIBIO's AR5 map (1:5000, NLOD 2.0), decoded from its WMS.

The AR5 ``Arealtype`` WMS layer paints each land type in a fixed colour, so a rendering
at 1 m per pixel decodes back to land types. Bog (myr) is drawn as light blue hatching
on white; white pixels next to hatching are therefore bog too.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image
from scipy import ndimage

from terraino.fetch.cache import DownloadError, cached_download
from terraino.ingest.georef import Extent
from terraino.process.symbols import Ground

log = logging.getLogger(__name__)

WMS_URL = "https://wms.nibio.no/cgi-bin/ar5"
TILE_M = 1000
PARALLEL_DOWNLOADS = 3
ATTRIBUTION = "© NIBIO (AR5 arealressurskart, NLOD 2.0)"

# Legend colours of the Arealtype layer and the ground class each stands for.
_WHITE = (255, 255, 255)
_BOG_HATCH = (181, 236, 252)
PALETTE: dict[tuple[int, int, int], Ground] = {
    (255, 209, 110): Ground.FIELD,  # fulldyrka jord
    (255, 255, 76): Ground.FIELD,  # overflatedyrka jord
    (255, 255, 173): Ground.OPEN,  # innmarksbeite
    (158, 204, 115): Ground.FOREST,  # skog
    _BOG_HATCH: Ground.MARSH,  # myr
    (217, 217, 217): Ground.ROUGH,  # åpen fastmark
    (145, 231, 255): Ground.WATER,  # ferskvann
    (204, 254, 254): Ground.WATER,  # hav
    (252, 219, 214): Ground.LAWN,  # bebygd
    (179, 120, 76): Ground.PAVED,  # samferdsel
}
# Pixels further than this (RGB distance) from every legend colour are left unknown.
MAX_COLOUR_DISTANCE = 30.0


def decode_land_cover(rgb: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint8]:
    """Turn an RGB rendering of the AR5 Arealtype layer into ground classes.

    Examples:
        >>> img = np.array([[[158, 204, 115], [255, 209, 110], [181, 236, 252]],
        ...                 [[255, 255, 255], [255, 255, 255], [10, 10, 10]]], np.uint8)
        >>> decode_land_cover(img).tolist()
        [[1, 6, 4], [4, 4, 0]]
    """
    colours = np.array([*PALETTE, _WHITE], dtype=np.float32)
    classes = np.array([*PALETTE.values(), Ground.UNKNOWN], dtype=np.uint8)
    pixels = rgb[..., :3].reshape(-1, 3)
    packed = (pixels[:, 0].astype(np.int32) << 16) | (
        pixels[:, 1].astype(np.int32) << 8
    )
    packed |= pixels[:, 2]
    keys = (colours[:, 0].astype(np.int32) << 16) | (
        colours[:, 1].astype(np.int32) << 8
    )
    keys |= colours[:, 2].astype(np.int32)

    # Most pixels have an exact legend colour; only antialiased edges need a search.
    nearest = np.full(len(pixels), -1, dtype=np.int64)
    for index, key in enumerate(keys):
        nearest[packed == key] = index
    out = np.full(len(pixels), Ground.UNKNOWN, dtype=np.uint8)
    out[nearest >= 0] = classes[nearest[nearest >= 0]]
    edge = np.flatnonzero(nearest < 0)
    if len(edge):
        diff = pixels[edge, None, :].astype(np.float32) - colours[None, :, :]
        distance = np.linalg.norm(diff, axis=2)
        best = distance.argmin(axis=1)
        close = distance[np.arange(len(edge)), best] <= MAX_COLOUR_DISTANCE
        nearest[edge[close]] = best[close]
        out[edge[close]] = classes[best[close]]
    land: npt.NDArray[np.uint8] = out.reshape(rgb.shape[:2])

    # White between bog hatching lines is bog as well.
    white = (nearest == len(PALETTE)).reshape(rgb.shape[:2])
    hatch = np.all(rgb[..., :3] == _BOG_HATCH, axis=-1)
    near_hatch = ndimage.binary_dilation(hatch, iterations=4)
    land[white & near_hatch] = Ground.MARSH
    return land


def _mode_filter(classes: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint8]:
    """Replace each cell by the most common class around it (removes edge noise)."""
    counts = np.stack(
        [
            ndimage.uniform_filter((classes == g).astype(np.float32), size=3)
            for g in range(len(Ground))
        ]
    )
    filtered: npt.NDArray[np.uint8] = counts.argmax(axis=0).astype(np.uint8)
    return filtered


def _tile(epsg: int, tile: Extent, cache_dir: Path) -> Path:
    size = str(round(tile.width))
    params = {
        "service": "WMS",
        "request": "GetMap",
        "version": "1.3.0",
        "layers": "Arealtype",
        "styles": "",
        "crs": f"EPSG:{epsg}",
        "bbox": ",".join(str(int(v)) for v in tile.as_tuple()),
        "width": size,
        "height": size,
        "format": "image/png",
    }
    name = f"{int(tile.x0)}_{int(tile.y0)}.png"
    return cached_download(
        WMS_URL,
        params,
        cache_dir / "nibio" / f"ar5_{epsg}" / name,
        expect_content_type="image/png",
    )


def fetch_land_cover(
    epsg: int, extent: Extent, cache_dir: Path
) -> npt.NDArray[np.uint8] | None:
    """Return AR5 land cover as ground classes on the world's 1 m grid.

    Returns:
        Ground classes (UNKNOWN where AR5 has no data), or None if the download failed.
    """
    grid = np.zeros(extent.raster_shape(1), dtype=np.uint8)
    tiles = list(extent.grid_tiles(TILE_M))
    log.info("Fetching %d AR5 land cover tiles from NIBIO", len(tiles))
    try:
        with ThreadPoolExecutor(PARALLEL_DOWNLOADS) as pool:
            paths = list(pool.map(lambda t: _tile(epsg, t, cache_dir), tiles))
    except DownloadError as exc:
        log.warning("No AR5 land cover: %s", exc)
        return None
    for tile, path in zip(tiles, paths, strict=True):
        overlap = tile.intersection(extent)
        if overlap is None:
            continue
        with Image.open(path) as img:
            classes = decode_land_cover(np.asarray(img.convert("RGB")))
        tr0 = round(tile.y1 - overlap.y1)
        tc0 = round(overlap.x0 - tile.x0)
        gr0 = round(extent.y1 - overlap.y1)
        gc0 = round(overlap.x0 - extent.x0)
        h, w = round(overlap.height), round(overlap.width)
        grid[gr0 : gr0 + h, gc0 : gc0 + w] = classes[tr0 : tr0 + h, tc0 : tc0 + w]
    return _mode_filter(grid)
