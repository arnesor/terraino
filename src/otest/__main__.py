"""Command-line interface."""

import logging
from pathlib import Path

import click

from otest.build import BuildOptions, build_world

SR16_DIR_ENV = "OTEST_SR16_DIR"


@click.group()
@click.version_option()
@click.option("-v", "--verbose", is_flag=True, help="Show debug messages.")
def main(verbose: bool) -> None:
    """Build walkable 3D worlds from Norwegian orienteering maps."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


@main.command()
@click.argument(
    "map_path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--out",
    "out_dir",
    type=click.Path(file_okay=False, path_type=Path),
    help="World folder to write. Default: worlds/<map name>.",
)
@click.option(
    "--margin", default=300.0, show_default=True, help="Metres around the map."
)
@click.option(
    "--offset",
    nargs=2,
    type=float,
    default=(0.0, 0.0),
    show_default=True,
    help="Shift the map DX DY metres east/north to fix georeferencing errors.",
)
@click.option(
    "--cache-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("data-cache"),
    show_default=True,
    help="Folder for downloaded data.",
)
@click.option(
    "--sr16-dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    envvar=SR16_DIR_ENV,
    help=f"Folder with SR16 GeoTIFFs, used instead of the download. Env: {SR16_DIR_ENV}.",
)
@click.option(
    "--symbols",
    "symbol_set",
    type=click.Choice(["isom2000", "isom2017"]),
    help="Symbol standard of an OCAD map. Default: guessed from the map.",
)
@click.option(
    "--epsg",
    type=int,
    help="Coordinate system of an image map's world file, e.g. 25832 or 25833.",
)
@click.option(
    "--no-forest",
    is_flag=True,
    help="Build terrain only, without ground layers, buildings and trees.",
)
def build(
    map_path: Path,
    out_dir: Path | None,
    margin: float,
    offset: tuple[float, float],
    cache_dir: Path,
    sr16_dir: Path | None,
    symbol_set: str | None,
    epsg: int | None,
    no_forest: bool,
) -> None:
    """Build a 3D world from MAP_PATH.

    MAP_PATH is an OCAD map (.ocd), or an image map: a KMZ overlay, a GeoTIFF, or a
    JPG/PNG with a world file (.jgw/.pgw, together with --epsg).
    """
    out = out_dir or Path("worlds") / map_path.stem
    options = BuildOptions(
        margin=margin,
        offset=offset,
        cache_dir=cache_dir,
        sr16_dir=sr16_dir,
        symbol_set=symbol_set,
        epsg=epsg,
        forest=not no_forest,
    )
    manifest = build_world(map_path, out, options)
    click.echo(f"World written to {manifest.parent}")


if __name__ == "__main__":
    main(prog_name="otest")  # pragma: no cover
