"""Build of the fixture world from the fixtures alone, without network access."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image
from pyproj import Transformer
from shapely import LineString, unary_union

from terraino.fetch import nvdb
from terraino.ingest.georef import Extent
from terraino.process.symbols import Ground
from tests.fixture_world import (
    CACHE,
    MAPLESS_AREA,
    MAPLESS_NAME,
    NetworkUsedError,
    build_fixture_world,
    offline,
)
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


def assert_nvdb_drawn(world: Path, manifest: dict[str, Any]) -> None:
    """Every NVDB path and vehicle track in the world is drawn, where NVDB has it."""
    with offline():
        found = nvdb.fetch_paths(25832, Extent(*manifest["extent"]), CACHE)
    assert len(found) > 5
    ox, oz = manifest["height"]["origin"]
    tracks = json.loads((world / "tracks.json").read_text())
    for kind in ("path", "vehicle_track"):
        drawn = unary_union(
            [
                LineString([(ox + x, oz - z) for x, z in t["points"]])
                for t in tracks
                if t["kind"] == kind
            ]
        )
        for n in found:
            if n.kind == kind:
                assert drawn.buffer(0.5).covers(n.line)


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


def test_build_mapless_fixture_world(tmp_path: Path) -> None:
    out = tmp_path / "mapless"
    manifest = json.loads(build_fixture_world(out, mapless=True).read_text())
    assert manifest["name"] == MAPLESS_NAME
    # Chosen in UTM33, built in the zone it lies in, as the fixture map is.
    assert manifest["crs"] == "EPSG:25832"
    assert manifest["map"]["kind"] == "topographic"
    assert manifest["map"]["scale"] is None
    to_utm33 = Transformer.from_crs(25832, 25833, always_xy=True)
    corners = [to_utm33.transform(e, n) for e, n in manifest["coreArea"][:4]]
    for (east, north), expected in zip(
        sorted(corners),
        sorted(
            [
                (MAPLESS_AREA.x0, MAPLESS_AREA.y0),
                (MAPLESS_AREA.x0, MAPLESS_AREA.y1),
                (MAPLESS_AREA.x1, MAPLESS_AREA.y0),
                (MAPLESS_AREA.x1, MAPLESS_AREA.y1),
            ]
        ),
        strict=True,
    ):
        assert east == pytest.approx(expected[0], abs=0.5)
        assert north == pytest.approx(expected[1], abs=0.5)
    sources = " ".join(manifest["attribution"])
    assert "topographic map" in sources
    assert "Orienteering map" not in sources
    for source in ("Nasjonal høydemodell", "laser point cloud", "AR5", "SR16"):
        assert source in sources
    assert manifest["trees"]["total"] > 1000
    assert manifest["buildings"]["count"] > 10
    # Roads and paths come from NVDB and OpenStreetMap all over, as there is no map
    # to win.
    assert manifest["tracks"]["count"] > 0
    assert "Statens vegvesen" in sources
    assert_nvdb_drawn(out, manifest)
    assert "features" not in manifest
    # Every cell has a ground class from the open data.
    east, north = manifest["spawn"]
    assert ground_at(out, manifest, east, north) != Ground.UNKNOWN
    drape = np.asarray(Image.open(out / manifest["drape"]["overview"]))
    assert drape.std() > 10  # a map, not a blank


def test_missing_cache_file_stops_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = tmp_path / "cache"
    empty.mkdir()
    monkeypatch.setattr("tests.fixture_world.CACHE", empty)
    with pytest.raises(NetworkUsedError, match="not in"):
        build_fixture_world(tmp_path / "world")
