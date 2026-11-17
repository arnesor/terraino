"""Build a 3D world package from an orienteering map, or for a chosen area without one."""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
from PIL import Image
from rasterio.transform import Affine
from rasterio.warp import Resampling
from shapely import LineString, MultiPolygon, Point, Polygon
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

from terraino.export import MapKind, WorldData, write_world
from terraino.fetch import (
    ar5,
    kartverket,
    matrikkel,
    nibio,
    nvdb,
    nve,
    osm,
    topo,
    topo_buildings,
    watercourses,
)
from terraino.fetch.masts import fetch_masts
from terraino.fetch.topomap import ATTRIBUTION as TOPO_MAP_ATTRIBUTION
from terraino.fetch.topomap import fetch_topo_map
from terraino.ingest.area import (
    check_area,
    describe_area,
    describe_hoydedata_box,
    hoydedata_box,
    reproject_area,
    world_epsg,
)
from terraino.ingest.georef import Extent
from terraino.ingest.image import ImageMap, read_image_map
from terraino.ingest.lidar import ATTRIBUTION as LIDAR_ATTRIBUTION
from terraino.ingest.lidar import coarse_canopy, filled_canopy, load_lidar
from terraino.ingest.ocad import AREA_SYMBOL, TEXT_SYMBOL, export_ocad
from terraino.process.alignment import align, worth_shifting
from terraino.process.boundaries import STRETCH_M, VegetationBoundaries
from terraino.process.bridges import (
    Bridge,
    close_underpasses,
    cut_tracks,
    deck_mask,
    find_decks,
    open_underpasses,
    osm_bridges,
    place_pillars,
    suspected_bridges,
)
from terraino.process.buildings import collect_footprints, measure_buildings
from terraino.process.classify import classify_map
from terraino.process.features import (
    POLE_SPACING_M,
    Features,
    PointFeature,
    carve_cliffs,
    carve_pits,
    carve_waterholes,
    clear_along,
    clear_widths,
    collect_features,
    contour_rings,
    dig_small_depressions,
    drop_rocks_in_buildings,
    drop_ruins_in_buildings,
    measure_cliffs,
    paint_cliffs,
    place_power_poles,
    power_lines_outside,
    raise_earth_walls,
    raise_knolls,
    stand_lamp_posts,
)
from terraino.process.fuse import (
    add_lidar_undergrowth,
    add_low_vegetation,
    apply_land_cover,
    apply_osm,
    fill_unknown_ground,
)
from terraino.process.geometry import to_geometry
from terraino.process.heights import fill_missing
from terraino.process.layers import GroundLayers, rasterize_map
from terraino.process.maparea import find_map_area
from terraino.process.symbols import (
    Ground,
    SymbolSet,
    detect_symbol_set,
    is_helper_symbol,
)
from terraino.process.tracks import Track, collect_tracks
from terraino.process.trees import (
    TreeTops,
    canopy_height,
    effective_canopy,
    low_vegetation,
    place_trees,
    scattered_stumps,
    tops_from_lidar,
)
from terraino.process.watercourses import (
    leave_out_shores,
    paint_watercourses,
    water_mask,
)

log = logging.getLogger(__name__)

# Track styles of water, drawn as water strips rather than roads.
_WATER_TRACKS = frozenset({"stream", "small_stream", "water_channel"})

EXTENT_ALIGN_M = 16  # SR16's grid, so its cells line up with the world's
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff", ".kmz"}
DRAPE_PX_PER_M = 2
# Text anchors count as beside an area's hole within this distance on paper (mm).
LETTERING_REACH_MM = 1.5
# Weight for placing trees below the canopy: a base, plus the laser's understorey
# density (UNKNOWN_MID where it is unknown).
UNDERSTOREY_BASE_WEIGHT = 0.15
UNKNOWN_MID = 0.2
HOYDEDATA_URL = "https://hoydedata.no/LaserInnsyn2/"


def map_attribution(owner: str | None) -> str:
    """The credit for the orienteering map, shown with the other data sources.

    Example:
        >>> map_attribution("Eidskog OL")
        'Orienteering map: © Eidskog OL'
        >>> map_attribution(None)
        "Orienteering map: © the map's owner"
    """
    return f"Orienteering map: © {owner or "the map's owner"}"


