import json
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest
from PIL import Image
from shapely import Polygon

from terraino.export import (
    CHUNK,
    COARSE_STEP,
    TREE_DTYPE,
    HeightEncoding,
    WorldData,
    coarse_chunks,
    write_world,
)
from terraino.ingest.georef import Extent
from terraino.process.layers import GroundLayers
from terraino.process.trees import Trees


def test_height_encoding_round_trip() -> None:
    heights = np.array([152.2, 200.0, 331.94], dtype=np.float32)
    enc = HeightEncoding.for_range(float(heights.min()), float(heights.max()))
    decoded = enc.offset + enc.encode(heights) * enc.scale
    np.testing.assert_allclose(decoded, heights, atol=enc.scale / 2 + 1e-4)


def test_height_encoding_coarsens_for_large_ranges() -> None:
    enc = HeightEncoding.for_range(0, 2000)
    assert enc.scale == pytest.approx(0.04)
    assert (2000 - enc.offset) / enc.scale <= 65535


World = tuple[Path, dict[str, Any], npt.NDArray[np.float32]]


@pytest.fixture
def world(tmp_path: Path) -> World:
    # 300 x 520 m: two chunks wide (east-west), three chunks tall.
    extent = Extent(1000, 5000, 1300, 5520)
    rows, cols = extent.raster_shape(1)
    yy, xx = np.mgrid[0:rows, 0:cols]
    dtm = (100 + xx * 0.1 + yy * 0.01).astype(np.float32)
    drape = tmp_path / "drape.png"
    Image.new("RGB", (cols * 2, rows * 2), "green").save(drape)
    map_png = tmp_path / "map.png"
    Image.new("RGB", (cols, rows), "white").save(map_png)
    out = tmp_path / "world"
    zeros = np.zeros(dtm.shape, dtype=np.float32)
    layers = GroundLayers(
        ground=np.full(dtm.shape, 1, dtype=np.uint8),
        speed=zeros + 1,
        young=zeros,
        thicket=zeros,
        shrubs=zeros,
        tree_rule=np.zeros(dtm.shape, dtype=np.uint8),
        clear=zeros > 0,
        in_map=zeros == 0,
    )
    # Two trees: one in chunk (0, 0), one in chunk (1, 2).
    trees = Trees(
        col=np.array([10.5, 300.5], dtype=np.float32),
        row=np.array([20.5, 515.5], dtype=np.float32),
        height=np.array([12.0, 20.0], dtype=np.float32),
        crown=np.array([1.5, 2.5], dtype=np.float32),
        species=np.array([1, 3], dtype=np.uint8),
        crown_base=np.array([0.5, np.nan], dtype=np.float32),
    )
    data = WorldData(
        name="test",
        epsg=25832,
        extent=extent,
        dtm=dtm,
        drape_png=drape,
        drape_px_per_m=2,
        map_png=map_png,
        map_scale=10000,
        map_area=Polygon([(1050, 5050), (1250, 5050), (1250, 5450), (1050, 5050)]),
        omap_features=[{"type": "Feature", "geometry": None, "properties": {}}],
        spawn=(1150.0, 5200.0),
        attribution=["test data"],
        layers=layers,
        canopy=zeros + 8,
        trees=trees,
    )
    manifest_path = write_world(out, data)
    return out, json.loads(manifest_path.read_text()), dtm


def read_chunk(
    out: Path, manifest: dict[str, Any], cx: int, cy: int
) -> npt.NDArray[np.float64]:
    h = manifest["height"]
    raw = np.fromfile(out / "height" / f"{cx}_{cy}.bin", dtype="<u2")
    heights: npt.NDArray[np.float64] = h["offset"] + raw * h["scale"]
    return heights.reshape(CHUNK + 1, CHUNK + 1)


def test_manifest_describes_grid(world: World) -> None:
    _, manifest, dtm = world
    h = manifest["height"]
    assert manifest["crs"] == "EPSG:25832"
    assert h["origin"] == [1000.5, 5519.5]
    assert h["rows"] == dtm.shape[0]
    assert h["cols"] == dtm.shape[1]
    assert (h["chunksX"], h["chunksY"]) == (2, 3)
    assert manifest["drape"]["tilePx"] == 2 * CHUNK
    assert manifest["map"]["offset"] == [0.0, 0.0]


def test_chunks_hold_dtm_values_and_share_edges(world: World) -> None:
    out, manifest, dtm = world
    c00 = read_chunk(out, manifest, 0, 0)
    c10 = read_chunk(out, manifest, 1, 0)
    np.testing.assert_allclose(c00, dtm[: CHUNK + 1, : CHUNK + 1], atol=0.006)
    np.testing.assert_allclose(c00[:, -1], c10[:, 0], atol=1e-6)


def test_chunks_beyond_grid_repeat_edge(world: World) -> None:
    out, manifest, dtm = world
    c12 = read_chunk(out, manifest, 1, 2)
    np.testing.assert_allclose(c12[-1, -1], dtm[-1, -1], atol=0.006)


def test_textures_written(world: World) -> None:
    out, manifest, _ = world
    tile = Image.open(out / "drape" / "1_2.jpg")
    assert tile.size == (manifest["drape"]["tilePx"],) * 2
    assert (out / "drape_overview.jpg").is_file()
    assert Image.open(out / "map.jpg").size == tuple(manifest["map"]["size"])
    assert (out / "vectors" / "omap.geojson").is_file()


