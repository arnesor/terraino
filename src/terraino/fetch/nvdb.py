"""Paths and vehicle tracks from NVDB, Statens vegvesen's road database (NLOD).

NVDB is taking in Kartverket's paths and vehicle tracks (FKB-TraktorvegSti) during
2026-2027, the same lines as on Kartverket's topographic map. Until then it has them only
in some counties, so OSM fills in where NVDB has none (terraino.process.tracks).

The API (NVDB API Les v4) takes the box in UTM33 and returns lines in the world's zone.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely import LineString, box, force_2d, wkt
from shapely.errors import ShapelyError

from terraino.fetch.cache import DownloadError, cached_download
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

URL = "https://nvdbapiles.atlas.vegvesen.no/vegnett/api/v4/veglenkesekvenser/segmentert"
ATTRIBUTION = "© Statens vegvesen (NVDB, NLOD)"
HEADERS = {"Accept": "application/json", "X-Client": "terraino"}
PAGE_SIZE = 1000
# The query box is always in UTM33; the lines come back in the world's zone, with heights
# in NN2000 (ignored: tracks lie on the height model).
QUERY_EPSG = 25833
_SRID = {25832: "5972", 25833: "5973", 25835: "5975"}
# NVDB road type → track style and drawn width (m), as OSM's paths and tracks.
STYLES = {"Sti": ("path", 1.2), "Traktorveg": ("vehicle_track", 3.0)}


@dataclass(frozen=True)
class NvdbLine:
    """A path or vehicle track from NVDB.

    Attributes:
        kind: Track style (terraino.process.symbols.TRACKS).
        width: Drawn width in metres.
        line: The line in the world's coordinates.
    """

    kind: str
    width: float
    line: LineString


def parse_page(data: dict[str, Any]) -> tuple[list[NvdbLine], str | None]:
    """The paths and vehicle tracks of one page of segments, and where the next starts.

    Returns:
        The lines, and the ``start`` of the next page, or None on the last page.

    Examples:
        >>> page = {
        ...     "objekter": [
        ...         {"typeVeg": "Sti", "geometri": {"wkt": "LINESTRING Z (0 0 5, 10 0 6)"}},
        ...         {"typeVeg": "Gangveg", "geometri": {"wkt": "LINESTRING Z (0 5 5, 9 5 5)"}},
        ...     ],
        ...     "metadata": {"returnert": 2, "sidestørrelse": 2, "neste": {"start": "x"}},
        ... }
        >>> lines, start = parse_page(page)
        >>> [(n.kind, n.width, list(n.line.coords)) for n in lines], start
        ([('path', 1.2, [(0.0, 0.0), (10.0, 0.0)])], 'x')
    """
    lines = []
    for segment in data["objekter"]:
        style = STYLES.get(segment.get("typeVeg", ""))
        if style is None:
            continue
        line = force_2d(wkt.loads(segment["geometri"]["wkt"]))
        if isinstance(line, LineString) and line.length > 0:
            lines.append(NvdbLine(style[0], style[1], line))
    meta = data["metadata"]
    last = meta["returnert"] < meta["sidestørrelse"] or "neste" not in meta
    return lines, None if last else meta["neste"]["start"]


def _query_box(epsg: int, extent: Extent) -> str:
    to_utm33 = Transformer.from_crs(epsg, QUERY_EPSG, always_xy=True)
    x0, y0, x1, y1 = to_utm33.transform_bounds(*extent.as_tuple(), densify_pts=21)
    return f"{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}"


def fetch_paths(epsg: int, extent: Extent, cache_dir: Path) -> list[NvdbLine]:
    """NVDB's paths and vehicle tracks within ``extent``, in the world's coordinates.

    Returns:
        The lines cut to ``extent``, or an empty list (with a warning) if NVDB cannot be
        reached.
    """
    params = {
        "kartutsnitt": _query_box(epsg, extent),
        "srid": _SRID[epsg],
        "typeveg": "sti,traktorveg",
        "antall": str(PAGE_SIZE),
    }
    name = f"{epsg}_{extent.x0:.0f}_{extent.y0:.0f}_{extent.x1:.0f}_{extent.y1:.0f}"
    found: list[NvdbLine] = []
    start: str | None = None
    page = 0
    try:
        while True:
            page_params = params if start is None else {**params, "start": start}
            path = cached_download(
                URL,
                page_params,
                cache_dir / "nvdb" / f"{name}_{page}.json",
                expect_content_type="application/json",
                headers=HEADERS,
            )
            lines, start = parse_page(json.loads(path.read_bytes()))
            found.extend(lines)
            if start is None:
                break
            page += 1
    except (DownloadError, ValueError, KeyError, TypeError, ShapelyError) as exc:
        log.warning("No paths from NVDB: %s", exc)
        return []
    window = box(*extent.as_tuple())
    inside = [
        NvdbLine(n.kind, n.width, part)
        for n in found
        for part in _parts(n.line.intersection(window))
    ]
    log.info("Got %d paths and vehicle tracks from NVDB", len(inside))
    return inside


def _parts(geometry: Any) -> list[LineString]:
    if isinstance(geometry, LineString):
        return [geometry] if geometry.length > 0 else []
    return [g for g in getattr(geometry, "geoms", []) if isinstance(g, LineString)]