@dataclass(frozen=True)
class BuildOptions:
    """Settings for a world build.

    Attributes:
        name: Name of the world, shown in the viewer, or None for the map's file name.
        owner: Who owns the orienteering map, credited in the viewer, or None.
        margin: Metres of terrain to include around the mapped area.
        offset: Shift ``(dx, dy)`` in metres applied to the map's georeference.
        cache_dir: Folder for downloaded data, shared between builds.
        sr16_dir: Local SR16 GeoTIFF folder, preferred over the download when it
            covers the map.
        symbol_set: Symbol standard (``"isom2000"``, ``"isom2017"``), or None to guess.
        epsg: Coordinate system of an image map's world file.
        forest: Set False to build terrain only.
        lidar_dirs: Folders with laser point clouds (LAZ tiles), most preferred first.
        spawn: Where the runner stands when the world opens ``(easting, northing)``,
            or None for a point inside the map.
        heading: Where the runner looks when the world opens, in degrees clockwise
            from grid north.
        area: The rectangle of a mapless world in EUREF89 / UTM33, or None to build
            from a map.
    """

    name: str | None = None
    owner: str | None = None
    margin: float = 300.0
    offset: tuple[float, float] = (0.0, 0.0)
    cache_dir: Path = Path("data-cache")
    sr16_dir: Path | None = None
    symbol_set: str | None = None
    epsg: int | None = None
    forest: bool = True
    lidar_dirs: tuple[Path, ...] = ()
    spawn: tuple[float, float] | None = None
    heading: float = 0.0
    area: Extent | None = None


@dataclass
class MapSource:
    """What the map contributes to the world, whatever its file format.

    A mapless world has a MapSource too: Kartverket's topographic map, which adds
    nothing to the ground but the picture.

    Attributes:
        epsg: Coordinate system of the world.
        extent: World extent.
        core_area: Outline of the core area: the mapped area of an orienteering map,
            or the chosen rectangle of a mapless world.
        scale: Map scale denominator, or None if unknown (image maps, mapless worlds).
        drape_png: Map texture covering the extent at DRAPE_PX_PER_M.
        map_png: Map image covering the extent at 1 px/m.
        symbols: Meaning of the map's symbols.
        layers: Ground layers read from the map.
        omap: The map's objects as GeoJSON features (empty for image maps).
        buildings: Building outlines found in an image map.
        features: Rocks, walls and other objects (OCAD maps only).
        cliff_lines: Cliff and rock face lines to measure against the terrain.
        kind: What kind of map it is.
    """

    epsg: int
    extent: Extent
    core_area: Polygon
    scale: float | None
    drape_png: Path
    map_png: Path
    symbols: SymbolSet
    layers: GroundLayers
    omap: list[dict[str, Any]] = field(default_factory=list)
    buildings: list[Polygon] = field(default_factory=list)
    features: Features | None = None
    cliff_lines: list[tuple[str, LineString]] = field(default_factory=list)
    kind: MapKind = "orienteering"

    @property
    def mapped_area(self) -> Polygon | None:
        """Where an orienteering map wins over other data, or None if there is none."""
        return self.core_area if self.kind == "orienteering" else None


