"""Command-line interface."""

import logging
from pathlib import Path

import click

from terraino.build import BuildOptions, build_world
from terraino.ingest.area import (
    AREA_EPSG,
    AreaError,
    check_area,
    describe_area,
    describe_hoydedata_box,
    hoydedata_box,
    reproject_area,
)
from terraino.ingest.georef import Extent
from terraino.picker import pick

SR16_DIR_ENV = "TERRAINO_SR16_DIR"
LIDAR_DIRS_ENV = "TERRAINO_LIDAR_DIRS"


@click.group()
@click.version_option()
@click.option("-v", "--verbose", is_flag=True, help="Show debug messages.")
def main(verbose: bool) -> None:
    """Build walkable 3D worlds from Norwegian orienteering maps, or without one."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


def _check_name(
    _ctx: click.Context, _param: click.Parameter, value: str | None
) -> str | None:
    """Accept a world name that can also be a folder name."""
    if value is None:
        return None
    name = value.strip()
    if not name or any(c in name for c in '/\\:*?"<>|') or name in {".", ".."}:
        msg = 'must be a non-empty folder name, without / \\ : * ? " < > |'
        raise click.BadParameter(msg)
    return name


def _check_area(
    _ctx: click.Context, _param: click.Parameter, value: tuple[float, ...] | None
) -> Extent | None:
    """Accept a rectangle that a mapless world can be built for."""
    if not value:
        return None
    xmin, ymin, xmax, ymax = value
    if xmin >= xmax or ymin >= ymax:
        msg = "give XMIN YMIN XMAX YMAX, with XMIN < XMAX and YMIN < YMAX"
        raise click.BadParameter(msg)
    area = Extent(xmin, ymin, xmax, ymax)
    try:
        check_area(area)
    except AreaError as exc:
        raise click.BadParameter(str(exc)) from None
    return area


# Options that belong to a map, refused for a mapless world.
_MAP_OPTIONS = ("owner", "offset", "symbol_set", "epsg")


def _check_source(
    ctx: click.Context, map_path: Path | None, area: Extent | None
) -> None:
    """Require a map or an area, not both; a mapless world needs a name."""
    if (map_path is None) == (area is None):
        msg = "Give either MAP_PATH or --area."
        raise click.UsageError(msg, ctx)
    if area is None:
        return
    if ctx.params["name"] is None:
        msg = "A mapless world (--area) needs --name."
        raise click.UsageError(msg, ctx)
    for option in _MAP_OPTIONS:
        if ctx.get_parameter_source(option) is not click.core.ParameterSource.DEFAULT:
            flag = next(p.opts[0] for p in ctx.command.params if p.name == option)
            msg = f"{flag} belongs to a map; a mapless world (--area) has none."
            raise click.UsageError(msg, ctx)


@main.command()
@click.argument(
    "map_path",
    required=False,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option(
    "--area",
    nargs=4,
    type=float,
    callback=_check_area,
    metavar="XMIN YMIN XMAX YMAX",
    help=(
        "Build a mapless world for this rectangle, in EUREF89 UTM33 metres as"
        " hoydedata.no uses (instead of MAP_PATH; needs --name). At most 25 km²."
        " Draw it with 'terraino pick-area'."
    ),
)
@click.option(
    "--out",
    "out_dir",
    type=click.Path(file_okay=False, path_type=Path),
    help="World folder to write. Default: worlds/<name>.",
)
@click.option(
    "--name",
    callback=_check_name,
    help=(
        "Name of the world: the viewer shows it, and it names the world folder unless"
        " --out is given. Default: the map's file name."
    ),
)
@click.option(
    "--owner",
    help=(
        'Who owns the orienteering map, e.g. "Eidskog OL": the viewer credits'
        " the map to them."
    ),
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
    "--lidar",
    "lidar_dirs",
    multiple=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    envvar=LIDAR_DIRS_ENV,
    help=(
        "Folder with a laser point cloud (LAZ tiles, e.g. from hoydedata.no). Repeat"
        " for several datasets, the preferred (densest) first; each place uses the first"
        f" dataset that covers it. Env: {LIDAR_DIRS_ENV} (separated by ':')."
    ),
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
    "--spawn",
    nargs=2,
    type=float,
    metavar="E N",
    help=(
        "Where the runner stands when the world opens: easting and northing in the"
        " map's coordinate system, as the viewer shows them. Default: a point inside"
        " the map."
    ),
)
@click.option(
    "--heading",
    type=click.FloatRange(0, 360, max_open=True),
    default=0.0,
    show_default=True,
    help="Where the runner looks when the world opens, in degrees clockwise from north.",
)
@click.option(
    "--no-forest",
    is_flag=True,
    help="Build terrain only, without ground layers, buildings and trees.",
)
@click.pass_context
def build(
    ctx: click.Context,
    map_path: Path | None,
    area: Extent | None,
    out_dir: Path | None,
    name: str | None,
    owner: str | None,
    margin: float,
    offset: tuple[float, float],
    cache_dir: Path,
    sr16_dir: Path | None,
    lidar_dirs: tuple[Path, ...],
    symbol_set: str | None,
    epsg: int | None,
    spawn: tuple[float, float] | None,
    heading: float,
    no_forest: bool,
) -> None:
    """Build a 3D world from MAP_PATH, or a mapless world for --area.

    MAP_PATH is an OCAD map (.ocd), or an image map: a KMZ overlay, a GeoTIFF, or a
    JPG/PNG with a world file (.jgw/.pgw, together with --epsg).
    """
    _check_source(ctx, map_path, area)
    # A mapless world has a --name: _check_source requires it.
    name = name or (map_path.stem if map_path is not None else "")
    out = out_dir or Path("worlds") / name
    options = BuildOptions(
        name=name,
        owner=owner.strip() if owner and owner.strip() else None,
        margin=margin,
        offset=offset,
        cache_dir=cache_dir,
        sr16_dir=sr16_dir,
        symbol_set=symbol_set,
        epsg=epsg,
        forest=not no_forest,
        lidar_dirs=tuple(lidar_dirs),
        spawn=spawn,
        heading=heading,
        area=area,
    )
    manifest = build_world(map_path, out, options)
    click.echo(f"World written to {manifest.parent}")


@main.command("pick-area")
@click.option(
    "--margin",
    default=300.0,
    show_default=True,
    help="Metres around the area, as for the build; the laser data box includes them.",
)
def pick_area(margin: float) -> None:
    """Draw the area of a mapless world on a map of Norway, in the browser.

    Prints the area, the box to export laser data for from hoydedata.no, and the
    command that builds the world.
    """
    area = pick(margin, click.echo)
    if area is None:
        click.echo("No area chosen.")
        return
    found = hoydedata_box(reproject_area(area, AREA_EPSG), AREA_EPSG, margin)
    click.echo(describe_area(area))
    click.echo(describe_hoydedata_box(found, margin))
    click.echo(
        f"terraino build --area {area.x0:.0f} {area.y0:.0f} {area.x1:.0f} {area.y1:.0f}"
        f" --margin {margin:g} --name <NAME> --lidar <LAZ folder>"
    )


if __name__ == "__main__":
    main(prog_name="terraino")  # pragma: no cover
