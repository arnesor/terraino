"""Terrain (DTM) and surface (DOM) models from Kartverket's national height model.

The data is served by WCS 1.0.0 at 1 m resolution in ETRS89 / UTM zones 32, 33 and 35,
licensed CC BY 4.0. Requests are split into 1 km tiles on a global grid and cached.

The service for one zone does not cover the whole country: the zone 32 service has
no data in parts of eastern Norway, for example. Cells missing in the map's own zone
are filled from the other zones' services, reprojected to the map's grid.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt
import rasterio
from pyproj import Transformer
from rasterio.warp import Resampling, reproject

from otest.fetch.cache import DownloadError, cached_download
from otest.ingest.georef import Extent

log = logging.getLogger(__name__)

HeightModel = Literal["dtm", "dom"]

WCS_URL = "https://wcs.geonorge.no/skwms1/wcs.hoyde-{kind}-nhm-{epsg}"
COVERAGE = "nhm_{kind}_topo_{epsg}"
TILE_M = 1000
RESOLUTION_M = 1.0
PARALLEL_DOWNLOADS = 3
ATTRIBUTION = "© Kartverket (Nasjonal høydemodell, CC BY 4.0)"

# The service returns exactly 0.0 outside its coverage (for example in Sweden).
NO_COVERAGE_VALUE = 0.0
# Gaps are filled from the services of neighbouring UTM zones only.
NEIGHBOUR_ZONES = {25832: (25833,), 25833: (25832, 25835), 25835: (25833,)}


def _tile_path(cache_dir: Path, kind: HeightModel, epsg: int, tile: Extent) -> Path:
    name = f"{int(tile.x0)}_{int(tile.y0)}.tif"
    return cache_dir / "kartverket" / f"{kind}_{epsg}" / name


def _download_tile(cache_dir: Path, kind: HeightModel, epsg: int, tile: Extent) -> Path:
    size = str(round(tile.width / RESOLUTION_M))
    params = {
        "service": "WCS",
        "request": "GetCoverage",
        "version": "1.0.0",
        "coverage": COVERAGE.format(kind=kind, epsg=epsg),
        "crs": f"EPSG:{epsg}",
        "bbox": ",".join(str(int(v)) for v in tile.as_tuple()),
        "width": size,
        "height": size,
        "format": "GeoTIFF",
    }
    return cached_download(
        WCS_URL.format(kind=kind, epsg=epsg),
        params,
        _tile_path(cache_dir, kind, epsg, tile),
        expect_content_type="image/tiff",
    )


def _mosaic(
    kind: HeightModel, epsg: int, extent: Extent, cache_dir: Path
) -> npt.NDArray[np.float32]:
    """Download and join the tiles covering ``extent``; cells without data are NaN."""
    rows, cols = extent.raster_shape(RESOLUTION_M)
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    tiles = list(extent.grid_tiles(TILE_M))
    log.info(
        "Fetching %d %s tiles from Kartverket (EPSG:%d)", len(tiles), kind.upper(), epsg
    )
    with ThreadPoolExecutor(PARALLEL_DOWNLOADS) as pool:
        paths = list(
            pool.map(lambda t: _download_tile(cache_dir, kind, epsg, t), tiles)
        )

    for tile, path in zip(tiles, paths, strict=True):
        overlap = tile.intersection(extent)
        if overlap is None:
            continue
        with rasterio.open(path) as src:
            data = src.read(1).astype(np.float32)
        tr0 = round(tile.y1 - overlap.y1)
        tc0 = round(overlap.x0 - tile.x0)
        gr0 = round(extent.y1 - overlap.y1)
        gc0 = round(overlap.x0 - extent.x0)
        h = round(overlap.height)
        w = round(overlap.width)
        grid[gr0 : gr0 + h, gc0 : gc0 + w] = data[tr0 : tr0 + h, tc0 : tc0 + w]
    grid[grid == NO_COVERAGE_VALUE] = np.nan
    return grid


def _missing_extent(grid: npt.NDArray[np.float32], extent: Extent) -> Extent:
    rows, cols = np.nonzero(np.isnan(grid))
    return Extent(
        extent.x0 + cols.min() * RESOLUTION_M,
        extent.y1 - (rows.max() + 1) * RESOLUTION_M,
        extent.x0 + (cols.max() + 1) * RESOLUTION_M,
        extent.y1 - rows.min() * RESOLUTION_M,
    )


def _fill_from_zone(
    grid: npt.NDArray[np.float32],
    kind: HeightModel,
    epsg: int,
    extent: Extent,
    other_epsg: int,
    cache_dir: Path,
) -> None:
    """Fill NaN cells of ``grid`` (in ``epsg``) with data from the ``other_epsg`` service."""
    missing = _missing_extent(grid, extent)
    to_other = Transformer.from_crs(epsg, other_epsg, always_xy=True)
    xs, ys = to_other.transform(
        [missing.x0, missing.x1, missing.x0, missing.x1],
        [missing.y0, missing.y0, missing.y1, missing.y1],
    )
    other_extent = Extent(min(xs), min(ys), max(xs), max(ys)).buffered(2).snapped(1)
    other = _mosaic(kind, other_epsg, other_extent, cache_dir)

    filled = np.full_like(grid, np.nan)
    reproject(
        other,
        filled,
        src_transform=other_extent.raster_transform(RESOLUTION_M),
        src_crs=f"EPSG:{other_epsg}",
        src_nodata=np.nan,
        dst_transform=extent.raster_transform(RESOLUTION_M),
        dst_crs=f"EPSG:{epsg}",
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    take = np.isnan(grid) & ~np.isnan(filled)
    grid[take] = filled[take]


def fetch_height_model(
    kind: HeightModel, epsg: int, extent: Extent, cache_dir: Path
) -> npt.NDArray[np.float32]:
    """Return a 1 m height grid covering ``extent``.

    Args:
        kind: ``"dtm"`` for bare ground, ``"dom"`` for the surface incl. trees and roofs.
        epsg: ETRS89 / UTM EPSG code (25832, 25833 or 25835).
        extent: Area to cover. Its edges must lie on whole metres.
        cache_dir: Folder for downloaded tiles.

    Returns:
        A north-up float32 array of shape ``extent.raster_shape(1)``. Cells are 1 m
        squares starting at the extent's north-west corner. Cells without data are NaN.
    """
    grid = _mosaic(kind, epsg, extent, cache_dir)
    for other_epsg in NEIGHBOUR_ZONES.get(epsg, ()):
        if not np.isnan(grid).any():
            break
        log.info("Filling gaps in the %s from EPSG:%d", kind.upper(), other_epsg)
        try:
            _fill_from_zone(grid, kind, epsg, extent, other_epsg, cache_dir)
        except DownloadError as exc:
            log.warning("Could not fill gaps from EPSG:%d: %s", other_epsg, exc)

    missing = int(np.isnan(grid).sum())
    if missing:
        log.warning(
            "%s has no data for %.1f%% of the area (outside Norway or sea)",
            kind.upper(),
            100 * missing / grid.size,
        )
    return grid