def _ocad_source(map_path: Path, work: Path, options: BuildOptions) -> MapSource:
    log.info("Reading %s", map_path)
    first = export_ocad(map_path, work, offset=options.offset, render_png=False)
    objects = first.load_objects()
    area = find_map_area(objects, lambda sym: first.symbols[sym].is_terrain)
    if area.dropped_ids:
        log.info(
            "Ignoring %d objects outside the mapped area (legend, title)",
            len(area.dropped_ids),
        )
    extent = (
        Extent(*area.polygon.bounds).buffered(options.margin).snapped(EXTENT_ALIGN_M)
    )

    log.info("Rendering map images")
    final = export_ocad(
        map_path,
        work,
        extent=extent,
        offset=options.offset,
        keep_ids=area.keep_ids,
        drape_px_per_m=DRAPE_PX_PER_M,
    )
    keep = set(area.keep_ids)
    helpers = {n for n, s in final.symbols.items() if is_helper_symbol(s.description)}
    if helpers:
        log.info("Ignoring helper symbols: %s", ", ".join(sorted(helpers)))
    omap = [
        f
        for f in objects
        if f["properties"]["oid"] in keep and f["properties"]["sym"] not in helpers
    ]

    # Text anchors lie a little outside the holes cut for them in areas.
    reach = LETTERING_REACH_MM * final.scale / 1000
    lettering: list[BaseGeometry] = []
    for f in objects:
        if f["properties"].get("type") == TEXT_SYMBOL and f.get("geometry"):
            text = to_geometry(f["geometry"])
            if text is not None and text.intersects(area.polygon):
                lettering.append(text.buffer(reach))
    area_symbols = {
        s.number.split(".")[0] for s in final.symbols.values() if s.type == AREA_SYMBOL
    }
    symbols = SymbolSet.load(options.symbol_set or detect_symbol_set(area_symbols))
    log.info("Symbol set: %s", symbols.name)
    features, cliff_lines = collect_features(omap, symbols)
    return MapSource(
        epsg=final.epsg,
        extent=extent,
        core_area=area.polygon,
        scale=final.scale,
        drape_png=final.drape_png,
        map_png=final.map_png,
        symbols=symbols,
        layers=rasterize_map(omap, symbols, extent, area.polygon, lettering),
        omap=omap,
        features=features,
        cliff_lines=cliff_lines,
    )


def _image_source(map_path: Path, work: Path, options: BuildOptions) -> MapSource:
    log.info("Reading image map %s", map_path)
    image = read_image_map(map_path, options.epsg)
    if options.offset != (0.0, 0.0):
        shift = Affine.translation(*options.offset)
        image = ImageMap(
            rgb=image.rgb, transform=shift * image.transform, epsg=image.epsg
        )
    log.info(
        "Image map: %d x %d pixels, %.2f m per pixel, EPSG:%d",
        image.rgb.shape[1],
        image.rgb.shape[0],
        image.metres_per_pixel,
        image.epsg,
    )
    extent = image.bounds.buffered(options.margin).snapped(EXTENT_ALIGN_M)
    symbols = SymbolSet.load("isom2000")

    log.info("Reading the map's colours")
    classified = classify_map(
        image.resample(extent, 1),
        image.coverage(extent, 1),
        extent.raster_transform(1),
        symbols,
    )

    return MapSource(
        epsg=image.epsg,
        extent=extent,
        core_area=classified.map_area,
        scale=None,
        drape_png=_save_image(image, extent, DRAPE_PX_PER_M, work / "drape.png"),
        map_png=_save_image(image, extent, 1, work / "map.png"),
        symbols=symbols,
        layers=classified.layers,
        buildings=classified.buildings,
    )


def _mapless_source(area: Extent, work: Path, options: BuildOptions) -> MapSource:
    check_area(area)
    epsg = world_epsg(area)
    core = reproject_area(area, epsg)
    log.info("Mapless world. %s; building it in EPSG:%d", describe_area(area), epsg)
    extent = Extent(*core.bounds).buffered(options.margin).snapped(EXTENT_ALIGN_M)
    topo = fetch_topo_map(epsg, extent, options.cache_dir)
    symbols = SymbolSet.load("isom2017")
    return MapSource(
        epsg=epsg,
        extent=extent,
        core_area=core,
        scale=None,
        drape_png=_save_image(topo, extent, DRAPE_PX_PER_M, work / "drape.png"),
        map_png=_save_image(topo, extent, 1, work / "map.png"),
        symbols=symbols,
        layers=rasterize_map([], symbols, extent, Polygon()),
        kind="topographic",
    )


def _save_image(image: ImageMap, extent: Extent, px_per_m: float, path: Path) -> Path:
    """Save ``image`` over ``extent`` at ``px_per_m``, white where it has no pixels."""
    rgb = image.resample(extent, px_per_m, Resampling.bilinear)
    rgb[~image.coverage(extent, px_per_m)] = 255
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(path)
    return path


