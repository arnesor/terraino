"""Masts of power and telecom lines from Kartverket's topographic map (CC BY 4.0).

The map's ``ledning_punkt`` layer draws a dot at every mast registered in Kartverket's
detailed base map (high and low voltage, telecom). The dots are read back from a
rendering of that layer alone; each dot's centre is the mast's position, within
about 0.1 m.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import numpy.typing as npt
from scipy import ndimage
from shapely import Point, Polygon

from terraino.fetch.cache import DownloadError
from terraino.fetch.topo import read_layer
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

LAYER = "ledning_punkt"
PIXEL_M = 0.25
TILE_M = 800
OVERLAP_M = 20
# A mast's dot is about 4 m across at this resolution; bigger blobs are something else.
MAX_DOT_PIXELS = 400


def find_masts(
    rgba: npt.NDArray[np.uint8], x0: float, y1: float, keep: Polygon | None = None
) -> list[tuple[float, float]]:
    """Positions of the dots in a rendering of the mast layer.

    Examples:
        >>> img = np.zeros((40, 40, 4), np.uint8)
        >>> img[9:12, 19:22, 3] = 255  # a dot centred on pixel (10, 20)
        >>> find_masts(img, 1000.0, 2000.0)
        [(1005.125, 1997.375)]
    """
    drawn = rgba[..., 3] > 0
    labels, n = ndimage.label(drawn)
    if n == 0:
        return []
    index = np.arange(1, n + 1)
    sizes = ndimage.sum(drawn, labels, index)
    centres = np.asarray(ndimage.center_of_mass(drawn, labels, index), dtype=np.float64)
    masts = []
    for (row, col), size in zip(centres.reshape(-1, 2), sizes, strict=True):
        if size > MAX_DOT_PIXELS:
            continue
        x = x0 + (col + 0.5) * PIXEL_M
        y = y1 - (row + 0.5) * PIXEL_M
        if keep is None or keep.contains(Point(x, y)):
            masts.append((float(x), float(y)))
    return masts


def fetch_masts(
    epsg: int, extent: Extent, cache_dir: Path
) -> list[tuple[float, float]]:
    """Masts within ``extent``; empty (with a warning) if the map cannot be read."""
    try:
        masts = read_layer(
            LAYER,
            epsg,
            extent,
            cache_dir,
            pixel_m=PIXEL_M,
            tile_m=TILE_M,
            overlap_m=OVERLAP_M,
            reader=find_masts,
        )
    except DownloadError as exc:
        log.warning("No masts from Kartverket's map: %s", exc)
        return []
    log.info("Found %d masts of power and telecom lines", len(masts))
    return masts
