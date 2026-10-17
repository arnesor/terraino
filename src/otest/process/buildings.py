"""Buildings with heights and roofs measured from the laser surface model.

With a laser point cloud the roof shape is measured too: the fine surface inside each
footprint is split into roof planes by the way it faces (otest.process.roofs), giving
wings with gable, hipped, shed and flat roofs. Where that does not explain the surface,
a single flat, shed, gable or hip roof is fitted to the whole footprint.
"""

from __future__ import annotations

import logging
import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

import numpy as np
import numpy.typing as npt
import shapely
from rasterio.features import rasterize
from shapely import MultiPolygon, Point, Polygon, STRtree
from shapely.geometry.base import BaseGeometry

from otest.fetch.matrikkel import BuildingPoint
from otest.fetch.osm import OsmFeature
from otest.fetch.topo_buildings import TopoBuilding
from otest.ingest.georef import Extent
from otest.process.building_types import (
    STYLES,
    colours,
    floors_for,
    kind_for_type,
    type_rank,
)
from otest.process.geometry import to_geometry
from otest.process.roofs import RoofPart, parts_from_lines, robust_fit, segment_roof
from otest.process.symbols import Ground, SymbolSet

log = logging.getLogger(__name__)

MIN_AREA_M2 = 4.0
# The laser saw a roof only where a roof fits it this well (RMS, metres) and, for the 1 m
# surface model, where its heights vary less than this (trees vary much more).
MAX_FIT_RMS_M = 0.35
MAX_SURFACE_SPREAD_M = 6.0
# A registered building's point may lie this far outside its footprint.
REGISTRY_DISTANCE_M = 5.0
# Kinds of building people live in; garages on their property take their colours.
DWELLINGS = ("house", "farmhouse", "cabin")
# A map building overlapping an OSM building by this share is the same building.
SAME_BUILDING_OVERLAP = 0.3
# Footprints filling at least this share of their oriented rectangle get gable roofs.
RECTANGULAR = 0.82
MIN_RIDGE_M = 0.8
# Roof fitting: surface cells this far inside the walls, at least this many of them,
# and at least this high above the lowest ground (lower ones are ground or bushes).
ROOF_INSET_M = 0.5
MIN_ROOF_CELLS = 12
MIN_ROOF_HEIGHT_M = 1.0
# Roofs rising less than this per metre, or less than FLAT_RISE_M in all, are flat.
MIN_PITCH = 0.08
FLAT_RISE_M = 0.4
# How much better (RMS, metres) another model must fit to win over a flat or gable roof.
FLAT_PREFERENCE_M = 0.06
GABLE_PREFERENCE_M = 0.05


@dataclass(frozen=True)
class Building:
    """A building ready for the viewer.

    Attributes:
        footprint: Outline in projected coordinates.
        base: Ground height (lowest DTM value under the footprint).
        wall: Wall height above ``base`` in metres.
        roof: Roof height above the walls in metres (0 for flat roofs).
        roof_type: ``"gable"``, ``"hip"``, ``"shed"`` or ``"flat"``.
        ridge: Direction of the ridge in radians from east, counter-clockwise. For a
            shed roof, the direction of its high edge, with the roof rising towards
            the right of it (seen from above).
        wall_color: Wall colour, sRGB hex.
        roof_color: Roof colour, sRGB hex.
        kind: house, garage, shed, barn, farm_auxiliary, cabin or other.
        source: ``"osm"`` or ``"map"``.
        parts: The roof's wings, measured in a laser point cloud; when given, they
            replace ``roof``, ``roof_type`` and ``ridge``, which describe the largest.
        type_code: Building type in Matrikkelen (NS 3457), if registered.
        floors: Number of floors (windows are drawn floor by floor).
    """

    footprint: Polygon
    base: float
    wall: float
    roof: float
    roof_type: str
    ridge: float
    wall_color: str
    roof_color: str
    kind: str
    source: str
    parts: tuple[RoofPart, ...] = ()
    type_code: int | None = None
    floors: int = 1