def _as_map_buildings(
    polygons: Sequence[Polygon], symbols: SymbolSet
) -> list[dict[str, Any]]:
    """Wrap building outlines found in an image as map objects with a building symbol."""
    number = next(n for n, r in symbols.rules.items() if r.ground is Ground.BUILDING)
    return [
        {"geometry": mapping(p), "properties": {"oid": i, "sym": number}}
        for i, p in enumerate(polygons)
    ]


def choose_spawn(
    spawn: tuple[float, float] | None, extent: Extent, core_area: Polygon
) -> tuple[float, float]:
    """Where the runner stands when the world opens.

    Args:
        spawn: The position asked for ``(easting, northing)``, or None.
        extent: World extent; the position must lie inside it.
        core_area: Outline of the core area. A position outside it is allowed,
            with a warning.

    Returns:
        ``spawn``, or if it is None the middle of the core area, or a point inside
        it when the middle is not.

    Raises:
        ValueError: If ``spawn`` is outside the world.

    Examples:
        >>> area = Polygon([(10, 10), (90, 10), (90, 90), (10, 90)])
        >>> choose_spawn((20.0, 30.0), Extent(0, 0, 100, 100), area)
        (20.0, 30.0)
        >>> choose_spawn(None, Extent(0, 0, 100, 100), area)
        (50.0, 50.0)
    """
    if spawn is None:
        point = core_area.centroid
        if not core_area.contains(point):
            point = core_area.representative_point()
        return (point.x, point.y)
    east, north = spawn
    if not (extent.x0 <= east <= extent.x1 and extent.y0 <= north <= extent.y1):
        msg = (
            f"The spawn position {east:.0f} {north:.0f} is outside the world"
            f" ({extent.x0:.0f}-{extent.x1:.0f} E, {extent.y0:.0f}-{extent.y1:.0f} N)"
        )
        raise ValueError(msg)
    if not core_area.contains(Point(east, north)):
        log.warning("The spawn position %.0f %.0f is outside the map", east, north)
    return spawn


def build_world(map_path: Path | None, out_dir: Path, options: BuildOptions) -> Path:
    """Build the world package for ``map_path``, or for ``options.area``, in ``out_dir``.

    Args:
        map_path: An OCAD file (``.ocd``) or a georeferenced image map, or None for a
            mapless world of ``options.area``.
        out_dir: World folder to write.
        options: Build settings.

    Returns:
        Path of the written ``manifest.json``.
    """
    name = options.name or (map_path.stem if map_path is not None else None)
    if name is None:
        msg = "A mapless world needs a name"
        raise ValueError(msg)
    source = _read_source(map_path, out_dir / "_work", options)

    extent = source.extent
    log.info(
        "World extent %s (%.1f x %.1f km)",
        extent,
        extent.width / 1e3,
        extent.height / 1e3,
    )
    _tell_hoydedata_box(source, options)
    # Before the downloads, so a mistyped position fails at once.
    spawn = choose_spawn(options.spawn, extent, source.core_area)
    cache = options.cache_dir
    dtm = fill_missing(kartverket.fetch_height_model("dtm", source.epsg, extent, cache))
    credit = (
        map_attribution(options.owner)
        if source.kind == "orienteering"
        else TOPO_MAP_ATTRIBUTION
    )
    world = WorldData(
        name=name,
        epsg=source.epsg,
        extent=extent,
        dtm=dtm,
        drape_png=source.drape_png,
        drape_px_per_m=DRAPE_PX_PER_M,
        map_png=source.map_png,
        map_scale=source.scale,
        map_kind=source.kind,
        core_area=source.core_area,
        omap_features=source.omap,
        spawn=spawn,
        spawn_heading=options.heading,
        attribution=[kartverket.ATTRIBUTION, credit],
        map_offset=options.offset,
    )
    if options.forest:
        _add_nature_and_buildings(world, source, dtm, options)

    log.info("Writing world package to %s", out_dir)
    return write_world(out_dir, world)