def test_layers_written(world: World) -> None:
    out, manifest, _ = world
    assert manifest["layers"]["size"] == CHUNK + 1
    tile = np.asarray(Image.open(out / "layers" / "1_2.png"))
    assert tile.shape == (CHUNK + 1, CHUNK + 1, 3)
    assert (tile[..., 0] == 1).all()  # forest, no undergrowth
    assert (tile[..., 1] == 32).all()  # 8 m canopy in 0.25 m units
    assert (tile[..., 2] == 100).all()  # easy forest, speed 1
    assert (out / "layers_overview.png").is_file()


def test_trees_written_per_chunk(world: World) -> None:
    out, manifest, _ = world
    info = manifest["trees"]
    assert info["total"] == 2
    assert sum(info["counts"]) == 2
    first = np.fromfile(out / "trees" / "0_0.bin", dtype=TREE_DTYPE)
    assert len(first) == 1
    # Cell (col 10, row 20) centre is 10 m east, 20 m south of the first sample.
    assert first["x"][0] / info["posScale"] == pytest.approx(10.0)
    assert first["z"][0] / info["posScale"] == pytest.approx(20.0)
    assert first["height"][0] / info["heightScale"] == pytest.approx(12.0)
    # The first tree's crown begins half way up: crown base class 3 above the species.
    assert first["species"][0] == 1 | 3 << info["crownBaseShift"]
    last = np.fromfile(out / "trees" / "1_2.bin", dtype=TREE_DTYPE)
    assert last["species"].tolist() == [3]  # unknown crown base: class 0
    assert last["x"][0] / info["posScale"] == pytest.approx(300 - CHUNK)


def test_rejects_dtm_with_holes(tmp_path: Path) -> None:
    extent = Extent(0, 0, 10, 10)
    dtm = np.full((10, 10), np.nan, dtype=np.float32)
    data = WorldData(
        name="x",
        epsg=25832,
        extent=extent,
        dtm=dtm,
        drape_png=tmp_path / "none.png",
        drape_px_per_m=1,
        map_png=tmp_path / "none.png",
        map_scale=10000,
        map_area=Polygon([(0, 0), (1, 0), (1, 1)]),
        omap_features=[],
        spawn=(0, 0),
        attribution=[],
    )
    with pytest.raises(ValueError, match="missing"):
        write_world(tmp_path, data)


def test_chunks_away_from_the_map_are_coarse() -> None:
    # Four chunks by four (1024 m); the map is a small square in the north-west chunk.
    extent = Extent(0, 0, 1024, 1024)
    map_area = Polygon([(20, 900), (120, 900), (120, 1000), (20, 1000)])
    coarse = coarse_chunks(extent, extent.raster_shape(1), map_area)
    # Within 100 m of the map: chunk (0, 0) only; every other chunk is coarse.
    assert coarse == [i for i in range(16) if i != 0]
    # A map reaching into the next chunk to the east keeps that one detailed too.
    wide = Polygon([(20, 900), (300, 900), (300, 1000), (20, 1000)])
    assert 1 not in coarse_chunks(extent, extent.raster_shape(1), wide)


def test_coarse_chunks_hold_every_fourth_sample(tmp_path: Path) -> None:
    # Two chunks by one; the map lies in the west chunk, so the east one is coarse.
    extent = Extent(0, 0, 512, 256)
    rows, cols = extent.raster_shape(1)
    yy, xx = np.mgrid[0:rows, 0:cols]
    dtm = (100 + xx * 0.1 + yy * 0.05).astype(np.float32)
    drape = tmp_path / "drape.png"
    Image.new("RGB", (cols * 2, rows * 2), "green").save(drape)
    map_png = tmp_path / "map.png"
    Image.new("RGB", (cols, rows), "white").save(map_png)
    data = WorldData(
        name="coarse",
        epsg=25832,
        extent=extent,
        dtm=dtm,
        drape_png=drape,
        drape_px_per_m=2,
        map_png=map_png,
        map_scale=10000,
        map_area=Polygon([(20, 20), (100, 20), (100, 200), (20, 200)]),
        omap_features=[],
        spawn=(50.0, 100.0),
        attribution=["test data"],
        spawn_heading=135.0,
    )
    out = tmp_path / "world"
    manifest = json.loads(write_world(out, data).read_text())
    h = manifest["height"]
    assert manifest["format"] == 7
    assert manifest["spawn"] == [50.0, 100.0]
    assert manifest["spawnHeading"] == 135.0
    assert h["coarse"] == {"step": COARSE_STEP, "chunks": [1]}
    raw = np.fromfile(out / "height" / "1_0.bin", dtype="<u2")
    n = CHUNK // COARSE_STEP + 1
    assert raw.size == n * n
    heights = (h["offset"] + raw * h["scale"]).reshape(n, n)
    full = read_chunk(out, manifest, 0, 0)
    # Every fourth sample of the east chunk, sharing its west edge with the detailed chunk.
    rows_ = np.clip(np.arange(0, CHUNK + 1, COARSE_STEP), 0, rows - 1)
    cols_ = np.clip(np.arange(CHUNK, 2 * CHUNK + 1, COARSE_STEP), 0, cols - 1)
    np.testing.assert_allclose(heights, dtm[np.ix_(rows_, cols_)], atol=0.006)
    np.testing.assert_allclose(heights[:, 0], full[::COARSE_STEP, -1], atol=1e-6)
