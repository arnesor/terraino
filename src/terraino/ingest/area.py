"""The chosen area of a mapless world, and the box to download laser data for.

A mapless world is built for a rectangle in EUREF89 / UTM zone 33 (EPSG:25833), the
coordinate system hoydedata.no takes its export corners in for all of Norway. The
world itself is built in the UTM zone of the rectangle's centre, as an orienteering
map of the same place would be, so the core area is the rectangle reprojected into
that zone (see docs/adr/0007-mapless-worlds-chosen-in-utm33-built-in-the-local-zone.md).
"""

# Sizes are written with a multiplication sign, as in 2370 × 2370 m.
# ruff: noqa: RUF001, RUF002, RUF003

from __future__ import annotations

import math

import numpy as np
from pyproj import Transformer
from shapely import Polygon, box

from terraino.ingest.georef import Extent

AREA_EPSG = 25833
MAX_AREA_M2 = 25e6
MIN_SIDE_M = 200.0
# A rough box around mainland Norway in UTM33: from Utvær in the west to Grense
# Jakobselv in the east, Lindesnes in the south to Knivskjellodden in the north.
NORWAY_UTM33 = Extent(-80_000, 6_440_000, 1_130_000, 7_950_000)
HOYDEDATA_STEP_M = 10.0
# Points along each side of the rectangle when it is reprojected into another zone.
_EDGE_POINTS = 20


class AreaError(ValueError):
    """The chosen area cannot be built."""


def check_area(area: Extent) -> None:
    """Refuse a rectangle that is too large, too narrow or outside Norway.

    Args:
        area: The chosen rectangle in UTM33.

    Raises:
        AreaError: If the rectangle cannot be built, with the reason.

    Examples:
        >>> check_area(Extent(193986, 6622759, 198986, 6627759))
        >>> check_area(Extent(193986, 6622759, 205073, 6628020))
        Traceback (most recent call last):
        ...
        terraino.ingest.area.AreaError: The area is 58.3 km²; it may be at most 25 km².
    """
    if area.width < MIN_SIDE_M or area.height < MIN_SIDE_M:
        msg = (
            f"The area is {area.width:.0f} × {area.height:.0f} m; "
            f"each side must be at least {MIN_SIDE_M:.0f} m."
        )
        raise AreaError(msg)
    size = area.width * area.height
    if size > MAX_AREA_M2:
        msg = (
            f"The area is {size / 1e6:.1f} km²; "
            f"it may be at most {MAX_AREA_M2 / 1e6:.0f} km²."
        )
        raise AreaError(msg)
    inside = NORWAY_UTM33.intersection(area)
    if inside is None or inside != area:
        b = NORWAY_UTM33
        msg = (
            "The area is not inside Norway: give EUREF89 UTM33 coordinates, easting "
            f"{b.x0:.0f} to {b.x1:.0f} and northing {b.y0:.0f} to {b.y1:.0f}."
        )
        raise AreaError(msg)


def world_epsg(area: Extent) -> int:
    """The ETRS89 / UTM zone a mapless world is built in: that of the area's centre.

    Norway uses zone 32 west of 12°E, zone 33 from 12°E to 24°E (instead of 33 and
    34) and zone 35 east of 24°E.

    Examples:
        >>> world_epsg(Extent(193986, 6622759, 198986, 6627759))  # Kongsberg
        25832
        >>> world_epsg(Extent(560000, 7440000, 565000, 7445000))  # Sulitjelma
        25833
        >>> world_epsg(Extent(1090000, 7880000, 1095000, 7885000))  # Vardø
        25835
    """
    to_lonlat = Transformer.from_crs(AREA_EPSG, 4326, always_xy=True)
    lon, _ = to_lonlat.transform(
        (area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2, errcheck=True
    )
    if lon < 12:
        return 25832
    if lon < 24:
        return 25833
    return 25835


def reproject_area(area: Extent, epsg: int) -> Polygon:
    """The chosen rectangle in the world's coordinate system ``epsg``.

    In another zone than UTM33 the rectangle turns a little and its size changes with
    the zones' scales. Its sides are reprojected point by point, so they stay as
    straight as the zone draws them.

    Examples:
        >>> reproject_area(Extent(0, 0, 300, 200), 25833).bounds
        (0.0, 0.0, 300.0, 200.0)
        >>> kongsberg = reproject_area(Extent(193986, 6622759, 198986, 6627759), 25832)
        >>> round(kongsberg.area / 1e6, 2)  # 25 km² in UTM33
        24.94
    """
    rectangle = box(*area.as_tuple())
    if epsg == AREA_EPSG:
        return rectangle
    step = max(area.width, area.height) / _EDGE_POINTS
    return _reproject(rectangle.segmentize(step), AREA_EPSG, epsg)


def _reproject(polygon: Polygon, from_epsg: int, to_epsg: int) -> Polygon:
    """Reproject the outline of ``polygon`` point by point."""
    xs, ys = polygon.exterior.xy
    to = Transformer.from_crs(from_epsg, to_epsg, always_xy=True)
    x, y = to.transform(np.asarray(xs), np.asarray(ys), errcheck=True)
    return Polygon(zip(x, y, strict=True))


def hoydedata_box(area: Polygon, epsg: int, margin: float) -> Extent:
    """The box to export laser data for from hoydedata.no, in UTM33.

    It is the bounding box of the core area in UTM33, grown by ``margin`` and rounded
    outward to whole HOYDEDATA_STEP_M.

    Args:
        area: The world's core area, in ``epsg``.
        epsg: The world's coordinate system.
        margin: Metres of terrain around the core area.

    Examples:
        >>> hoydedata_box(box(193986, 6622759, 198986, 6627759), 25833, 300).as_tuple()
        (193680.0, 6622450.0, 199290.0, 6628060.0)
    """
    if epsg != AREA_EPSG:
        step = math.sqrt(area.area) / _EDGE_POINTS
        area = _reproject(area.segmentize(step), epsg, AREA_EPSG)
    return Extent(*area.bounds).buffered(margin).snapped(HOYDEDATA_STEP_M)


def describe_hoydedata_box(found: Extent, margin: float) -> str:
    """The line telling the user what to export from hoydedata.no.

    Examples:
        >>> describe_hoydedata_box(Extent(193680, 6622450, 199290, 6628060), 300)
        'hoydedata.no (UTM33, incl. 300 m margin): xmin=193680 xmax=199290 ymin=6622450 ymax=6628060'
    """
    return (
        f"hoydedata.no (UTM33, incl. {margin:g} m margin): "
        f"xmin={found.x0:.0f} xmax={found.x1:.0f} ymin={found.y0:.0f} ymax={found.y1:.0f}"
    )


def describe_area(area: Extent) -> str:
    """The line telling the user the size of the chosen area.

    Examples:
        >>> describe_area(Extent(193986, 6622759, 196356, 6625129))
        'Area: 5.62 km² (2370 × 2370 m), EUREF89 UTM33'
    """
    size = area.width * area.height / 1e6
    return (
        f"Area: {size:.2f} km² ({area.width:.0f} × {area.height:.0f} m), EUREF89 UTM33"
    )