def _read_source(map_path: Path | None, work: Path, options: BuildOptions) -> MapSource:
    """Read the map, or fetch the topographic map of a mapless world's area.

    Raises:
        ValueError: If there is neither a map nor an area, or the file type is not
            supported.
    """
    if map_path is None:
        if options.area is None:
            msg = "Give a map file or an area"
            raise ValueError(msg)
        return _mapless_source(options.area, work, options)
    suffix = map_path.suffix.lower()
    if suffix == ".ocd":
        return _ocad_source(map_path, work, options)
    if suffix in IMAGE_SUFFIXES:
        return _image_source(map_path, work, options)
    msg = (
        f"Unsupported map file {map_path.name}: "
        "use OCAD (.ocd) or a georeferenced image"
    )
    raise ValueError(msg)


def _tell_hoydedata_box(source: MapSource, options: BuildOptions) -> None:
    """Log the box to export laser data for from hoydedata.no."""
    found = hoydedata_box(source.core_area, source.epsg, options.margin)
    log.info("%s", describe_hoydedata_box(found, options.margin))
    if not options.lidar_dirs:
        log.info(
            "No laser data given: export the point cloud (Punktsky) of this box from"
            " %s and pass its folder with --lidar",
            HOYDEDATA_URL,
        )


def _report_alignment(
    map_buildings: Sequence[dict[str, Any]],
    symbols: SymbolSet,
    topo: Sequence[topo_buildings.TopoBuilding],
    osm_features: Sequence[osm.OsmFeature],
    options: BuildOptions,
) -> None:
    """Log how far the map's buildings lie from Kartverket's (or OSM's), and the fix."""
    outlines = []
    for feature in map_buildings:
        rule = symbols.rule(feature["properties"]["sym"])
        if rule is None or rule.ground is not Ground.BUILDING:
            continue
        geometry = to_geometry(feature.get("geometry"))
        if isinstance(geometry, Polygon | MultiPolygon):
            outlines.append(geometry)
    if topo:
        reference: list[BaseGeometry] = [b.footprint for b in topo]
        source = "Kartverket's"
    else:
        reference = [
            f.geometry
            for f in osm_features
            if "building" in f.tags and isinstance(f.geometry, Polygon)
        ]
        source = "OpenStreetMap's"
    found = align(outlines, reference)
    if found is None:
        log.info("Too few buildings to check where the map lies against %s", source)
        return
    dx, dy = found.shift
    total = (options.offset[0] + dx, options.offset[1] + dy)
    message = (
        "The map's buildings lie %.1f m from %s on average (%d matched); "
        "shifting the map %.1f m %s and %.1f m %s (--offset %.1f %.1f) "
        "would bring them to %.1f m"
    )
    args = (
        found.before,
        source,
        found.matched,
        abs(dx),
        "east" if dx >= 0 else "west",
        abs(dy),
        "north" if dy >= 0 else "south",
        *total,
        found.after,
    )
    if worth_shifting(found):
        log.warning(message, *args)
    else:
        log.info(message, *args)


def _find_bridges(
    source: MapSource,
    osm_features: Sequence[osm.OsmFeature],
    nvdb_lines: Sequence[nvdb.NvdbLine],
    traced: Sequence[watercourses.Traced],
    dtm: npt.NDArray[np.float32],
    dom: npt.NDArray[np.float32],
) -> tuple[list[Track], list[Bridge]]:
    """Collect the roads, paths and streams; take the road bridges' decks out of them."""
    extent = source.extent
    mapped = source.mapped_area
    tracks = collect_tracks(
        source.omap, source.symbols, osm_features, mapped, nvdb_lines, traced
    )
    tagged = osm_bridges(osm_features)
    decks = find_decks(tracks, tagged, dtm, dom, extent, mapped)
    tracks, bridges = cut_tracks(tracks, decks)
    for x, y, dip in suspected_bridges(
        tracks, bridges, [b.line for b in tagged], dtm, dom, extent, mapped
    ):
        log.warning(
            "The ground drops %.1f m under the road at E %.0f N %.0f as under a "
            "bridge, but OpenStreetMap has no bridge there; leaving the road on the ground",
            dip,
            x,
            y,
        )
    return tracks, bridges


