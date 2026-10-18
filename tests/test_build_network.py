"""End-to-end build of the test map. Downloads data: run with ``pytest -m network``."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from terraino.build import BuildOptions, build_world
from tests.test_ocad import TEST_MAP, needs_test_map

pytestmark = [pytest.mark.network, needs_test_map]

# Langvatnet's water level as printed on the map ("Langvatnet 152 m.o.h.").
LANGVATNET_LEVEL_M = 152
# A point in the middle of Langvatnet (EPSG:25832).
LANGVATNET_POINT = (665560.0, 6645900.0)


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
    manifest_path = build_world(
        TEST_MAP, out, BuildOptions(cache_dir=tmp_path / "cache")
    )
    manifest = json.loads(manifest_path.read_text())
    assert manifest["crs"] == "EPSG:25832"
    x0, y0, x1, y1 = manifest["extent"]
    assert x0 < 663_700 < 667_700 < x1
    assert y0 < 6_643_800 < 6_648_300 < y1
    lake = height_at(out, manifest, *LANGVATNET_POINT)
    assert lake == pytest.approx(LANGVATNET_LEVEL_M, abs=1.0)
