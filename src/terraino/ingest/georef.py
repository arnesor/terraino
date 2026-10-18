"""Coordinate systems and rectangular extents in projected metres."""

from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass

from rasterio.transform import Affine

# Norwegian national data is published in ETRS89 / UTM. WGS 84 / UTM is treated as the
# same system: the two differ by well under a metre, which is less than map accuracy.
_UTM_ZONES = (32, 33, 35)
_EPSG_TO_ETRS89 = {
    **{32600 + zone: 25800 + zone for zone in _UTM_ZONES},
    **{25800 + zone: 25800 + zone for zone in _UTM_ZONES},
}


class UnsupportedCrsError(ValueError):
    """The map uses a coordinate system the pipeline cannot work in."""


def etrs89_utm_epsg(epsg: int) -> int:
    """Return the ETRS89 / UTM EPSG code matching a map's EPSG code.

    Args:
        epsg: EPSG code of the map, for example 32632 (WGS 84 / UTM 32N).

    Returns:
        The ETRS89 / UTM EPSG code used by Norwegian data services.

    Raises:
        UnsupportedCrsError: If the code is not UTM zone 32, 33 or 35 north.

    Examples:
        >>> etrs89_utm_epsg(32632)
        25832
        >>> etrs89_utm_epsg(25833)
        25833
    """
    try:
        return _EPSG_TO_ETRS89[epsg]
    except KeyError:
        msg = (
            f"EPSG:{epsg} is not supported. The map must be georeferenced in "
            "UTM zone 32, 33 or 35 north (WGS 84 or ETRS89)."
        )
        raise UnsupportedCrsError(msg) from None


@dataclass(frozen=True)
class Extent:
    """An axis-aligned rectangle in projected metres.

    Attributes:
        x0: West edge (easting).
        y0: South edge (northing).
        x1: East edge (easting).
        y1: North edge (northing).
    """

    x0: float
    y0: float
    x1: float
    y1: float

    def __post_init__(self) -> None:
        """Check that the rectangle is not empty."""
        if self.x1 <= self.x0 or self.y1 <= self.y0:
            msg = f"Empty extent: {self}"
            raise ValueError(msg)

    @property
    def width(self) -> float:
        """Width in metres."""
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        """Height in metres."""
        return self.y1 - self.y0

    def as_tuple(self) -> tuple[float, float, float, float]:
        """Return ``(x0, y0, x1, y1)``."""
        return (self.x0, self.y0, self.x1, self.y1)

    def buffered(self, distance: float) -> Extent:
        """Return the extent grown by ``distance`` metres on every side."""
        return Extent(
            self.x0 - distance,
            self.y0 - distance,
            self.x1 + distance,
            self.y1 + distance,
        )

    def snapped(self, step: float) -> Extent:
        """Return the smallest extent with edges on multiples of ``step`` that covers this one.

        Examples:
            >>> Extent(10.5, 20.0, 99.0, 101.0).snapped(16)
            Extent(x0=0, y0=16, x1=112, y1=112)
        """
        return Extent(
            math.floor(self.x0 / step) * step,
            math.floor(self.y0 / step) * step,
            math.ceil(self.x1 / step) * step,
            math.ceil(self.y1 / step) * step,
        )

    def intersection(self, other: Extent) -> Extent | None:
        """Return the overlap with ``other``, or None if they do not overlap."""
        x0, y0 = max(self.x0, other.x0), max(self.y0, other.y0)
        x1, y1 = min(self.x1, other.x1), min(self.y1, other.y1)
        if x1 <= x0 or y1 <= y0:
            return None
        return Extent(x0, y0, x1, y1)

    def grid_tiles(self, size: float) -> Iterator[Extent]:
        """Yield tiles of a global grid with cell ``size`` that overlap this extent.

        The tiles are aligned to multiples of ``size``, so the same tile is reused when
        neighbouring maps are built. This is what makes download caching effective.

        Examples:
            >>> len(list(Extent(0, 0, 1500, 900).grid_tiles(1000)))
            2
        """
        snapped = self.snapped(size)
        y = snapped.y0
        while y < snapped.y1:
            x = snapped.x0
            while x < snapped.x1:
                yield Extent(x, y, x + size, y + size)
                x += size
            y += size

    def raster_shape(self, resolution: float) -> tuple[int, int]:
        """Return ``(rows, cols)`` of a raster covering the extent at ``resolution`` metres."""
        return (round(self.height / resolution), round(self.width / resolution))

    def raster_transform(self, resolution: float) -> Affine:
        """Return the affine transform of a north-up raster covering the extent."""
        return Affine(resolution, 0.0, self.x0, 0.0, -resolution, self.y1)
