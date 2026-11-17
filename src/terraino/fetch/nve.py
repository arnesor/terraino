"""Overhead power lines from NVE's grid data (Nettanlegg, NLOD).

NVE registers the overhead lines of the transmission, regional and distribution grids,
from 1 kV up: no low-voltage lines and no underground cables. The poles go on
Kartverket's registered masts (terraino.fetch.masts), as for the map's power lines.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shapely import LineString, box

from terraino.fetch.cache import DownloadError, cached_download
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

URL = "https://kart.nve.no/enterprise/rest/services/Nettanlegg4/MapServer"
ATTRIBUTION = "© NVE (Nettanlegg, NLOD)"
# Layer → line kind: transmission and regional lines stand on pylons.
LAYERS = {0: "pylon_line", 1: "pylon_line", 2: "power_line"}
PAGE_SIZE = 1000


@dataclass(frozen=True)
class PowerLine:
    """An overhead power line registered by NVE.

    Attributes:
        kind: ``power_line`` (distribution grid) or ``pylon_line``.
        line: The line in the world's coordinates.
    """

    kind: str
    line: LineString


def parse_page(data: dict[str, Any], kind: str) -> tuple[list[PowerLine], bool]:
    """The lines of one page of an ArcGIS query, and whether more pages follow.

    Raises:
        ValueError: If the service answered with an error.

    Examples:
        >>> page = {"features": [{"geometry": {"paths": [[[0, 0], [50, 0]], [[50, 0], [50, 9]]]}}]}
        >>> lines, more = parse_page(page, "power_line")
        >>> [(p.kind, list(p.line.coords)) for p in lines], more
        ([('power_line', [(0.0, 0.0), (50.0, 0.0)]), ('power_line', [(50.0, 0.0), (50.0, 9.0)])], False)
    """
    if "error" in data:
        msg = f"NVE answered {data['error']}"
        raise ValueError(msg)
    lines = [
        PowerLine(kind, LineString(path))
        for feature in data["features"]
        for path in feature["geometry"]["paths"]
        if len(path) >= 2
    ]
    return lines, bool(data.get("exceededTransferLimit"))


def fetch_power_lines(epsg: int, extent: Extent, cache_dir: Path) -> list[PowerLine]:
    """NVE's overhead power lines within ``extent``, in the world's coordinates.

    Returns:
        The lines cut to ``extent``, or an empty list (with a warning) if NVE cannot be
        reached.
    """
    bbox = f"{extent.x0:.0f},{extent.y0:.0f},{extent.x1:.0f},{extent.y1:.0f}"
    found: list[PowerLine] = []
    try:
        for layer, kind in LAYERS.items():
            offset = 0
            while True:
                params = {
                    "geometry": bbox,
                    "geometryType": "esriGeometryEnvelope",
                    "inSR": str(epsg),
                    "outSR": str(epsg),
                    "spatialRel": "esriSpatialRelIntersects",
                    "outFields": "objectid",
                    "orderByFields": "objectid",
                    "resultOffset": str(offset),
                    "resultRecordCount": str(PAGE_SIZE),
                    "returnGeometry": "true",
                    "f": "json",
                }
                name = f"{layer}_{epsg}_{bbox.replace(',', '_')}_{offset}.json"
                path = cached_download(
                    f"{URL}/{layer}/query",
                    params,
                    cache_dir / "nve" / name,
                    expect_content_type="application/json",
                )
                lines, more = parse_page(json.loads(path.read_bytes()), kind)
                found.extend(lines)
                if not more:
                    break
                offset += PAGE_SIZE
    except (DownloadError, ValueError, KeyError, TypeError) as exc:
        log.warning("No power lines from NVE: %s", exc)
        return []
    window = box(*extent.as_tuple())
    inside = [
        PowerLine(p.kind, part)
        for p in found
        for part in _parts(p.line.intersection(window))
    ]
    log.info("Got %d power lines from NVE", len(inside))
    return inside


def _parts(geometry: Any) -> list[LineString]:
    if isinstance(geometry, LineString):
        return [geometry] if geometry.length > 0 else []
    return [g for g in getattr(geometry, "geoms", []) if isinstance(g, LineString)]
