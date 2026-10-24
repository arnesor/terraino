import json
import shutil
from pathlib import Path

import pytest

from terraino.ingest import ocad
from terraino.ingest.georef import Extent
from tests import FIXTURES

TEST_MAP = FIXTURES / "ocad" / "LangvatnetUtsnitt.ocd"
# The mapped area of TEST_MAP.
MAP_BOUNDS = Extent(666537.6, 6646245.6, 666905.3, 6646523.5)


def write_meta(directory: Path, code: int = 32632) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    meta = {
        "scale": 10000,
        "crs": {"catalog": "EPSG", "code": code, "gridId": 2032},
        "mapBounds": [662948.9, 6643781, 667740.1, 6648377.6],
        "extent": [662640, 6643472, 668048, 6648688],
        "drapePxPerM": 2,
        "symbols": [
            {"number": "406.0", "type": 3, "description": "Forest", "objects": 731},
            {"number": "900.5", "type": 4, "description": "Text", "objects": 4},
        ],
    }
    (directory / "meta.json").write_text(json.dumps(meta))


def test_from_directory_reads_meta(tmp_path: Path) -> None:
    write_meta(tmp_path)
    export = ocad.OcadExport.from_directory(tmp_path)
    assert export.epsg == 25832
    assert export.scale == 10000
    assert export.extent == Extent(662640, 6643472, 668048, 6648688)
    assert export.symbols["406.0"].is_terrain
    assert not export.symbols["900.5"].is_terrain


def test_map_without_crs_is_rejected(tmp_path: Path) -> None:
    write_meta(tmp_path, code=0)
    with pytest.raises(ocad.OcadExportError, match="Georeference"):
        ocad.OcadExport.from_directory(tmp_path)


def test_missing_exporter_is_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(ocad.EXPORTER_ENV, str(tmp_path / "nope.mjs"))
    with pytest.raises(ocad.OcadExportError, match="not found"):
        ocad.find_exporter()


def test_exporter_without_node_modules_is_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = tmp_path / "export.mjs"
    script.write_text("")
    monkeypatch.setenv(ocad.EXPORTER_ENV, str(script))
    with pytest.raises(ocad.OcadExportError, match="npm ci"):
        ocad.find_exporter()


def test_missing_node_is_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("terraino.ingest.ocad.shutil.which", lambda name: None)
    with pytest.raises(ocad.OcadExportError, match=r"Node\.js"):
        ocad.export_ocad(tmp_path / "map.ocd", tmp_path / "out")


def exporter_available() -> bool:
    try:
        ocad.find_exporter()
    except ocad.OcadExportError:
        return False
    return shutil.which("node") is not None


needs_exporter = pytest.mark.skipif(
    not exporter_available(),
    reason="needs the installed OCAD exporter (npm ci --prefix tools/ocad-export)",
)


@needs_exporter
def test_export_langvatnet(tmp_path: Path) -> None:
    export = ocad.export_ocad(TEST_MAP, tmp_path, render_png=False)
    assert export.epsg == 25832
    assert export.scale == 10000
    b = export.map_bounds
    assert b.as_tuple() == pytest.approx(MAP_BOUNDS.as_tuple())
    features = export.load_objects()
    assert len(features) == 149
    syms = {f["properties"]["sym"] for f in features}
    assert {"303.0", "403.0", "406.0", "526.0"} <= syms
    assert [f["properties"]["oid"] for f in features[:3]] == [0, 1, 2]


@needs_exporter
def test_export_offset_shifts_map(tmp_path: Path) -> None:
    plain = ocad.export_ocad(TEST_MAP, tmp_path / "a", render_png=False)
    shifted = ocad.export_ocad(
        TEST_MAP, tmp_path / "b", offset=(10.0, -5.0), render_png=False
    )
    assert shifted.map_bounds.x0 == pytest.approx(plain.map_bounds.x0 + 10)
    assert shifted.map_bounds.y0 == pytest.approx(plain.map_bounds.y0 - 5)
