"""Build of the fixture world from the fixtures alone, without network access."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from terraino.process.symbols import Ground
from tests.fixture_world import NetworkUsedError, build_fixture_world
from tests.test_ocad import MAP_BOUNDS, needs_exporter

pytestmark = needs_exporter


def ground_at(world: Path, manifest: dict[str, Any], east: float, north: float) -> int:
    """Ground class of the layer sample nearest a projected point."""
    height = manifest["height"]
    col = round((east - height["origin"][0]) / height["step"])
    row = round((height["origin"][1] - north) / height["step"])
    n = height["chunk"]
    path = manifest["layers"]["path"].format(x=col // n, y=row // n)
    pixels = np.asarray(Image.open(world / path))
    return int(pixels[row % n, col % n, 0]) & 15


def test_build_fixture_world(tmp_path: Path) -> None:
    out = tmp_path / "world"
    manifest = json.loads(build_fixture_world(out).read_text())
    assert manifest["crs"] == "EPSG:25832"
    x0, y0, x1, y1 = manifest["extent"]
    assert x0 < MAP_BOUNDS.x0 < MAP_BOUNDS.x1 < x1
    assert y0 < MAP_BOUNDS.y0 < MAP_BOUNDS.y1 < y1
    # Every source was used, none skipped as unreachable.
    sources = " ".join(manifest["attribution"])
    for source in (
        "Nasjonal høydemodell",
        "laser point cloud",
        "AR5",
        "SR16",
        "OpenStreetMap",
        "Topografisk Norgeskart",
        "Matrikkelen",
    ):
        assert source in sources
    assert manifest["trees"]["total"] > 1000
    assert manifest["buildings"]["count"] > 50
    assert manifest["tracks"]["count"] > 10
    assert manifest["features"]["points"] > 10
    assert (out / "height" / "0_0.bin").is_file()
    # The name Rambøls-Ødegarden stands in a hole cut for it in a field: grain there too.
    assert ground_at(out, manifest, 666737, 6646439) == Ground.GRAIN


def test_missing_cache_file_stops_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = tmp_path / "cache"
    empty.mkdir()
    monkeypatch.setattr("tests.fixture_world.CACHE", empty)
    with pytest.raises(NetworkUsedError, match="not in"):
        build_fixture_world(tmp_path / "world")
