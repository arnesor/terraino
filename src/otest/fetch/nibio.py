"""Forest data from NIBIO's SR16 forest resource map (16 m grid, NLOD 2.0).

Tree species is downloaded from NIBIO's WMS, which serves rendered images. The species
layer has three classes with fixed colours, so the image decodes exactly to classes.
When a folder with SR16 GeoTIFFs is given (downloaded from Geonorge), it is read instead,
together with tree count and crown cover, which the WMS cannot provide as numbers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path

import numpy as np
import numpy.typing as npt
import rasterio
from PIL import Image
from rasterio.warp import Resampling, reproject

from otest.fetch.cache import DownloadError, cached_download
from otest.ingest.georef import Extent

log = logging.getLogger(__name__)

WMS_URL = "https://wms.nibio.no/cgi-bin/sr16"
RESOLUTION_M = 16
NODATA = -9999
ATTRIBUTION = "© NIBIO (SR16 skogressurskart, NLOD 2.0)"


class Species(IntEnum):
    """Dominant tree species classes used by SR16."""

    NONE = 0
    SPRUCE = 1
    PINE = 2
    DECIDUOUS = 3


# Colours of the SRRTRESLAG WMS layer.
SPECIES_COLOURS = {
    (82, 176, 56): Species.SPRUCE,
    (205, 170, 101): Species.PINE,
    (255, 220, 130): Species.DECIDUOUS,
}


@dataclass(frozen=True)
class ForestData:
    """SR16 rasters resampled to the world's 1 m grid.

    Attributes:
        species: Dominant species (Species values), 0 where there is no forest.
        trees_per_ha: Trees per hectare, or None if not available.
        crown_cover: Crown cover in percent, or None if not available.
        source: Where the data came from, for the log.
    """

    species: npt.NDArray[np.uint8]
    trees_per_ha: npt.NDArray[np.float32] | None
    crown_cover: npt.NDArray[np.float32] | None
    source: str


def decode_species_image(rgb: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint8]:
    """Turn an RGB rendering of the SR16 species layer into species classes.

    Pixels with other colours (white background, antialiasing) become Species.NONE.

    Examples:
        >>> img = np.array([[[82, 176, 56], [255, 255, 255]], [[205, 170, 101],
        ...                 [255, 220, 130]]], dtype=np.uint8)
        >>> decode_species_image(img).tolist()
        [[1, 0], [2, 3]]
    """
    out = np.zeros(rgb.shape[:2], dtype=np.uint8)
    for colour, species in SPECIES_COLOURS.items():
        out[np.all(rgb[..., :3] == colour, axis=-1)] = species
    return out


def _to_world_grid(
    data: npt.NDArray[np.generic],
    src_extent: Extent,
    src_epsg: int,
    world: Extent,
    epsg: int,
    nodata: float,
) -> npt.NDArray[np.float32]:
    """Resample a 16 m raster to the world's 1 m grid (nearest neighbour)."""
    out = np.full(world.raster_shape(1), np.nan, dtype=np.float32)
    reproject(
        data.astype(np.float32),
        out,
        src_transform=src_extent.raster_transform(RESOLUTION_M),
        src_crs=f"EPSG:{src_epsg}",
        src_nodata=nodata,
        dst_transform=world.raster_transform(1),
        dst_crs=f"EPSG:{epsg}",
        dst_nodata=np.nan,
        resampling=Resampling.nearest,
    )
    return out


def _species_from_wms(
    epsg: int, extent: Extent, cache_dir: Path
) -> npt.NDArray[np.uint8]:
    grid = extent.snapped(RESOLUTION_M)
    rows, cols = grid.raster_shape(RESOLUTION_M)
    params = {
        "service": "WMS",
        "request": "GetMap",
        "version": "1.3.0",
        "layers": "SRRTRESLAG",
        "styles": "",
        "crs": f"EPSG:{epsg}",
        "bbox": ",".join(str(int(v)) for v in grid.as_tuple()),
        "width": str(cols),
        "height": str(rows),
        "format": "image/png",
    }
    name = "_".join(str(int(v)) for v in grid.as_tuple())
    path = cached_download(
        WMS_URL,
        params,
        cache_dir / "nibio" / f"treslag_{epsg}" / f"{name}.png",
        expect_content_type="image/png",
    )
    with Image.open(path) as img:
        classes = decode_species_image(np.asarray(img.convert("RGB")))
    species = _to_world_grid(classes, grid, epsg, extent, epsg, nodata=-1)
    return np.nan_to_num(species, nan=0).astype(np.uint8)


def _read_local(path: Path, world: Extent, epsg: int) -> npt.NDArray[np.float32] | None:
    if not path.is_file():
        return None
    with rasterio.open(path) as src:
        src_epsg = src.crs.to_epsg()
        window = (
            rasterio.windows.from_bounds(
                *world.buffered(2 * RESOLUTION_M).as_tuple(), transform=src.transform
            )
            .round_offsets()
            .round_lengths()
        )
        data = src.read(1, window=window, boundless=True, fill_value=NODATA)
        left, bottom, right, top = rasterio.windows.bounds(window, src.transform)
    if not (data != NODATA).any():
        return None
    return _to_world_grid(
        data, Extent(left, bottom, right, top), src_epsg, world, epsg, nodata=NODATA
    )


def _local_forest(sr16_dir: Path, epsg: int, extent: Extent) -> ForestData | None:
    def layer(name: str) -> npt.NDArray[np.float32] | None:
        matches = sorted(sr16_dir.glob(f"*_{name}.tif"))
        return _read_local(matches[0], extent, epsg) if matches else None

    species = layer("SRRTRESLAG")
    if species is None:
        return None
    return ForestData(
        species=np.nan_to_num(species, nan=0).clip(0, 3).astype(np.uint8),
        trees_per_ha=layer("SRRTREANTALL"),
        crown_cover=layer("SRRKRONEDEK"),
        source=f"local SR16 files in {sr16_dir}",
    )


def fetch_forest(
    epsg: int, extent: Extent, cache_dir: Path, sr16_dir: Path | None = None
) -> ForestData:
    """Return SR16 forest data on the world's 1 m grid.

    Args:
        epsg: EPSG code of the world.
        extent: World extent.
        cache_dir: Folder for downloads.
        sr16_dir: Optional folder with SR16 GeoTIFFs (``*_SRRTRESLAG.tif`` and others).
            Used first when it covers the area, since it holds exact values.

    Returns:
        Forest data. Species is all zero if no source was available.
    """
    if sr16_dir is not None:
        local = _local_forest(sr16_dir, epsg, extent)
        if local is not None:
            log.info("Using %s", local.source)
            return local
        log.warning("The SR16 files in %s do not cover the map", sr16_dir)
    try:
        species = _species_from_wms(epsg, extent, cache_dir)
    except DownloadError as exc:
        log.warning("No tree species available: %s", exc)
        species = np.zeros(extent.raster_shape(1), dtype=np.uint8)
    return ForestData(
        species=species, trees_per_ha=None, crown_cover=None, source="WMS"
    )