def match_registry(
    footprints: Sequence[Polygon], points: Sequence[BuildingPoint]
) -> list[BuildingPoint | None]:
    """The registered building for each footprint: the point inside it, or near it.

    Where several points fall in one footprint, the most telling type wins (see
    type_rank): a garage registered inside the house it is built onto stays a house.

    Examples:
        >>> from shapely import box
        >>> house = BuildingPoint(5, 5, 111, "TB", False, "1")
        >>> garage = BuildingPoint(6, 5, 181, "TB", False, "1")
        >>> barn = BuildingPoint(22, 5, 241, "TB", True, "2")
        >>> found = match_registry([box(0, 0, 10, 10), box(20, 0, 30, 10)], [garage, house, barn])
        >>> [p.type_code if p else None for p in found]
        [111, 241]
    """
    found: list[BuildingPoint | None] = [None] * len(footprints)
    if not footprints or not points:
        return found
    tree = STRtree(list(footprints))
    for point in points:
        where = Point(point.x, point.y)
        hits = tree.query(where, predicate="intersects")
        if len(hits) == 0:
            hits = tree.query_nearest(where, max_distance=REGISTRY_DISTANCE_M)
        for i in hits[:1]:
            current = found[i]
            if current is None or type_rank(point.type_code) < type_rank(
                current.type_code
            ):
                found[i] = point
    return found


def building_kind(tags: Mapping[str, str]) -> str:
    """Group OSM building types into the kinds used for size and colour.

    Examples:
        >>> building_kind({"building": "detached"}), building_kind({"building": "garages"})
        ('house', 'garage')
    """
    value = tags.get("building", "yes")
    groups = {
        "house": {
            "house",
            "detached",
            "semidetached_house",
            "residential",
            "farm",
            "terrace",
        },
        "garage": {"garage", "garages", "carport"},
        "shed": {"shed", "hut", "roof", "greenhouse"},
        "barn": {"barn", "stable", "cowshed"},
        "farm_auxiliary": {"farm_auxiliary"},
        "cabin": {"cabin"},
    }
    for kind, values in groups.items():
        if value in values:
            return kind
    return "other"


def _ridge_angle(footprint: Polygon) -> tuple[float, float]:
    """Return the long-axis direction of the footprint and how rectangular it is."""
    rect = footprint.minimum_rotated_rectangle
    if not isinstance(rect, Polygon):
        return 0.0, 0.0
    coords = list(rect.exterior.coords)
    edges = [
        (coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1])
        for i in range(2)
    ]
    long_edge = max(edges, key=lambda e: math.hypot(*e))
    angle = math.atan2(long_edge[1], long_edge[0])
    fill = footprint.area / rect.area if rect.area > 0 else 0.0
    return angle, fill


@dataclass(frozen=True)
class RoofFit:
    """A roof fitted to surface heights.

    Attributes:
        roof_type: ``"flat"``, ``"shed"``, ``"gable"`` or ``"hip"``.
        eave: Height of the roof's lower edge at the walls.
        ridge: Height of its highest point.
        angle: Ridge direction (see Building.ridge), radians from east.
        rms: Root mean square of the fit's residuals, in metres.
    """

    roof_type: str
    eave: float
    ridge: float
    angle: float
    rms: float


