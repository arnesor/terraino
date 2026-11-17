"""Building the fixture world from the fixtures alone, without network access.

``tests/fixtures/cache`` holds every file a build of the fixture map downloads, and
of the mapless fixture world over the same ground.
Build the world into OUT (the viewer tests do this) with::

    uv run python -m tests.fixture_world OUT

and the mapless world with ``--mapless OUT``.

Refresh the cache from the services after changing what or how the build downloads::

    uv run python -m tests.fixture_world --refresh-cache
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import numpy as np
import rasterio
from rasterio.windows import Window

from terraino.build import BuildOptions, build_world
from terraino.ingest.georef import Extent
from tests import FIXTURES
from tests.test_lidar import LIDAR_425
from tests.test_ocad import TEST_MAP

CACHE = FIXTURES / "cache"
# The mapless fixture world: a rectangle in UTM33 inside the fixture map, which is in
# zone 32, so the build turns it into the map's zone and the fixtures cover it.
MAPLESS_AREA = Extent(331180, 6646380, 331480, 6646590)
MAPLESS_NAME = "LangvatnetMapless"
# Folders of the build cache that hold results computed from the fixtures, not downloads.
COMPUTED = ("lidar",)


class NetworkUsedError(AssertionError):
    """The build tried to download a file that is not in the fixture cache."""


def options(cache_dir: Path, *, mapless: bool = False) -> BuildOptions:
    """Settings of the fixture build; the cached file names depend on them."""
    return BuildOptions(
        name=MAPLESS_NAME if mapless else None,
        margin=100,
        cache_dir=cache_dir,
        sr16_dir=FIXTURES / "sr16",
        lidar_dirs=(LIDAR_425,),
        area=MAPLESS_AREA if mapless else None,
    )


def _build(out: Path, cache: Path, *, mapless: bool) -> Path:
    map_path = None if mapless else TEST_MAP
    return build_world(map_path, out, options(cache, mapless=mapless))


@contextmanager
def offline() -> Iterator[None]:
    """Make every download fail with NetworkUsedError.

    The build carries on without some sources when their download fails, so a missing
    cache file must stop it rather than look like a service being down.
    """

    def refuse(url: str, **kwargs: object) -> None:
        msg = f"{url} {kwargs.get('params')} is not in {CACHE}"
        raise NetworkUsedError(msg)

    with mock.patch("terraino.fetch.cache.requests.get", side_effect=refuse):
        yield


def build_fixture_world(out: Path, *, mapless: bool = False) -> Path:
    """Build the fixture world, or the mapless one, into ``out`` without network access.

    Returns:
        Path of the written ``manifest.json``.
    """
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp) / "cache"
        # The build adds its own results to the cache; keep the fixture as it is.
        shutil.copytree(CACHE, cache)
        with offline():
            return _build(out, cache, mapless=mapless)


def refresh_cache() -> None:
    """Download the fixture worlds' data again and store it in the fixture cache."""
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp) / "cache"
        extents = []
        for mapless in (False, True):
            manifest = _build(Path(tmp) / f"world{mapless}", cache, mapless=mapless)
            extents.append(Extent(*json.loads(manifest.read_text())["extent"]))
        shutil.rmtree(CACHE, ignore_errors=True)
        shutil.copytree(cache, CACHE, ignore=shutil.ignore_patterns(*COMPUTED))
    for tile in sorted(CACHE.glob("kartverket/*/*.tif")):
        trim_height_tile(tile, extents)


def trim_height_tile(path: Path, extents: Sequence[Extent]) -> None:
    """Keep only the parts of a height model tile inside ``extents``, compressed.

    The build reads nothing else of the 1 km tiles, so this shrinks them a lot.
    """
    with rasterio.open(path) as src:
        profile = src.profile
        data = src.read(1)
        keep = np.zeros(data.shape, dtype=bool)
        tile = Extent(*src.bounds)
        for extent in extents:
            overlap = extent.intersection(tile)
            if overlap is None:
                continue
            window = src.window(*overlap.as_tuple()).round_offsets().round_lengths()
            window = window.intersection(Window(0, 0, src.width, src.height))
            keep[window.toslices()] = True
    profile.update(compress="deflate", predictor=3, zlevel=9, tiled=True)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(np.where(keep, data, 0).astype(data.dtype), 1)


def main() -> None:
    """Build the fixture world, or refresh the fixture cache."""
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("out", nargs="?", type=Path, help="World folder to write.")
    group.add_argument("--refresh-cache", action="store_true")
    parser.add_argument(
        "--mapless", action="store_true", help="Build the mapless fixture world."
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.refresh_cache:
        refresh_cache()
    else:
        build_fixture_world(args.out, mapless=args.mapless)


if __name__ == "__main__":
    main()
