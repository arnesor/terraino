"""Build a 3D world package from an orienteering map."""

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
from shapely import LineString, Polygon
from shapely.geometry import mapping

from otest.export import WorldData, write_world
from otest.fetch import ar5, kartverket, nibio, osm
from otest.ingest.georef import Extent
from otest.ingest.image import ImageMap, read_image_map
from otest.ingest.lidar import ATTRIBUTION as LIDAR_ATTRIBUTION
from otest.ingest.lidar import coarse_canopy, filled_canopy, load_lidar
from otest.ingest.ocad import AREA_SYMBOL, export_ocad
from otest.process.buildings import collect_footprints, measure_buildings
from otest.process.classify import classify_map
from otest.process.features import (
    Features,
    PointFeature,
    carve_cliffs,
    collect_features,
    measure_cliffs,
    paint_cliffs,
)
from otest.process.fuse import (
    add_lidar_undergrowth,
    add_low_vegetation,
    apply_land_cover,
    apply_osm,
    fill_unknown_ground,
)
from otest.process.heights import fill_missing
from otest.process.layers import GroundLayers, rasterize_map
from otest.process.maparea import find_map_area
from otest.process.symbols import Ground, SymbolSet, detect_symbol_set, is_helper_symbol
from otest.process.tracks import collect_tracks
from otest.process.trees import (
    TreeTops,
    canopy_height,
    effective_canopy,
    low_vegetation,
    place_trees,
    scattered_stumps,
    tops_from_lidar,
)

log = logging.getLogger(__name__)

EXTENT_ALIGN_M = 16  # SR16's grid, so its cells line up with the world's
OMAP_ATTRIBUTION = "Orienteering map: © the map's owner"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff", ".kmz"}
DRAPE_PX_PER_M = 2
# Weight for placing trees below the canopy: a base, plus the laser's understorey
# density (UNKNOWN_MID where it is unknown).
UNDERSTOREY_BASE_WEIGHT = 0.15
UNKNOWN_MID = 0.2


@dataclass(frozen=True)
class BuildOptions:
    """Settings for a world build.

    Attributes:
        margin: Metres of terrain to include around the mapped area.
        offset: Shift ``(dx, dy)`` in metres applied to the map's georeference.
        cache_dir: Folder for downloaded data, shared between builds.
        sr16_dir: Local SR16 GeoTIFF folder, preferred over the download when it
            covers the map.
        symbol_set: Symbol standard (``"isom2000"``, ``"isom2017"``), or None to guess.
        epsg: Coordinate system of an image map's world file.
        forest: Set False to build terrain only.
        lidar_dirs: Folders with laser point clouds (LAZ tiles), most preferred first.
    """

    margin: float = 300.0
    offset: tuple[float, float] = (0.0, 0.0)
    cache_dir: Path = Path("data-cache")
    sr16_dir: Path | None = None
    symbol_set: str | None = None
    epsg: int | None = None
    forest: bool = True
    lidar_dirs: tuple[Path, ...] = ()


