"""Buildings, roads and other features from OpenStreetMap (ODbL), via Overpass."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
from pyproj import Transformer
from shapely import (
    LineString,
    MultiPolygon,
    Polygon,
    make_valid,
    polygonize,
    transform,
    unary_union,
)
from shapely.geometry.base import BaseGeometry

from terraino.fetch.cache import DownloadError, cached_download
from terraino.ingest.georef import Extent

log = logging.getLogger(__name__)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"

QUERY = """[out:json][timeout:120];
(
  way["building"]({bbox});
  relation["building"]["type"="multipolygon"]({bbox});
  way["highway"]({bbox});
  way["railway"="rail"]({bbox});
  way["natural"="water"]({bbox});
  relation["natural"="water"]["type"="multipolygon"]({bbox});
  way["waterway"]({bbox});
  way["leisure"="garden"]({bbox});
  way["landuse"~"residential|farmyard|grass|meadow"]({bbox});
  way["barrier"~"fence|wall|hedge"]({bbox});
  way["power"="line"]({bbox});
);
out geom;"""


@dataclass(frozen=True)
class OsmFeature:
    """An OSM way or multipolygon in projected coordinates.

    Attributes:
        geometry: LineString for open ways, Polygon/MultiPolygon for closed areas.
        tags: The OSM tags.
        osm_id: ``"way/123"`` or ``"relation/456"``.
    """

    geometry: BaseGeometry
    tags: dict[str, str]
    osm_id: str


# Closed ways with these keys are areas; other closed ways (e.g. roundabouts) are lines.
_AREA_KEYS = ("building", "natural", "leisure", "landuse")


def _way_geometry(element: dict[str, Any]) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in element.get("geometry", []) if p]


def _relation_polygon(element: dict[str, Any]) -> BaseGeometry | None:
    """Assemble a multipolygon relation: its outer rings minus its inner rings."""

    def rings(role: str) -> BaseGeometry:
        lines = [
            LineString(coords)
            for m in element.get("members", [])
            if m.get("type") == "way"
            and m.get("role", "outer") == role
            and len(coords := _way_geometry(m)) >= 2
        ]
        return unary_union(list(polygonize(lines).geoms))

    outer = rings("outer")
    if outer.is_empty:
        return None
    return make_valid(outer.difference(rings("inner")))


def parse_overpass(data: dict[str, Any]) -> list[OsmFeature]:
    """Turn an Overpass JSON response (``out geom``) into features in lon/lat.

    Examples:
        >>> data = {"elements": [{"type": "way", "id": 1, "tags": {"building": "yes"},
        ...   "geometry": [{"lon": 0, "lat": 0}, {"lon": 1, "lat": 0},
        ...                {"lon": 1, "lat": 1}, {"lon": 0, "lat": 0}]}]}
        >>> [(f.osm_id, f.geometry.geom_type) for f in parse_overpass(data)]
        [('way/1', 'Polygon')]
    """
    features: list[OsmFeature] = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        osm_id = f"{element['type']}/{element['id']}"
        geometry: BaseGeometry | None
        if element["type"] == "way":
            coords = _way_geometry(element)
            if len(coords) < 2:
                continue
            closed = len(coords) >= 4 and coords[0] == coords[-1]
            if closed and any(k in tags for k in _AREA_KEYS):
                geometry = make_valid(Polygon(coords))
            else:
                geometry = LineString(coords)
        elif element["type"] == "relation":
            geometry = _relation_polygon(element)
        else:
            continue
        if geometry is not None and not geometry.is_empty:
            features.append(OsmFeature(geometry=geometry, tags=tags, osm_id=osm_id))
    return features


def _project(features: Iterable[OsmFeature], epsg: int) -> list[OsmFeature]:
    to_map = Transformer.from_crs(4326, epsg, always_xy=True)

    def project(lon_lat: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
        x, y = to_map.transform(lon_lat[:, 0], lon_lat[:, 1])
        return np.column_stack([x, y])

    projected = []
    for f in features:
        geometry = transform(f.geometry, project)
        if isinstance(geometry, Polygon | MultiPolygon) and not geometry.is_valid:
            geometry = make_valid(geometry)
        projected.append(OsmFeature(geometry=geometry, tags=f.tags, osm_id=f.osm_id))
    return projected


def fetch_osm(epsg: int, extent: Extent, cache_dir: Path) -> list[OsmFeature]:
    """Download OSM features covering ``extent``, in the world's coordinates.

    Returns:
        The features, or an empty list if Overpass could not be reached.
    """
    to_wgs84 = Transformer.from_crs(epsg, 4326, always_xy=True)
    lons, lats = to_wgs84.transform(
        [extent.x0, extent.x1, extent.x0, extent.x1],
        [extent.y0, extent.y0, extent.y1, extent.y1],
    )
    bbox = f"{min(lats):.6f},{min(lons):.6f},{max(lats):.6f},{max(lons):.6f}"
    query = QUERY.format(bbox=bbox)
    key = hashlib.sha256(query.encode()).hexdigest()[:16]
    path = cache_dir / "osm" / f"{key}.json"
    log.info("Fetching OpenStreetMap features")
    try:
        cached_download(
            OVERPASS_URL, {"data": query}, path, expect_content_type="application/json"
        )
    except DownloadError as exc:
        log.warning("No OpenStreetMap data: %s", exc)
        return []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    features = _project(parse_overpass(data), epsg)
    log.info("Got %d OpenStreetMap features", len(features))
    return features
