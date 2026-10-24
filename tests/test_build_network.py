"""Build of the fixture world from the live services: run with ``pytest -m network``."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from terraino.build import build_world
from tests.fixture_world import options
from tests.test_lidar import LIDAR_425, ground_returns
from tests.test_ocad import MAP_BOUNDS, TEST_MAP, needs_exporter

pytestmark = [pytest.mark.network, needs_exporter]


def height_at(
    world: Path, manifest: dict[str, Any], east: float, north: float
) -> float:
    h = manifest["height"]
    col = round((east - h["origin"][0]) / h["step"])
    row = round((h["origin"][1] - north) / h["step"])
    cx, cy = col // h["chunk"], row // h["chunk"]
    raw = np.fromfile(world / "height" / f"{cx}_{cy}.bin", dtype="<u2")
    chunk = raw.reshape(h["chunk"] + 1, h["chunk"] + 1)
    value = chunk[row - cy * h["chunk"], col - cx * h["chunk"]]
    return float(h["offset"] + value * h["scale"])


def test_build_langvatnet(tmp_path: Path) -> None:
    out = tmp_path / "langvatnet"
    manifest_path = build_world(TEST_MAP, out, options(tmp_path / "cache"))
    manifest = json.loads(manifest_path.read_text())
    assert manifest["crs"] == "EPSG:25832"
    x0, y0, x1, y1 = manifest["extent"]
    assert x0 < MAP_BOUNDS.x0 < MAP_BOUNDS.x1 < x1
    assert y0 < MAP_BOUNDS.y0 < MAP_BOUNDS.y1 < y1
    assert any("laser point cloud" in a for a in manifest["attribution"])
    assert manifest["trees"]["total"] > 1000

    # Kartverket's terrain model agrees with the fixture's ground returns.
    x, y, z = ground_returns(LIDAR_425)
    rng = np.random.default_rng(0)
    errors = []
    for east, north in zip(
        rng.uniform(MAP_BOUNDS.x0, MAP_BOUNDS.x1, 200),
        rng.uniform(MAP_BOUNDS.y0, MAP_BOUNDS.y1, 200),
        strict=True,
    ):
        near = (abs(x - east) < 0.5) & (abs(y - north) < 0.5)
        if near.any():
            errors.append(height_at(out, manifest, east, north) - z[near].mean())
    assert len(errors) > 100
    assert np.median(np.abs(errors)) < 0.3