@dataclass
class MapSource:
    """What an orienteering map contributes to the world, whatever its file format.

    Attributes:
        epsg: Coordinate system of the world.
        extent: World extent.
        map_area: Outline of the mapped area.
        scale: Map scale denominator, or None if unknown (image maps).
        drape_png: Map texture covering the extent at DRAPE_PX_PER_M.
        map_png: Map image covering the extent at 1 px/m.
        symbols: Meaning of the map's symbols.
        layers: Ground layers read from the map.
        omap: The map's objects as GeoJSON features (empty for image maps).
        buildings: Building outlines found in an image map.
        features: Rocks, walls and other objects (OCAD maps only).
        cliff_lines: Cliff and rock face lines to measure against the terrain.
    """

    epsg: int
    extent: Extent
    map_area: Polygon
    scale: float | None
    drape_png: Path
    map_png: Path
    symbols: SymbolSet
    layers: GroundLayers
    omap: list[dict[str, Any]] = field(default_factory=list)
    buildings: list[Polygon] = field(default_factory=list)
    features: Features | None = None
    cliff_lines: list[tuple[str, LineString]] = field(default_factory=list)


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

    area_symbols = {
        s.number.split(".")[0] for s in final.symbols.values() if s.type == AREA_SYMBOL
    }
    symbols = SymbolSet.load(options.symbol_set or detect_symbol_set(area_symbols))
    log.info("Symbol set: %s", symbols.name)
    features, cliff_lines = collect_features(omap, symbols)
    return MapSource(
        epsg=final.epsg,
        extent=extent,
        map_area=area.polygon,
        scale=final.scale,
        drape_png=final.drape_png,
        map_png=final.map_png,
        symbols=symbols,
        layers=rasterize_map(omap, symbols, extent, area.polygon),
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

    work.mkdir(parents=True, exist_ok=True)

    def save(px_per_m: float, name: str) -> Path:
        rgb = image.resample(extent, px_per_m, Resampling.bilinear)
        rgb[~image.coverage(extent, px_per_m)] = 255
        path = work / name
        Image.fromarray(rgb).save(path)
        return path

    return MapSource(
        epsg=image.epsg,
        extent=extent,
        map_area=classified.map_area,
        scale=None,
        drape_png=save(DRAPE_PX_PER_M, "drape.png"),
        map_png=save(1, "map.png"),
        symbols=symbols,
        layers=classified.layers,
        buildings=classified.buildings,
    )


def _as_map_buildings(
    polygons: Sequence[Polygon], symbols: SymbolSet
) -> list[dict[str, Any]]:
    """Wrap building outlines found in an image as map objects with a building symbol."""
    number = next(n for n, r in symbols.rules.items() if r.ground is Ground.BUILDING)
    return [
        {"geometry": mapping(p), "properties": {"oid": i, "sym": number}}
        for i, p in enumerate(polygons)
    ]


def build_world(map_path: Path, out_dir: Path, options: BuildOptions) -> Path:
    """Build the world package for ``map_path`` in ``out_dir``.

    Args:
        map_path: An OCAD file (``.ocd``) or a georeferenced image map.
        out_dir: World folder to write.
        options: Build settings.

    Returns:
        Path of the written ``manifest.json``.

    Raises:
        ValueError: If the file type is not supported.
    """
    suffix = map_path.suffix.lower()
    work = out_dir / "_work"
    if suffix == ".ocd":
        source = _ocad_source(map_path, work, options)
    elif suffix in IMAGE_SUFFIXES:
        source = _image_source(map_path, work, options)
    else:
        msg = (
            f"Unsupported map file {map_path.name}: "
            "use OCAD (.ocd) or a georeferenced image"
        )
        raise ValueError(msg)

    extent = source.extent
    log.info(
        "World extent %s (%.1f x %.1f km)",
        extent,
        extent.width / 1e3,
        extent.height / 1e3,
    )
    cache = options.cache_dir
    dtm = fill_missing(kartverket.fetch_height_model("dtm", source.epsg, extent, cache))
    spawn = source.map_area.representative_point()
    world = WorldData(
        name=map_path.stem,
        epsg=source.epsg,
        extent=extent,
        dtm=dtm,
        drape_png=source.drape_png,
        drape_px_per_m=DRAPE_PX_PER_M,
        map_png=source.map_png,
        map_scale=source.scale,
        map_area=source.map_area,
        omap_features=source.omap,
        spawn=(spawn.x, spawn.y),
        attribution=[kartverket.ATTRIBUTION, OMAP_ATTRIBUTION],
    )
    if options.forest:
        _add_nature_and_buildings(world, source, dtm, options)

    log.info("Writing world package to %s", out_dir)
    return write_world(out_dir, world)


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
    del dom
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
    map_buildings = source.omap + _as_map_buildings(source.buildings, source.symbols)
    footprints = collect_footprints(osm_features, map_buildings, source.symbols)
    apply_osm(layers, osm_features, [fp[0] for fp in footprints], extent)
    buildings = measure_buildings(footprints, dtm, chm, extent, surface=surface)
    roofs = Counter(b.roof_type for b in buildings)
    log.info(
        "Raised %d buildings (roofs: %s)",
        len(buildings),
        ", ".join(f"{n} {kind}" for kind, n in roofs.most_common()),
    )
    world.buildings = buildings
    world.tracks = collect_tracks(
        source.omap, source.symbols, osm_features, source.map_area
    )
    log.info("Drew %d roads and paths", len(world.tracks))
    if osm_features:
        world.attribution = [*world.attribution, osm.ATTRIBUTION]

    if source.features is not None:
        objects = source.features
        objects.cliffs = measure_cliffs(source.cliff_lines, dtm, extent)
        carve_cliffs(dtm, objects.cliffs, extent)
        paint_cliffs(layers, objects.cliffs, extent)
        world.features = objects
        log.info(
            "Placed %d objects, %d walls/fences/lines and %d cliffs",
            len(objects.points),
            len(objects.lines),
            len(objects.cliffs),
        )

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
    trees = place_trees(
        chm,
        layers,
        forest.species,
        forest.trees_per_ha,
        seed=int(extent.x0 + extent.y0) % 2**32,
        tops=tops,
        understorey_weight=understorey,
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
    log.info("Planted %d trees (%d spruce, %d pine, %d deciduous)", len(trees), *counts)
    world.layers = layers
    world.canopy = canopy
    world.trees = trees
    world.attribution = [*world.attribution, nibio.ATTRIBUTION]