def fit_roof(
    x: npt.NDArray[np.float64],
    y: npt.NDArray[np.float64],
    z: npt.NDArray[np.float64],
    footprint: Polygon,
) -> RoofFit | None:
    """Fit flat, shed, gable and hip roofs to surface heights inside a footprint.

    Args:
        x: Eastings of the surface samples.
        y: Northings.
        z: Surface heights.
        footprint: The building's outline.

    Returns:
        The best roof, or None with too few samples.

    Examples:
        >>> footprint = Polygon([(0, 0), (10, 0), (10, 6), (0, 6)])
        >>> yy, xx = np.mgrid[0.5:6:0.5, 0.5:10:0.5]
        >>> gable = 6.0 - 0.7 * np.abs(yy - 3)  # ridge along x, 2.1 m above the eaves
        >>> fit = fit_roof(xx.ravel(), yy.ravel(), gable.ravel(), footprint)
        >>> fit.roof_type, round(fit.eave, 1), round(fit.ridge, 1)
        ('gable', 3.9, 6.0)
        >>> round(math.degrees(fit.angle)) % 180
        0
        >>> flat = fit_roof(xx.ravel(), yy.ravel(), np.full(xx.size, 3.0), footprint)
        >>> flat.roof_type, round(flat.eave, 1)
        ('flat', 3.0)
    """
    if len(z) < MIN_ROOF_CELLS:
        return None
    rect = footprint.minimum_rotated_rectangle
    if not isinstance(rect, Polygon):
        return None
    theta, _ = _ridge_angle(footprint)
    corners = list(rect.exterior.coords)[:4]
    sides = sorted(
        math.hypot(corners[i + 1][0] - corners[i][0], corners[i + 1][1] - corners[i][1])
        for i in range(2)
    )
    hw, hu = sides[0] / 2, sides[1] / 2
    centre = rect.centroid
    dx, dy = x - centre.x, y - centre.y
    cos, sin = math.cos(theta), math.sin(theta)
    u = dx * cos + dy * sin  # along the long axis
    w = dx * sin - dy * cos  # across it: u turned clockwise

    a, _, flat_rms = robust_fit(None, z)
    fits: list[RoofFit] = [RoofFit("flat", a, a, theta, flat_rms)]

    def ridge_fits(across: npt.NDArray[np.float64], half: float, angle: float) -> None:
        best: RoofFit | None = None
        for shift in (-0.2, -0.1, 0.0, 0.1, 0.2):
            ridge, slope, rms = robust_fit(-np.abs(across - shift * half), z)
            if slope >= MIN_PITCH and (best is None or rms < best.rms):
                best = RoofFit("gable", ridge - slope * half, ridge, angle, rms)
        if best is not None:
            fits.append(best)

    ridge_fits(w, hw, theta)  # ridge along the long axis
    ridge_fits(u, hu, theta + math.pi / 2)  # ridge across it
    ridge, slope, rms = robust_fit(-np.maximum(np.abs(w), np.abs(u) - (hu - hw)), z)
    if slope >= MIN_PITCH:
        fits.append(RoofFit("hip", ridge - slope * hw, ridge, theta, rms))
    for along, half, high in ((w, hw, theta), (u, hu, theta + math.pi / 2)):
        middle, slope, rms = robust_fit(along, z)
        if abs(slope) >= MIN_PITCH:
            angle = high if slope > 0 else high + math.pi
            rise = abs(slope) * half
            fits.append(RoofFit("shed", middle - rise, middle + rise, angle, rms))

    flat = fits[0]
    pitched = [f for f in fits[1:] if math.isfinite(f.rms)]
    if not pitched:
        return flat if math.isfinite(flat.rms) else None
    gables = [f for f in pitched if f.roof_type == "gable"]
    best = min(pitched, key=lambda f: f.rms)
    if gables:
        gable = min(gables, key=lambda f: f.rms)
        if best.rms > gable.rms - GABLE_PREFERENCE_M:
            best = gable
    if best.ridge - best.eave < FLAT_RISE_M or flat.rms <= best.rms + FLAT_PREFERENCE_M:
        return flat if math.isfinite(flat.rms) else best
    return best


