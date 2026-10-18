"""Write the world package read by the 3D viewer.

Layout of a world folder::

    manifest.json               everything the viewer needs to know (see write_world)
    height/{cx}_{cy}.bin        uint16 little-endian height samples, (CHUNK+1)^2 per chunk,
                                or (CHUNK/COARSE_STEP+1)^2 for chunks away from the map
    layers/{cx}_{cy}.png        ground layers per height sample, (CHUNK+1)^2 RGB pixels
    layers_overview.png         ground layers of the whole world at LAYER_OVERVIEW_STEP m
    trees/{cx}_{cy}.bin         the trees standing in a chunk, TREE_DTYPE records
    buildings.json              building footprints, heights, roofs and colours
    features.json               rocks, cliffs, walls, fences and other map features
    tracks.json                 roads and paths as lines with a style and width
    drape/{cx}_{cy}.jpg         orienteering map texture for one chunk
    drape_overview.jpg          low-resolution map texture of the whole world
    map.jpg                     the orienteering map, for the in-game map view
    vectors/omap.geojson        the map's terrain objects in projected coordinates

Height samples sit at the centres of the 1 m DTM cells. Chunk (cx, cy) holds rows
``cy*CHUNK .. cy*CHUNK+CHUNK`` and the same columns, counted from the north-west sample,
so neighbouring chunks share their edge samples. Samples beyond the grid repeat the edge.
Chunks more than DETAIL_MARGIN_M from the map's outline keep only every COARSE_STEP-th
sample in both directions; the manifest lists them (``height.coarse``).

Layer pixels match the height samples one to one. Their channels are:

- R: ground class (otest.process.symbols.Ground)
- G: canopy height in units of CANOPY_UNIT_M
- B: undergrowth level (0..15) in the high nibble, running speed level (0..15,
  speed = level / 15) in the low nibble

Tree positions are relative to the chunk's north-west sample, in scene axes
(x east, z south), sorted from tallest to smallest. Building outlines are in scene
coordinates: x east and z south of the north-west height sample.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
from PIL import Image
from shapely import Polygon, box

from otest.ingest.georef import Extent
from otest.process.buildings import Building
from otest.process.features import Features
from otest.process.layers import GroundLayers
from otest.process.symbols import Ground
from otest.process.tracks import Track
from otest.process.trees import Trees

FORMAT_VERSION = 3
CHUNK = 256
HEIGHT_STEP_M = 1.0
# Height chunks this far from the map keep full detail; the others every COARSE_STEP-th sample.
DETAIL_MARGIN_M = 100.0
COARSE_STEP = 4
OVERVIEW_MAX_PX = 4096
JPEG_QUALITY = 88
UINT16_MAX = 65535
CANOPY_UNIT_M = 0.25
LEVELS = 15
LAYER_OVERVIEW_STEP = 4
TREE_POS_SCALE = 256  # 1/256 m
TREE_HEIGHT_SCALE = 100  # cm
TREE_CROWN_SCALE = 20  # 5 cm
TREE_DTYPE = np.dtype(
    [("x", "<u2"), ("z", "<u2"), ("height", "<u2"), ("crown", "u1"), ("species", "u1")]
)
SPECIES_NAMES = {1: "spruce", 2: "pine", 3: "deciduous"}
# Added to the species byte of trees that grew up in a stand (seed trees left standing).
STAND_GROWN_FLAG = 16
# Crown base class in bits 5-6 of the species byte: 0 unknown, 1 branches to the
# ground, 2 lowest third bare, 3 lower half or more bare (limits as shares of height).
CROWN_BASE_SHIFT = 5
CROWN_BASE_LIMITS = (0.19, 0.41)

# The rendered map images are large; they come from our own exporter.
Image.MAX_IMAGE_PIXELS = None


@dataclass(frozen=True)
class HeightEncoding:
    """Linear uint16 encoding of heights: ``height = offset + value * scale``."""

    offset: float
    scale: float

    @classmethod
    def for_range(cls, low: float, high: float) -> HeightEncoding:
        """Pick a 1 cm (or coarser, for very tall ranges) encoding covering the range.

        Examples:
            >>> HeightEncoding.for_range(152.2, 260.0)
            HeightEncoding(offset=152.0, scale=0.01)
        """
        offset = float(math.floor(low))
        scale = 0.01
        while (high - offset) / scale > UINT16_MAX:
            scale *= 2
        return cls(offset=offset, scale=scale)

    def encode(self, heights: npt.NDArray[np.float32]) -> npt.NDArray[np.uint16]:
        """Encode heights as uint16."""
        values = np.rint((heights - self.offset) / self.scale)
        return np.clip(values, 0, UINT16_MAX).astype("<u2")


@dataclass
class WorldData:
    """Everything that goes into a world package.

    Attributes:
        name: Display name of the world.
        epsg: EPSG code of all coordinates in the package.
        extent: World extent; all rasters and images cover it exactly.
        dtm: Bare-ground heights at 1 m, north-up, without NaN.
        drape_png: Orienteering map texture covering ``extent``.
        drape_px_per_m: Resolution of ``drape_png``.
        map_png: Orienteering map image covering ``extent``.
        map_scale: Map scale denominator, or None if unknown.
        map_offset: Shift ``(dx, dy)`` in metres that was applied to the map's
            georeference; the viewer applies it to courses read from OCAD files.
        map_area: Outline of the mapped area.
        omap_features: The map's terrain objects (GeoJSON features).
        spawn: Start position ``(easting, northing)``.
        attribution: Data source credits to show in the viewer.
        layers: Ground layers, or None for a terrain-only world.
        canopy: Canopy height at 1 m for distant forest shading (with ``layers``).
        trees: Trees to plant, or None.
        buildings: Buildings to raise, or None.
        features: Rocks, cliffs, walls and other map features, or None.
        tracks: Roads and paths, or None.
        lidar: True if a laser point cloud shaped the trees, undergrowth and roofs.
    """

    name: str
    epsg: int
    extent: Extent
    dtm: npt.NDArray[np.float32]
    drape_png: Path
    drape_px_per_m: float
    map_png: Path
    map_scale: float | None
    map_area: Polygon
    omap_features: Sequence[dict[str, Any]]
    spawn: tuple[float, float]
    attribution: Sequence[str]
    layers: GroundLayers | None = None
    canopy: npt.NDArray[np.float32] | None = field(default=None, repr=False)
    trees: Trees | None = None
    buildings: Sequence[Building] | None = None
    features: Features | None = None
    tracks: Sequence[Track] | None = None
    lidar: bool = False
    map_offset: tuple[float, float] = (0.0, 0.0)


def _chunk(grid: npt.NDArray[Any], cx: int, cy: int) -> npt.NDArray[Any]:
    rows, cols = grid.shape[:2]
    r = np.clip(np.arange(cy * CHUNK, cy * CHUNK + CHUNK + 1), 0, rows - 1)
    c = np.clip(np.arange(cx * CHUNK, cx * CHUNK + CHUNK + 1), 0, cols - 1)
    chunk: npt.NDArray[Any] = grid[np.ix_(r, c)]
    return chunk


def _chunk_counts(shape: tuple[int, ...]) -> tuple[int, int]:
    rows, cols = shape[:2]
    return math.ceil((cols - 1) / CHUNK), math.ceil((rows - 1) / CHUNK)


def coarse_chunks(
    extent: Extent, shape: tuple[int, ...], map_area: Polygon
) -> list[int]:
    """Indices (``cy * chunksX + cx``) of height chunks away from the map.

    A chunk keeps full detail if it lies within DETAIL_MARGIN_M of the map's outline:
    that is where the runner goes. The others are only seen from a distance.
    """
    nx, ny = _chunk_counts(shape)
    near = map_area.buffer(DETAIL_MARGIN_M)
    west = extent.x0 + HEIGHT_STEP_M / 2
    north = extent.y1 - HEIGHT_STEP_M / 2
    size = CHUNK * HEIGHT_STEP_M
    coarse = []
    for cy in range(ny):
        for cx in range(nx):
            x0 = west + cx * size
            y1 = north - cy * size
            if not near.intersects(box(x0, y1 - size, x0 + size, y1)):
                coarse.append(cy * nx + cx)
    return coarse


def _write_heights(
    out_dir: Path,
    dtm: npt.NDArray[np.float32],
    encoding: HeightEncoding,
    coarse: set[int],
) -> tuple[int, int]:
    nx, ny = _chunk_counts(dtm.shape)
    folder = out_dir / "height"
    folder.mkdir(parents=True, exist_ok=True)
    for cy in range(ny):
        for cx in range(nx):
            chunk = _chunk(dtm, cx, cy)
            if cy * nx + cx in coarse:
                chunk = chunk[::COARSE_STEP, ::COARSE_STEP]
            data = encoding.encode(chunk)
            (folder / f"{cx}_{cy}.bin").write_bytes(data.tobytes())
    return nx, ny


def encode_layers(
    layers: GroundLayers, canopy: npt.NDArray[np.float32]
) -> npt.NDArray[np.uint8]:
    """Pack ground layers into an RGB image (see the module docstring).

    Examples:
        >>> from otest.process.layers import GroundLayers
    from otest.process.tracks import Track
        >>> one = np.ones((1, 1), dtype=np.float32)
        >>> layers = GroundLayers(
        ...     ground=np.full((1, 1), 4, np.uint8), speed=one * 0.6, young=one * 0,
        ...     shrubs=one * 0.5, tree_rule=np.zeros((1, 1), np.uint8),
        ...     clear=one < 0, in_map=one > 0)
        >>> encode_layers(layers, one * 12.3).tolist()
        [[[4, 49, 137]]]
    """
    rgb = np.empty((*layers.ground.shape, 3), dtype=np.uint8)
    rgb[..., 0] = layers.ground
    rgb[..., 1] = np.clip(np.rint(canopy / CANOPY_UNIT_M), 0, 255)
    shrubs = np.clip(np.rint(layers.shrubs * LEVELS), 0, LEVELS).astype(np.uint8)
    speed = np.clip(np.rint(layers.speed * LEVELS), 0, LEVELS).astype(np.uint8)
    rgb[..., 2] = (shrubs << 4) | speed
    return rgb


def _write_layers(
    out_dir: Path, rgb: npt.NDArray[np.uint8], chunks: tuple[int, int]
) -> None:
    folder = out_dir / "layers"
    folder.mkdir(parents=True, exist_ok=True)
    for cy in range(chunks[1]):
        for cx in range(chunks[0]):
            Image.fromarray(_chunk(rgb, cx, cy)).save(
                folder / f"{cx}_{cy}.png", optimize=True
            )
    # Overview: one pixel per LAYER_OVERVIEW_STEP cells, the tallest canopy in the block.
    step = LAYER_OVERVIEW_STEP
    rows, cols = rgb.shape[0] // step * step, rgb.shape[1] // step * step
    blocks = rgb[:rows, :cols].reshape(rows // step, step, cols // step, step, 3)
    overview = blocks[:, step // 2, :, step // 2, :].copy()
    overview[..., 1] = blocks[..., 1].max(axis=(1, 3))
    Image.fromarray(overview).save(out_dir / "layers_overview.png", optimize=True)


def _write_trees(out_dir: Path, trees: Trees, chunks: tuple[int, int]) -> list[int]:
    """Write one tree file per chunk; return the number of trees in each chunk."""
    folder = out_dir / "trees"
    folder.mkdir(parents=True, exist_ok=True)
    # Tree positions are cell coordinates; height samples sit at cell centres.
    x = trees.col - 0.5
    z = trees.row - 0.5
    cx = np.clip((x // CHUNK).astype(np.int64), 0, chunks[0] - 1)
    cy = np.clip((z // CHUNK).astype(np.int64), 0, chunks[1] - 1)
    chunk_id = cy * chunks[0] + cx
    order = np.lexsort((-trees.height, chunk_id))
    records = np.empty(len(trees), dtype=TREE_DTYPE)
    local_x = np.clip(x - cx * CHUNK, 0, CHUNK - 1 / TREE_POS_SCALE)
    local_z = np.clip(z - cy * CHUNK, 0, CHUNK - 1 / TREE_POS_SCALE)
    records["x"] = np.rint(local_x * TREE_POS_SCALE)
    records["z"] = np.rint(local_z * TREE_POS_SCALE)
    records["height"] = np.clip(
        np.rint(trees.height * TREE_HEIGHT_SCALE), 0, UINT16_MAX
    )
    records["crown"] = np.clip(np.rint(trees.crown * TREE_CROWN_SCALE), 0, 255)
    records["species"] = trees.species
    if trees.stand_grown is not None:
        records["species"] |= np.where(trees.stand_grown, STAND_GROWN_FLAG, 0).astype(
            np.uint8
        )
    if trees.crown_base is not None:
        base = trees.crown_base
        crown_class = np.where(
            np.isfinite(base),
            np.digitize(np.nan_to_num(base), CROWN_BASE_LIMITS) + 1,
            0,
        ).astype(np.uint8)
        records["species"] |= crown_class << CROWN_BASE_SHIFT
    records = records[order]
    sorted_ids = chunk_id[order]

    counts = np.bincount(sorted_ids, minlength=chunks[0] * chunks[1])
    starts = np.concatenate([[0], np.cumsum(counts)])
    for i in range(chunks[0] * chunks[1]):
        part = records[starts[i] : starts[i + 1]]
        name = f"{i % chunks[0]}_{i // chunks[0]}.bin"
        (folder / name).write_bytes(part.tobytes())
    return [int(n) for n in counts]


def _write_buildings(
    out_dir: Path, buildings: Sequence[Building], extent: Extent
) -> None:
    ox = extent.x0 + HEIGHT_STEP_M / 2
    oz = extent.y1 - HEIGHT_STEP_M / 2
    records = []
    for b in buildings:
        ring = list(b.footprint.exterior.coords)[:-1]
        records.append(
            {
                "outline": [[round(x - ox, 2), round(oz - y, 2)] for x, y in ring],
                "base": round(b.base, 2),
                "wall": b.wall,
                "roof": b.roof,
                "roofType": b.roof_type,
                # Ridge direction as a unit vector in scene axes (x east, z south).
                "ridge": [round(math.cos(b.ridge), 4), round(-math.sin(b.ridge), 4)],
                "wallColor": b.wall_color,
                "roofColor": b.roof_color,
                "kind": b.kind,
                "type": b.type_code,
                "floors": b.floors,
                # Wings measured in a laser point cloud, each with its own roof.
                "parts": [
                    {
                        "type": p.roof_type,
                        "centre": [
                            round(p.centre[0] - ox, 2),
                            round(oz - p.centre[1], 2),
                        ],
                        "axis": [
                            round(math.cos(p.angle), 4),
                            round(-math.sin(p.angle), 4),
                        ],
                        "half": [round(p.half_length, 2), round(p.half_width, 2)],
                        "eave": round(p.eave, 2),
                        "ridge": round(p.ridge, 2),
                        "hips": list(p.hips),
                    }
                    for p in b.parts
                ],
            }
        )
    (out_dir / "buildings.json").write_text(json.dumps(records), encoding="utf-8")


def _write_features(out_dir: Path, features: Features, extent: Extent) -> None:
    """Write features in scene coordinates; the viewer puts points on the ground."""
    ox = extent.x0 + HEIGHT_STEP_M / 2
    oz = extent.y1 - HEIGHT_STEP_M / 2
    kinds = sorted({p.kind for p in features.points})
    index = {k: i for i, k in enumerate(kinds)}
    data = {
        "kinds": kinds,
        "points": [
            [
                index[p.kind],
                round(p.x - ox, 2),
                round(oz - p.y, 2),
                round(p.size, 2),
                round(p.angle, 3),
            ]
            for p in features.points
        ],
        "lines": [
            {
                "kind": line.kind,
                "size": line.size,
                "points": [
                    [round(x - ox, 2), round(oz - y, 2)] for x, y in line.coords
                ],
                # Exact pole positions of power lines, where known.
                "poles": [[round(x - ox, 2), round(oz - y, 2)] for x, y in line.poles],
            }
            for line in features.lines
        ],
        "cliffs": [
            {
                "kind": face.kind,
                "top": [
                    [round(x - ox, 2), round(h, 2), round(oz - y, 2)]
                    for x, y, h in face.top
                ],
                "bottom": [
                    [round(x - ox, 2), round(h, 2), round(oz - y, 2)]
                    for x, y, h in face.bottom
                ],
            }
            for face in features.cliffs
        ],
    }
    (out_dir / "features.json").write_text(json.dumps(data), encoding="utf-8")


def _write_tracks(out_dir: Path, tracks: Sequence[Track], extent: Extent) -> None:
    ox = extent.x0 + HEIGHT_STEP_M / 2
    oz = extent.y1 - HEIGHT_STEP_M / 2
    data = [
        {
            "kind": t.kind,
            "width": t.width,
            "points": [[round(x - ox, 2), round(oz - y, 2)] for x, y in t.coords],
        }
        for t in tracks
    ]
    (out_dir / "tracks.json").write_text(json.dumps(data), encoding="utf-8")


def _write_drape(
    out_dir: Path, drape_png: Path, px_per_m: float, chunks: tuple[int, int]
) -> int:
    """Cut the drape image into one texture per height chunk; return the tile size in px."""
    folder = out_dir / "drape"
    folder.mkdir(parents=True, exist_ok=True)
    tile_px = round(CHUNK * HEIGHT_STEP_M * px_per_m)
    # The first height sample is half a cell in from the image's west and north edges.
    start = HEIGHT_STEP_M / 2 * px_per_m
    with Image.open(drape_png) as img:
        rgb = img.convert("RGB")
        for cy in range(chunks[1]):
            for cx in range(chunks[0]):
                left = round(start + cx * tile_px)
                top = round(start + cy * tile_px)
                tile = Image.new("RGB", (tile_px, tile_px), "white")
                tile.paste(rgb.crop((left, top, left + tile_px, top + tile_px)), (0, 0))
                tile.save(folder / f"{cx}_{cy}.jpg", quality=JPEG_QUALITY)
        factor = max(rgb.size) / OVERVIEW_MAX_PX
        if factor > 1:
            size = (round(rgb.width / factor), round(rgb.height / factor))
            rgb = rgb.resize(size, Image.Resampling.LANCZOS)
        rgb.save(out_dir / "drape_overview.jpg", quality=JPEG_QUALITY)
    return tile_px


def _write_map_image(out_dir: Path, map_png: Path) -> tuple[int, int]:
    with Image.open(map_png) as img:
        rgb = img.convert("RGB")
        rgb.save(out_dir / "map.jpg", quality=92)
        return rgb.size


def write_world(out_dir: Path, world: WorldData) -> Path:
    """Write a world package to ``out_dir`` and return the manifest path."""
    dtm = world.dtm
    if dtm.shape != world.extent.raster_shape(HEIGHT_STEP_M):
        msg = f"DTM shape {dtm.shape} does not match extent {world.extent}"
        raise ValueError(msg)
    if np.isnan(dtm).any():
        msg = "The DTM still has missing values"
        raise ValueError(msg)
    out_dir.mkdir(parents=True, exist_ok=True)

    low, high = float(dtm.min()), float(dtm.max())
    encoding = HeightEncoding.for_range(low, high)
    coarse = coarse_chunks(world.extent, dtm.shape, world.map_area)
    chunks = _write_heights(out_dir, dtm, encoding, set(coarse))
    tile_px = _write_drape(out_dir, world.drape_png, world.drape_px_per_m, chunks)
    map_size = _write_map_image(out_dir, world.map_png)

    vectors = out_dir / "vectors"
    vectors.mkdir(exist_ok=True)
    with (vectors / "omap.geojson").open("w", encoding="utf-8") as f:
        features = list(world.omap_features)
        json.dump({"type": "FeatureCollection", "features": features}, f)

    rows, cols = dtm.shape
    extent = world.extent
    manifest: dict[str, Any] = {
        "format": FORMAT_VERSION,
        "name": world.name,
        "crs": f"EPSG:{world.epsg}",
        "extent": list(extent.as_tuple()),
        "height": {
            "origin": [extent.x0 + HEIGHT_STEP_M / 2, extent.y1 - HEIGHT_STEP_M / 2],
            "step": HEIGHT_STEP_M,
            "cols": cols,
            "rows": rows,
            "chunk": CHUNK,
            "chunksX": chunks[0],
            "chunksY": chunks[1],
            "encoding": "uint16le",
            "offset": encoding.offset,
            "scale": encoding.scale,
            "min": low,
            "max": high,
            "path": "height/{x}_{y}.bin",
            "coarse": {"step": COARSE_STEP, "chunks": coarse},
        },
        "drape": {
            "path": "drape/{x}_{y}.jpg",
            "tilePx": tile_px,
            "overview": "drape_overview.jpg",
        },
        "map": {
            "image": "map.jpg",
            "size": list(map_size),
            "scale": world.map_scale,
            "offset": list(world.map_offset),
        },
        "mapArea": [list(p) for p in world.map_area.exterior.simplify(5).coords],
        "spawn": list(world.spawn),
        "attribution": list(world.attribution),
    }

    if world.layers is not None:
        canopy = world.canopy if world.canopy is not None else np.zeros_like(dtm)
        _write_layers(out_dir, encode_layers(world.layers, canopy), chunks)
        manifest["layers"] = {
            "path": "layers/{x}_{y}.png",
            "size": CHUNK + 1,
            "overview": "layers_overview.png",
            "overviewStep": LAYER_OVERVIEW_STEP,
            "canopyUnit": CANOPY_UNIT_M,
            "levels": LEVELS,
            "ground": {g.name.lower(): int(g) for g in Ground},
            # Where undergrowth comes from: the map only, or also the laser point cloud.
            "undergrowth": "lidar" if world.lidar else "map",
        }
    if world.trees is not None:
        counts = _write_trees(out_dir, world.trees, chunks)
        manifest["trees"] = {
            "path": "trees/{x}_{y}.bin",
            "counts": counts,
            "total": len(world.trees),
            "posScale": TREE_POS_SCALE,
            "heightScale": TREE_HEIGHT_SCALE,
            "crownScale": TREE_CROWN_SCALE,
            "recordBytes": TREE_DTYPE.itemsize,
            "species": SPECIES_NAMES,
            "standGrownFlag": STAND_GROWN_FLAG,
            "crownBaseShift": CROWN_BASE_SHIFT,
        }

    if world.buildings is not None:
        _write_buildings(out_dir, world.buildings, extent)
        manifest["buildings"] = {
            "path": "buildings.json",
            "count": len(world.buildings),
        }
    if world.tracks is not None:
        _write_tracks(out_dir, world.tracks, extent)
        manifest["tracks"] = {"path": "tracks.json", "count": len(world.tracks)}
    if world.features is not None:
        _write_features(out_dir, world.features, extent)
        manifest["features"] = {
            "path": "features.json",
            "points": len(world.features.points),
            "lines": len(world.features.lines),
            "cliffs": len(world.features.cliffs),
        }

    path = out_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path
