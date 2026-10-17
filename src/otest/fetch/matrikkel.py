"""Building points from Matrikkelen, Norway's property register (Kartverket, CC BY 4.0).

Each registered building has a point with its building type (NS 3457 codes, for
example 111 detached house, 113 farmhouse, 161 holiday cabin, 181 garage or outbuilding,
241 barn), its status, whether it is older than 1900 (SEFRAK) and the property it
stands on. The register has no number of floors.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from otest.fetch.cache import DownloadError, cached_download
from otest.ingest.georef import Extent

log = logging.getLogger(__name__)

WFS_URL = "https://wfs.geonorge.no/skwms1/wfs.matrikkelen-bygningspunkt"
ATTRIBUTION = "© Kartverket (Matrikkelen bygningspunkt, CC BY 4.0)"
PAGE_SIZE = 5000
_NS = {
    "wfs": "http://www.opengis.net/wfs/2.0",
    "gml": "http://www.opengis.net/gml/3.2",
    "app": "http://skjema.geonorge.no/SOSI/produktspesifikasjon/Matrikkelen-Bygningspunkt/20211101",
}
# Buildings planned or demolished, not standing.
_NOT_STANDING = {"RS", "IP", "BR", "BF", "BA"}


@dataclass(frozen=True)
class BuildingPoint:
    """A building registered in Matrikkelen.

    Attributes:
        x: Easting of the building's point.
        y: Northing.
        type_code: Building type (NS 3457, e.g. 113 farmhouse).
        status: Status code (TB in use, FA completed, ...).
        sefrak: Registered in SEFRAK: built before 1900.
        property_id: The property (matrikkelenhet) it stands on, if known.
    """

    x: float
    y: float
    type_code: int
    status: str
    sefrak: bool
    property_id: str | None


def parse_building_points(text: bytes) -> list[BuildingPoint]:
    """Read building points from a WFS GetFeature response (GML 3.2).

    Examples:
        >>> gml = b'''<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
        ...   xmlns:gml="http://www.opengis.net/gml/3.2"><wfs:member>
        ... <app:Bygning xmlns:app="http://skjema.geonorge.no/SOSI/produktspesifikasjon/Matrikkelen-Bygningspunkt/20211101">
        ...   <app:bygningsstatus>TB</app:bygningsstatus>
        ...   <app:harSefrakminne>true</app:harSefrakminne>
        ...   <app:bruksenhet><app:Bruksenhet><app:matrikkelenhetId>42</app:matrikkelenhetId>
        ...   </app:Bruksenhet></app:bruksenhet>
        ...   <app:representasjonspunkt><gml:Point><gml:pos>666728.0 6646368.0</gml:pos>
        ...   </gml:Point></app:representasjonspunkt>
        ...   <app:bygningstype>113</app:bygningstype>
        ... </app:Bygning></wfs:member></wfs:FeatureCollection>'''
        >>> parse_building_points(gml)
        [BuildingPoint(x=666728.0, y=6646368.0, type_code=113, status='TB', sefrak=True, property_id='42')]
    """
    root = ET.fromstring(text)  # noqa: S314 - a response from Kartverket's own service
    if root.tag.endswith("ExceptionReport"):
        msg = ET.tostring(root, encoding="unicode")[:300]
        raise DownloadError(f"Matrikkel WFS error: {msg}")
    points = []
    for b in root.iterfind("wfs:member/app:Bygning", _NS):
        pos = b.findtext("app:representasjonspunkt/gml:Point/gml:pos", None, _NS)
        code = b.findtext("app:bygningstype", None, _NS)
        if pos is None or code is None or not code.isdigit():
            continue
        x, y = (float(v) for v in pos.split()[:2])
        points.append(
            BuildingPoint(
                x=x,
                y=y,
                type_code=int(code),
                status=b.findtext("app:bygningsstatus", "", _NS),
                sefrak=b.findtext("app:harSefrakminne", "false", _NS) == "true",
                property_id=b.findtext(
                    "app:bruksenhet/app:Bruksenhet/app:matrikkelenhetId", None, _NS
                ),
            )
        )
    return points


def fetch_building_points(
    epsg: int, extent: Extent, cache_dir: Path
) -> list[BuildingPoint]:
    """Standing buildings registered in Matrikkelen within ``extent``.

    Returns an empty list (with a warning) if the service cannot be reached.
    """
    crs = f"urn:ogc:def:crs:EPSG::{epsg}"
    bbox = f"{extent.x0:.0f},{extent.y0:.0f},{extent.x1:.0f},{extent.y1:.0f},{crs}"
    points: list[BuildingPoint] = []
    start = 0
    try:
        while True:
            params = {
                "service": "WFS",
                "version": "2.0.0",
                "request": "GetFeature",
                "typeNames": "app:Bygning",
                "srsName": crs,
                "bbox": bbox,
                "count": str(PAGE_SIZE),
                "startIndex": str(start),
            }
            name = (
                f"bygg_{epsg}_{extent.x0:.0f}_{extent.y0:.0f}_{extent.x1:.0f}_"
                f"{extent.y1:.0f}_{start}.xml"
            )
            path = cached_download(WFS_URL, params, cache_dir / "matrikkel" / name)
            page = parse_building_points(path.read_bytes())
            points.extend(page)
            if len(page) < PAGE_SIZE:
                break
            start += PAGE_SIZE
    except (DownloadError, ET.ParseError) as exc:
        log.warning("No building types from Matrikkelen: %s", exc)
        return []
    standing = [p for p in points if p.status not in _NOT_STANDING]
    log.info("Got %d buildings from Matrikkelen", len(standing))
    return standing