def _roof_samples(
    footprint: Polygon,
    surface: npt.NDArray[np.float32],
    dtm: npt.NDArray[np.float32],
    extent: Extent,
    fine: int,
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Fine surface cells inside the footprint (inset from the walls), absolute heights."""
    inner = footprint.buffer(-ROOF_INSET_M)
    if inner.is_empty or inner.area < 4:
        inner = footprint.buffer(-ROOF_INSET_M / 2)
    if inner.is_empty:
        empty = np.zeros(0)
        return empty, empty, empty
    x0, y0, x1, y1 = inner.bounds
    c0 = max(int((x0 - extent.x0) * fine), 0)
    c1 = min(int(np.ceil((x1 - extent.x0) * fine)), surface.shape[1])
    r0 = max(int((extent.y1 - y1) * fine), 0)
    r1 = min(int(np.ceil((extent.y1 - y0) * fine)), surface.shape[0])
    if r0 >= r1 or c0 >= c1:  # outside the world
        empty = np.zeros(0)
        return empty, empty, empty
    rows, cols = np.mgrid[r0:r1, c0:c1]
    x = extent.x0 + (cols.ravel() + 0.5) / fine
    y = extent.y1 - (rows.ravel() + 0.5) / fine
    inside = shapely.contains_xy(inner, x, y)
    rows, cols = rows.ravel()[inside], cols.ravel()[inside]
    z = surface[rows, cols].astype(np.float64) + dtm[rows // fine, cols // fine]
    return x[inside], y[inside], z


def _roof_patch(
    footprint: Polygon,
    surface: npt.NDArray[np.float32],
    dtm: npt.NDArray[np.float32],
    extent: Extent,
    fine: int,
    base: float,
) -> list[RoofPart] | None:
    """Roof parts from the fine surface inside the footprint (see segment_roof)."""
    inner = footprint.buffer(-ROOF_INSET_M)
    if inner.is_empty or inner.area < 4:
        return None
    x0, y0, x1, y1 = footprint.bounds
    c0 = max(int((x0 - extent.x0) * fine) - 1, 0)
    c1 = min(int(np.ceil((x1 - extent.x0) * fine)) + 1, surface.shape[1])
    r0 = max(int((extent.y1 - y1) * fine) - 1, 0)
    r1 = min(int(np.ceil((extent.y1 - y0) * fine)) + 1, surface.shape[0])
    if r1 - r0 < 3 or c1 - c0 < 3:
        return None
    rows, cols = np.mgrid[r0:r1, c0:c1]
    x = extent.x0 + (cols + 0.5) / fine
    y = extent.y1 - (rows + 0.5) / fine
    z = (
        surface[r0:r1, c0:c1].astype(np.float64)
        + dtm[rows // fine, cols // fine]
        - base
    )
    valid = shapely.contains_xy(inner, x, y) & (z >= MIN_ROOF_HEIGHT_M)
    if valid.sum() < MIN_ROOF_CELLS:
        return None
    rect = footprint.minimum_rotated_rectangle
    centre = rect.centroid if isinstance(rect, Polygon) else footprint.centroid
    axis, _ = _ridge_angle(footprint)
    ox, oy = np.asarray(footprint.exterior.coords).T
    parts = segment_roof(
        z,
        valid,
        x - centre.x,
        y - centre.y,
        axis,
        ox - centre.x,
        oy - centre.y,
        1.0 / fine,
    )
    if parts is None:
        return None
    return [
        RoofPart(
            p.roof_type,
            (p.centre[0] + centre.x, p.centre[1] + centre.y),
            p.angle,
            p.half_length,
            p.half_width,
            p.eave,
            p.ridge,
            p.hips,
        )
        for p in parts
    ]


def _covered(
    poly: Polygon, others: Sequence[Polygon], tree: STRtree | None
) -> int | None:
    """Index of the polygon in ``others`` that is the same building as ``poly``, if any."""
    if tree is None:
        return None
    best, share = None, 0.0
    for i in tree.query(poly, predicate="intersects"):
        overlap = poly.intersection(others[i]).area / max(
            min(poly.area, others[i].area), 1e-9
        )
        if overlap > share:
            best, share = int(i), overlap
    return best if share > SAME_BUILDING_OVERLAP else None


def collect_footprints(
    osm: Iterable[OsmFeature],
    omap_features: Iterable[Mapping[str, Any]],
    symbols: SymbolSet,
    topo: Sequence[TopoBuilding] = (),
) -> list[tuple[Polygon, str, str, str]]:
    """Return ``(footprint, kind, source, id)`` for every building.

    Kartverket's map outlines come first (ids ``kartverket/<index in topo>``); an OSM
    building on one of them only gives its kind. OSM buildings, then the orienteering
    map's, fill in where the earlier sources have none.
    """
    footprints: list[tuple[Polygon, str, str, str]] = [
        (b.footprint, "other", "kartverket", f"kartverket/{i}")
        for i, b in enumerate(topo)
    ]
    kartverket = [b.footprint for b in topo]
    k_tree = STRtree(kartverket) if kartverket else None
    for f in osm:
        if "building" not in f.tags:
            continue
        for poly in _polygons(f.geometry):
            kind = building_kind(f.tags)
            same = _covered(poly, kartverket, k_tree)
            if same is None:
                footprints.append((poly, kind, "osm", f.osm_id))
            elif kind != "other" and footprints[same][1] == "other":
                fp, _, source, ident = footprints[same]
                footprints[same] = (fp, kind, source, ident)

    known = [p for p, _, _, _ in footprints]
    tree = STRtree(known) if known else None
    for feature in omap_features:
        rule = symbols.rule(feature["properties"]["sym"])
        if rule is None or rule.ground is not Ground.BUILDING:
            continue
        geometry = to_geometry(feature.get("geometry"))
        if geometry is None:
            continue
        for poly in _polygons(geometry):
            if _covered(poly, known, tree) is not None:
                continue
            oid = feature["properties"]["oid"]
            footprints.append((poly, "other", "map", f"map/{oid}"))
    return [fp for fp in footprints if fp[0].area >= MIN_AREA_M2]


def _polygons(geometry: BaseGeometry) -> list[Polygon]:
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    if hasattr(geometry, "geoms"):
        return [g for g in geometry.geoms if isinstance(g, Polygon)]
    return []


def measure_buildings(
    footprints: Sequence[tuple[Polygon, str, str, str]],
    dtm: npt.NDArray[np.float32],
    canopy: npt.NDArray[np.float32],
    extent: Extent,
    surface: npt.NDArray[np.float32] | None = None,
    fine: int = 2,
    registry: Sequence[BuildingPoint] = (),
    roof_lines: Mapping[str, Sequence[tuple[float, float, float, float]]] | None = None,
) -> list[Building]:
    """Measure base, wall and roof heights of each footprint.

    Args:
        footprints: From collect_footprints.
        dtm: Terrain heights on the world's 1 m grid.
        canopy: Surface minus terrain on the same grid.
        extent: World extent.
        surface: Surface minus terrain on a grid ``fine`` times finer, from a laser
            point cloud; with it the roof shape is measured.
        fine: Fine cells per metre of ``surface``.
        registry: Buildings registered in Matrikkelen; their types decide the kind,
            colours and default size of the footprints they fall in.
        roof_lines: Roof lines (x0, y0, x1, y1) from Kartverket's map by footprint id;
            they shape the roofs the laser does not measure.
    """
    if not footprints:
        return []
    labels = rasterize(
        [(fp[0], i + 1) for i, fp in enumerate(footprints)],
        out_shape=extent.raster_shape(1),
        transform=extent.raster_transform(1),
        fill=0,
        dtype=np.int32,
    )
    flat = labels.ravel()
    cells = np.flatnonzero(flat)
    order = np.argsort(flat[cells], kind="stable")
    cells = cells[order]
    ids = flat[cells]
    bounds = np.searchsorted(ids, np.arange(1, len(footprints) + 2))

    registered = match_registry([fp[0] for fp in footprints], registry)
    roof_source: Counter[str] = Counter()
    buildings = []
    for i, (poly, osm_kind, source, ident) in enumerate(footprints):
        own = cells[bounds[i] : bounds[i + 1]]
        point = registered[i]
        kind = (kind_for_type(point.type_code) if point else None) or osm_kind
        style = STYLES.get(kind, STYLES["other"])
        if len(own) >= 3:
            heights = canopy.ravel()[own]
            base = float(dtm.ravel()[own].min())
            top = float(np.percentile(heights, 95))
            eave = float(np.percentile(heights, 25))
            spread = float(np.percentile(heights, 90) - np.percentile(heights, 10))
        else:
            centre = poly.representative_point()
            row = int(np.clip(extent.y1 - centre.y, 0, dtm.shape[0] - 1))
            col = int(np.clip(centre.x - extent.x0, 0, dtm.shape[1] - 1))
            base = float(dtm[row, col])
            top = eave = spread = 0.0

        angle, fill = _ridge_angle(poly)
        lines = (roof_lines or {}).get(ident, ())

        def plausible(wall: float, roof: float) -> bool:
            # Taller than the kind can be: the laser saw trees, or the site before
            # the building was built.
            return wall <= style.max_wall and roof <= style.max_roof  # noqa: B023

        parts: list[RoofPart] | None = None
        fit = None
        if surface is not None:
            parts = _roof_patch(poly, surface, dtm, extent, fine, base)
            if parts and not plausible(
                min(p.eave for p in parts),
                max(p.ridge for p in parts) - min(p.eave for p in parts),
            ):
                parts = None
            if not parts:
                x, y, z = _roof_samples(poly, surface, dtm, extent, fine)
                keep = z - base >= MIN_ROOF_HEIGHT_M
                fit = fit_roof(x[keep], y[keep], z[keep], poly)
                if fit is not None and (
                    fit.rms > MAX_FIT_RMS_M
                    or not plausible(fit.eave - base, fit.ridge - fit.eave)
                ):
                    fit = None
        roof_type = "flat"
        measured = True
        if parts:
            # Wings measured in the point cloud; the walls reach the lowest eaves.
            main = max(parts, key=lambda p: p.area)
            wall = float(np.clip(min(p.eave for p in parts), 2.0, 25.0))
            roof = float(np.clip(main.ridge - wall, 0.0, 9.0))
            angle = main.angle
            roof_type = main.roof_type
            if roof_type == "gable" and all(main.hips):
                roof_type = "hip"
            roof_source["laser"] += 1
        elif fit is not None and fit.ridge - base >= 2.0:
            # Pitched roofs over irregular outlines are drawn flat, at half the rise.
            wall = float(np.clip(fit.eave - base, 2.0, 25.0))
            roof = float(np.clip(fit.ridge - base - wall, 0.0, 9.0))
            if fit.roof_type != "flat" and fill >= RECTANGULAR:
                roof_type, angle = fit.roof_type, fit.angle
                angle = _map_direction(poly, lines, angle, wall, style.pitch)
            else:
                wall, roof = max(wall + roof * 0.5, 2.2), 0.0
            roof_source["laser"] += 1
        elif (
            surface is None
            and top >= 2.0
            and spread <= MAX_SURFACE_SPREAD_M
            and plausible(eave, top - eave)
        ):
            # Only the 1 m surface model: walls and a roof from its heights.
            top = min(top, 25.0)
            wall = float(np.clip(eave, 2.2, top))
            roof = top - wall
            if fill >= RECTANGULAR and roof >= MIN_RIDGE_M:
                roof_type = "gable"
            else:
                wall, roof = max(wall + roof * 0.5, 2.2), 0.0
            roof_source["surface model"] += 1
        else:
            # Not measured: the kind's height, the roof from the map's roof lines (or a
            # gable along the long side) at the kind's pitch.
            measured = False
            wall = style.wall
            flat = kind == "industry" or (not lines and fill < RECTANGULAR)
            parts = parts_from_lines(
                poly, lines, wall, math.radians(style.pitch), flat=flat
            )
            roof = 0.0
            if parts:
                biggest = max(parts, key=lambda p: p.area)
                roof = biggest.ridge - wall
                angle = biggest.angle
                roof_type = biggest.roof_type
                if roof_type == "gable" and all(biggest.hips):
                    roof_type = "hip"
            roof_source["map roof lines" if lines else "defaults"] += 1
        # Farm buildings on one property share their colours; other buildings vary.
        farm = kind in ("barn", "farm_auxiliary")
        seed = (
            f"{point.property_id}/{kind}"
            if point and point.property_id and farm
            else ident
        )
        # Summer farms (seterhus, koier) keep the old look even when not in SEFRAK.
        old = bool(point and point.sefrak) or kind == "summer_farm"
        wall_color, roof_color = colours(kind, seed, old=old)
        buildings.append(
            Building(
                footprint=poly,
                base=base,
                wall=round(wall, 2),
                roof=round(min(roof, 9.0), 2),
                roof_type=roof_type,
                ridge=angle,
                wall_color=wall_color,
                roof_color=roof_color,
                kind=kind,
                source=source,
                parts=tuple(parts or ()),
                type_code=point.type_code if point else None,
                floors=floors_for(kind, wall if measured else None),
            )
        )
    log.info(
        "Roofs: %s",
        ", ".join(f"{n} from {source}" for source, n in roof_source.most_common()),
    )
    return _match_property_colours(buildings, registered)


def _map_direction(
    footprint: Polygon,
    lines: Sequence[tuple[float, float, float, float]],
    angle: float,
    wall: float,
    pitch: float,
) -> float:
    """The ridge direction of the map's roof lines where it differs from ``angle``."""
    if not lines:
        return angle
    parts = parts_from_lines(footprint, lines, wall, math.radians(pitch))
    if not parts:
        return angle
    mapped = max(parts, key=lambda p: p.area).angle
    turn = abs(mapped - angle) % math.pi
    return mapped if min(turn, math.pi - turn) > math.radians(30) else angle


def _match_property_colours(
    buildings: list[Building], registered: Sequence[BuildingPoint | None]
) -> list[Building]:
    """Garages and outbuildings take the colours of the dwelling on their property."""
    dwellings: dict[str, Building] = {}
    for b, point in zip(buildings, registered, strict=True):
        if point and point.property_id and b.kind in DWELLINGS:
            best = dwellings.get(point.property_id)
            if best is None or b.footprint.area > best.footprint.area:
                dwellings[point.property_id] = b
    result = []
    for b, point in zip(buildings, registered, strict=True):
        home = dwellings.get(point.property_id or "") if point else None
        if home is not None and b.kind == "garage":
            b = replace(b, wall_color=home.wall_color, roof_color=home.roof_color)
        result.append(b)
    return result