def _vegetation_boundaries(
    features: Features | None, extent: Extent, shape: tuple[int, ...]
) -> VegetationBoundaries | None:
    """The map's distinct vegetation boundaries, or None if it has none."""
    lines = [
        LineString(line.coords)
        for line in (features.lines if features is not None else [])
        if line.kind == "vegetation_boundary" and len(line.coords) >= 2
    ]
    if not lines:
        return None
    return VegetationBoundaries.find(lines, extent, (shape[0], shape[1]))


def _traced_watercourses(
    world: WorldData,
    source: MapSource,
    layers: GroundLayers,
    osm_features: Sequence[osm.OsmFeature],
    cache: Path,
) -> list[watercourses.Traced] | None:
    """Watercourses and water channels traced from Kartverket's map, without shores.

    Returns:
        The lines, or None if the map could not be read (OSM's streams are used then).
    """
    traced = watercourses.fetch_watercourses(source.epsg, source.extent, cache)
    if traced is None:
        return None
    water = water_mask(layers, osm_features, source.extent)
    kept = leave_out_shores(traced, water, source.extent)
    mapped = source.mapped_area
    outside = [line for _, line in kept if mapped is None or not mapped.covers(line)]
    log.info(
        "Traced %d watercourses and water channels from Kartverket's map "
        "(%.1f km outside the map; left out %d shores)",
        len(kept),
        sum(
            (line if mapped is None else line.difference(mapped)).length
            for line in outside
        )
        / 1000,
        len(traced) - len(kept),
    )
    if outside and topo.ATTRIBUTION not in world.attribution:
        world.attribution = [*world.attribution, topo.ATTRIBUTION]
    return kept


def _add_power_lines(world: WorldData, source: MapSource, cache: Path) -> None:
    """Put the map's power lines on their masts, and add NVE's outside the map."""
    extent = source.extent
    on_map = [] if world.features is None else world.features.lines
    registered = nve.fetch_power_lines(source.epsg, extent, cache)
    outside = power_lines_outside(
        ((p.kind, p.line) for p in registered), source.mapped_area
    )
    if not outside and not any(line.kind in POLE_SPACING_M for line in on_map):
        return
    masts = fetch_masts(source.epsg, extent, cache)
    if masts and topo_buildings.ATTRIBUTION not in world.attribution:
        world.attribution = [*world.attribution, topo_buildings.ATTRIBUTION]
    lines = place_power_poles(on_map, outside, masts, source.mapped_area)
    poled = [line for line in lines if line.kind in POLE_SPACING_M]
    log.info(
        "Power lines: %d of %d with poles on registered masts",
        sum(bool(line.poles) for line in poled),
        len(poled),
    )
    if outside:
        log.info("Drew %d power lines from NVE outside the map", len(outside))
        world.attribution = [*world.attribution, nve.ATTRIBUTION]
        clear_along(source.layers, outside, clear_widths(source.symbols), extent)
    if world.features is None:
        world.features = Features()
    world.features.lines = lines


