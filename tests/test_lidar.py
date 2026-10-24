from pathlib import Path

import laspy
import numpy as np
import pytest

from terraino.ingest.georef import Extent
from terraino.ingest.lidar import (
    FINE,
    LidarRasters,
    coarse_canopy,
    filled_canopy,
    load_lidar,
    summarize_points,
)

EXTENT = Extent(1000, 2000, 1040, 2040)
GROUND = 100.0


def flat_dtm() -> np.ndarray:
    return np.full(EXTENT.raster_shape(1), GROUND, dtype=np.float32)


def scene(rng: np.random.Generator, density: float) -> tuple[np.ndarray, ...]:
    """Ground everywhere, a 12 m tree at (1010.5, 2030.5) and a bush at (1030.5, 2010.5)."""
    n = int(40 * 40 * density)
    x = rng.uniform(EXTENT.x0, EXTENT.x1, n)
    y = rng.uniform(EXTENT.y0, EXTENT.y1, n)
    z = np.full(n, GROUND)
    cls = np.full(n, 2, dtype=np.uint8)
    # Tree: crown from 4 to 12 m, a cone 2 m wide at its base.
    k = int(200 * density)
    h = rng.uniform(4, 12, k)
    r = (12 - h) / 8 * 2 * np.sqrt(rng.uniform(0, 1, k))
    a = rng.uniform(0, 2 * np.pi, k)
    tree = (1010.5 + r * np.cos(a), 2030.5 + r * np.sin(a), GROUND + h)
    tree_top = (np.array([1010.5]), np.array([2030.5]), np.array([GROUND + 12]))
    # Bush: 1 m wide, 0.6-1.8 m high.
    m = int(30 * density)
    bush = (
        rng.uniform(1030, 1031, m),
        rng.uniform(2010, 2011, m),
        GROUND + rng.uniform(0.6, 1.8, m),
    )
    xs = np.concatenate([x, tree[0], tree_top[0], bush[0]])
    ys = np.concatenate([y, tree[1], tree_top[1], bush[1]])
    zs = np.concatenate([z, tree[2], tree_top[2], bush[2]])
    cl = np.concatenate([cls, np.ones(k + 1 + m, dtype=np.uint8)])
    return xs, ys, zs, cl


def cell(x: float, y: float) -> tuple[int, int]:
    return int(EXTENT.y1 - y), int(x - EXTENT.x0)


def test_summarize_points() -> None:
    x, y, z, cls = scene(np.random.default_rng(1), density=20)
    shape = EXTENT.raster_shape(1)
    t = summarize_points(x, y, z, cls, (0, shape[0], 0, shape[1]), EXTENT, flat_dtm())
    assert t.canopy.shape == (shape[0] * FINE, shape[1] * FINE)
    assert np.nanmax(t.canopy) == pytest.approx(12.0, abs=0.01)
    # The tree's crown begins at 4 m; the bush stops the laser in the low layer.
    assert t.crown_base[cell(1010.5, 2030.5)] == pytest.approx(4.0, abs=0.6)
    r, c = cell(1030.5, 2010.5)
    assert t.low_hit[r, c] / t.low_reach[r, c] > 0.3
    r, c = cell(1020.5, 2020.5)  # bare ground
    assert t.low_hit[r, c] == 0
    assert t.low_reach[r, c] > 0


def write_laz(
    path: Path, x: np.ndarray, y: np.ndarray, z: np.ndarray, cls: np.ndarray
) -> None:
    header = laspy.LasHeader(point_format=1, version="1.2")
    header.scales = np.array([0.01, 0.01, 0.01])
    header.offsets = np.array([EXTENT.x0, EXTENT.y0, 0.0])
    las = laspy.LasData(header)
    las.x, las.y, las.z = x, y, z
    las.classification = cls
    path.parent.mkdir(parents=True, exist_ok=True)
    las.write(path)


def test_load_lidar_prefers_the_first_dataset(tmp_path: Path) -> None:
    rng = np.random.default_rng(2)
    # Dense data for the west half only; sparse data, with the tree 2 m lower, for all.
    x, y, z, cls = scene(rng, density=20)
    west = x < 1020
    write_laz(tmp_path / "dense" / "a.laz", x[west], y[west], z[west], cls[west])
    x, y, z, cls = scene(rng, density=4)
    z = np.where(cls == 1, z - 2, z)
    write_laz(tmp_path / "sparse" / "b.laz", x, y, z, cls)

    lidar = load_lidar(
        [tmp_path / "dense", tmp_path / "sparse"],
        25832,
        EXTENT,
        flat_dtm(),
        tmp_path / "cache",
    )
    assert lidar is not None
    assert lidar.coverage.all()
    canopy = coarse_canopy(lidar.canopy)
    assert canopy[cell(1010.5, 2030.5)] == pytest.approx(12.0, abs=0.01)  # dense
    # East: only the sparse data, where the 1.8 m bush lies 2 m lower (at the ground).
    assert canopy[cell(1030.5, 2010.5)] < 0.5
    assert list((tmp_path / "cache" / "lidar").glob("*.npz"))

    # The second time the cached result is used.
    again = load_lidar(
        [tmp_path / "dense", tmp_path / "sparse"],
        25832,
        EXTENT,
        flat_dtm(),
        tmp_path / "cache",
    )
    assert again is not None
    np.testing.assert_allclose(
        np.nan_to_num(again.canopy), np.nan_to_num(lidar.canopy), atol=0.02
    )


def test_filled_canopy_has_no_gaps() -> None:
    shape = EXTENT.raster_shape(1)
    fine = np.full((shape[0] * FINE, shape[1] * FINE), np.nan, dtype=np.float32)
    fine[10, 10] = 5.0
    lidar = LidarRasters(
        canopy=fine,
        coverage=np.ones(shape, dtype=bool),
        low=np.zeros(shape, dtype=np.float32),
        mid=np.zeros(shape, dtype=np.float32),
        crown_base=np.zeros(shape, dtype=np.float32),
    )
    chm = np.full(shape, 1.5, dtype=np.float32)
    filled = filled_canopy(lidar, chm)
    assert not np.isnan(filled).any()
    assert filled[11, 11] == 5.0  # next to the return
    assert filled[50, 50] == 1.5  # far from it: the 1 m canopy height model
