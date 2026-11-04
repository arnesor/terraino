"""Read OCAD maps through the ``tools/ocad-export`` Node program.

The OCAD format is parsed by ocad2geojson, an AGPL-3.0 JavaScript library. It runs as a
separate program so this package does not link it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from terraino.ingest.georef import Extent, etrs89_utm_epsg

EXPORTER_ENV = "TERRAINO_OCAD_EXPORT"

# Symbol type codes used by OCAD.
POINT_SYMBOL = 1
LINE_SYMBOL = 2
AREA_SYMBOL = 3
TEXT_SYMBOL = 4

# ISOM symbols numbered from 600 up are map furniture: north lines, frames, texts, legend.
FIRST_NON_TERRAIN_SYMBOL = 600


class OcadExportError(RuntimeError):
    """The OCAD exporter is missing or failed."""


@dataclass(frozen=True)
class SymbolInfo:
    """A symbol used in the map.

    Attributes:
        number: Symbol number as written in OCAD, for example ``"406.0"``.
        type: OCAD symbol type (1 point, 2 line, 3 area, 4 text, ...).
        description: Symbol name from the map file.
        objects: Number of objects using the symbol.
    """

    number: str
    type: int
    description: str
    objects: int

    @property
    def is_terrain(self) -> bool:
        """True for symbols describing the terrain (ISOM 1xx-5xx, not text).

        Examples:
            >>> SymbolInfo("406.0", 3, "Forest: slow running", 1).is_terrain
            True
            >>> SymbolInfo("601.0", 2, "Magnetic north line", 1).is_terrain
            False
        """
        return (
            self.type != TEXT_SYMBOL and float(self.number) < FIRST_NON_TERRAIN_SYMBOL
        )


@dataclass(frozen=True)
class OcadExport:
    """Files written by the OCAD exporter, and the metadata describing them.

    Attributes:
        directory: Folder holding ``meta.json``, ``objects.geojson``, ``map.svg`` and PNGs.
        epsg: ETRS89 / UTM EPSG code of the map.
        scale: Map scale denominator, for example 10000.
        map_bounds: Bounding box of the terrain objects.
        extent: Extent of the rendered map images.
        symbols: Symbols used in the map, keyed by symbol number.
        meta: The raw ``meta.json`` content.
    """

    directory: Path
    epsg: int
    scale: float
    map_bounds: Extent
    extent: Extent
    symbols: dict[str, SymbolInfo]
    meta: dict[str, Any] = field(repr=False)

    @property
    def objects_path(self) -> Path:
        """GeoJSON with all visible map objects in projected coordinates."""
        return self.directory / "objects.geojson"

    @property
    def map_png(self) -> Path:
        """The complete map rendered to the extent."""
        return self.directory / "map.png"

    @property
    def drape_png(self) -> Path:
        """Terrain symbols only, rendered to the extent (ground texture)."""
        return self.directory / "drape.png"

    def load_objects(self) -> list[dict[str, Any]]:
        """Return the GeoJSON features of all visible map objects."""
        with self.objects_path.open(encoding="utf-8") as f:
            features: list[dict[str, Any]] = json.load(f)["features"]
        return features

    @classmethod
    def from_directory(cls, directory: Path) -> OcadExport:
        """Read the exporter's ``meta.json`` in ``directory``."""
        with (directory / "meta.json").open(encoding="utf-8") as f:
            meta = json.load(f)
        crs = meta["crs"]
        if crs.get("catalog") != "EPSG" or not crs.get("code"):
            msg = (
                f"The map has no known coordinate system (OCAD grid id {crs.get('gridId')}). "
                "Georeference it in OCAD (Map > Set Scale and Coordinate System) first."
            )
            raise OcadExportError(msg)
        symbols = {s["number"]: SymbolInfo(**s) for s in meta["symbols"]}
        return cls(
            directory=directory,
            epsg=etrs89_utm_epsg(int(crs["code"])),
            scale=float(meta["scale"]),
            map_bounds=Extent(*meta["mapBounds"]),
            extent=Extent(*meta["extent"]),
            symbols=symbols,
            meta=meta,
        )


def find_exporter() -> Path:
    """Return the path of ``export.mjs``, checking that its dependencies are installed.

    The location can be overridden with the ``TERRAINO_OCAD_EXPORT`` environment variable.
    """
    override = os.environ.get(EXPORTER_ENV)
    if override:
        script = Path(override)
    else:
        script = (
            Path(__file__).resolve().parents[3] / "tools" / "ocad-export" / "export.mjs"
        )
    if not script.is_file():
        msg = f"OCAD exporter not found at {script}. Set {EXPORTER_ENV} to its export.mjs."
        raise OcadExportError(msg)
    if not (script.parent / "node_modules" / "ocad2geojson").is_dir():
        msg = f"Install the OCAD exporter's dependencies first: cd {script.parent} && npm ci"
        raise OcadExportError(msg)
    return script


def export_ocad(
    map_path: Path,
    out_dir: Path,
    *,
    extent: Extent | None = None,
    margin: float = 300,
    offset: tuple[float, float] = (0.0, 0.0),
    keep_ids: list[int] | None = None,
    map_px_per_m: float = 1,
    drape_px_per_m: float = 2,
    render_png: bool = True,
) -> OcadExport:
    """Export an OCAD map to GeoJSON, SVG and PNG files.

    Args:
        map_path: The ``.ocd`` file.
        out_dir: Folder for the exported files. It is created if needed.
        extent: World extent to render. Defaults to the map bounds plus ``margin``.
        margin: Margin in metres around the map bounds, used when ``extent`` is None.
        offset: Shift ``(dx, dy)`` in metres applied to the map's georeference.
        keep_ids: Object ids (``oid`` in the GeoJSON) to draw in ``drape.png``.
        map_px_per_m: Resolution of ``map.png``.
        drape_px_per_m: Resolution of ``drape.png``.
        render_png: Set False to skip the PNG files.

    Returns:
        Description of the exported files.

    Raises:
        OcadExportError: If Node or the exporter is missing, or the export fails.
    """
    node = shutil.which("node")
    if node is None:
        msg = (
            "Node.js is required to read OCAD files, but 'node' was not found on PATH."
        )
        raise OcadExportError(msg)
    script = find_exporter()
    out_dir.mkdir(parents=True, exist_ok=True)

    args = [
        node,
        str(script),
        str(map_path),
        str(out_dir),
        "--margin",
        str(margin),
        "--offset",
        f"{offset[0]},{offset[1]}",
        "--map-px-per-m",
        str(map_px_per_m),
        "--drape-px-per-m",
        str(drape_px_per_m),
    ]
    if extent is not None:
        args += ["--extent", ",".join(str(v) for v in extent.as_tuple())]
    if keep_ids is not None:
        keep_path = out_dir / "keep.json"
        keep_path.write_text(json.dumps(keep_ids), encoding="utf-8")
        args += ["--keep", str(keep_path)]
    if not render_png:
        args.append("--no-png")

    result = subprocess.run(  # noqa: S603 - fixed program and no shell
        args, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        msg = f"OCAD export of {map_path} failed:\n{result.stderr.strip()}"
        raise OcadExportError(msg)
    return OcadExport.from_directory(out_dir)