def _add_nature_and_buildings(
    world: WorldData,
    source: MapSource,
    dtm: npt.NDArray[np.float32],
    options: BuildOptions,
) -> None:
    """Add ground layers, buildings, map features and trees to ``world``."""
    extent = source.extent
    cache = options.cache_dir
    dom = kartverket.fetch_height_model("dom", source.epsg, extent, cache)
    chm = canopy_height(dom, dtm)
    layers = source.layers

    lidar = None
    surface = None
    if options.lidar_dirs:
        lidar = load_lidar(options.lidar_dirs, source.epsg, extent, dtm, cache)
        if lidar is None:
            log.warning("No laser tiles cover the world; using the height models only")
        else:
            surface = filled_canopy(lidar, chm)
            world.attribution = [*world.attribution, LIDAR_ATTRIBUTION]
            world.lidar = True

    land_cover = ar5.fetch_land_cover(source.epsg, extent, cache)
    if land_cover is not None:
        apply_land_cover(layers, land_cover)
        world.attribution = [*world.attribution, ar5.ATTRIBUTION]
    osm_features = osm.fetch_osm(source.epsg, extent, cache)
    nvdb_lines = nvdb.fetch_paths(source.epsg, extent, cache)
    mapped = source.mapped_area
    if any(mapped is None or not mapped.covers(n.line) for n in nvdb_lines):
        world.attribution = [*world.attribution, nvdb.ATTRIBUTION]
    traced = _traced_watercourses(world, source, layers, osm_features, cache)
    # Before the terrain is shaped, while the surface model is at hand.
    tracks, bridges = _find_bridges(
        source, osm_features, nvdb_lines, traced or [], dtm, dom
    )
    del dom
    map_buildings = source.omap + _as_map_buildings(source.buildings, source.symbols)
    topo = topo_buildings.fetch_topo_buildings(source.epsg, extent, cache)
    if topo:
        world.attribution = [*world.attribution, topo_buildings.ATTRIBUTION]
    footprints = collect_footprints(osm_features, map_buildings, source.symbols, topo)
    if source.kind == "orienteering":
        _report_alignment(map_buildings, source.symbols, topo, osm_features, options)
    log.info(
        "Building outlines: %s",
        ", ".join(
            f"{n} from {s}" for s, n in Counter(fp[2] for fp in footprints).items()
        ),
    )
    topo_by_id = {f"kartverket/{i}": b for i, b in enumerate(topo)}
    roads = [
        (LineString(t.coords), t.width) for t in tracks if t.kind not in _WATER_TRACKS
    ]
    apply_osm(
        layers,
        osm_features,
        roads,
        [fp[0] for fp in footprints],
        extent,
        streams=traced is None,
    )
    if traced:
        paint_watercourses(layers, traced, source.symbols, extent, mapped)
    registry = matrikkel.fetch_building_points(source.epsg, extent, cache)
    if registry:
        world.attribution = [*world.attribution, matrikkel.ATTRIBUTION]
    buildings = measure_buildings(
        footprints,
        dtm,
        chm,
        extent,
        surface=surface,
        registry=registry,
        topo=topo_by_id,
    )
    log.info(
        "%d of %d buildings have a type from Matrikkelen",
        sum(b.type_code is not None for b in buildings),
        len(buildings),
    )
    roofs = Counter(b.roof_type for b in buildings)
    log.info(
        "Raised %d buildings (roofs: %s)",
        len(buildings),
        ", ".join(f"{n} {kind}" for kind, n in roofs.most_common()),
    )
    world.buildings = buildings
    tracks, under = close_underpasses(tracks, bridges)
    if source.omap:
        bridges = open_underpasses(
            layers, source.omap, source.symbols, bridges, under, extent
        )
    bridges = place_pillars(bridges, tracks, layers, dtm, extent)
    if bridges:
        log.info(
            "Built %d bridges (%d pillars); joined %d roads under them",
            len(bridges),
            sum(len(b.pillars) for b in bridges),
            len(under),
        )
        # The surface model's deck is not vegetation.
        decks = deck_mask(bridges, extent, chm.shape)
        chm[decks] = 0
        if surface is not None:
            fine = surface.shape[0] // chm.shape[0]
            surface[decks.repeat(fine, axis=0).repeat(fine, axis=1)] = 0
    world.tracks = tracks
    world.bridges = bridges
    log.info("Drew %d roads and paths", len(world.tracks))
    if osm_features:
        world.attribution = [*world.attribution, osm.ATTRIBUTION]

    if source.features is not None:
        objects = source.features
        rings = contour_rings(source.omap, source.symbols)
        knolls, ring_knolls = raise_knolls(dtm, objects.points, rings, extent)
        log.info(
            "Raised %d knolls, and %d knolls drawn with contours (of %d small rings)",
            knolls,
            ring_knolls,
            len(rings),
        )
        walls = raise_earth_walls(dtm, objects.lines, extent)
        log.info(
            "Raised %d of %d earth walls",
            walls,
            sum(line.kind == "earth_wall" for line in objects.lines),
        )
        objects.cliffs = measure_cliffs(source.cliff_lines, dtm, extent)
        dropped = drop_rocks_in_buildings(objects, [fp[0] for fp in footprints])
        if dropped:
            log.info("Left out %d rocks standing in buildings", dropped)
        dropped = drop_ruins_in_buildings(objects, [fp[0] for fp in footprints])
        if dropped:
            log.info("Left out %d ruins overlapping buildings", dropped)
        carve_cliffs(dtm, objects.cliffs, extent)
        carve_waterholes(dtm, layers, objects.points, extent)
        carve_pits(dtm, layers, objects.points, extent)
        lamp_posts = stand_lamp_posts(objects, world.tracks)
        if lamp_posts:
            log.info("Moved %d lamp posts beside the trails they light", lamp_posts)
        depressions = dig_small_depressions(dtm, objects.points, extent)
        log.info(
            "Dug %d of %d small depressions",
            depressions,
            sum(p.kind == "small_depression" for p in objects.points),
        )
        paint_cliffs(layers, objects.cliffs, extent)
        world.features = objects
        log.info(
            "Placed %d objects, %d walls/fences/lines and %d cliffs",
            len(objects.points),
            len(objects.lines),
            len(objects.cliffs),
        )
    # Before the trees are planted, which keep out of power line corridors.
    _add_power_lines(world, source, cache)

    if lidar is not None and surface is not None:
        add_low_vegetation(layers, low_vegetation(coarse_canopy(surface)))
        add_lidar_undergrowth(layers, lidar.low)
        log.info("Finding trees in the laser point cloud")
        tops: TreeTops | None = tops_from_lidar(surface, lidar.crown_base)
        understorey: npt.NDArray[np.float32] | None = (
            UNDERSTOREY_BASE_WEIGHT + np.nan_to_num(lidar.mid, nan=UNKNOWN_MID)
        ).astype(np.float32)
        del surface, lidar
    else:
        add_low_vegetation(layers, low_vegetation(chm))
        tops = understorey = None

    forest = nibio.fetch_forest(source.epsg, extent, cache, options.sr16_dir)
    seed = int(extent.x0 + extent.y0) % 2**32
    boundaries = _vegetation_boundaries(source.features, extent, layers.ground.shape)
    species = forest.species
    if boundaries is not None:
        species = boundaries.species(species)
    trees = place_trees(
        chm,
        layers,
        species,
        forest.trees_per_ha,
        seed=seed,
        tops=tops,
        understorey_weight=understorey,
        sides=None if boundaries is None else boundaries.sides(),
    )
    if boundaries is not None:
        trees, report = boundaries.invent_contrast(trees, layers, species, seed)
        log.info(
            "Vegetation boundaries: %d of %d stretches of %.0f m had alike trees on "
            "both sides; made a young stand along %d boundaries and lowered the trees "
            "along %d (%d trees)",
            report.lacking,
            report.stretches,
            STRETCH_M,
            report.young,
            report.lowered,
            report.trees,
        )
    stump_rows, stump_cols, stump_heights = scattered_stumps(chm, layers, tops)
    if len(stump_rows):
        if world.features is None:
            world.features = Features()
        world.features.points.extend(
            PointFeature(
                "stump",
                extent.x0 + float(c),
                extent.y1 - float(r),
                size=float(np.clip(0.02 * h + 0.1, 0.15, 0.6)),
            )
            for r, c, h in zip(stump_rows, stump_cols, stump_heights, strict=True)
        )
        log.info("Left %d stumps where the map shows scattered trees", len(stump_rows))
    canopy = effective_canopy(chm, layers)
    fill_unknown_ground(layers, canopy)
    counts = np.bincount(trees.species, minlength=4)[1:]
    thickets = 0 if trees.thicket is None else int(trees.thicket.sum())
    log.info(
        "Planted %d trees (%d spruce, %d pine, %d deciduous), %d of them thickets",
        len(trees),
        *counts,
        thickets,
    )
    world.layers = layers
    world.canopy = canopy
    world.trees = trees
    world.attribution = [*world.attribution, nibio.ATTRIBUTION]
