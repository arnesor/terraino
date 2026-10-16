from pathlib import Path
from typing import ClassVar

import numpy as np
import numpy.typing as npt
import pytest
import rasterio
import requests

from otest.fetch import cache, kartverket
from otest.ingest.georef import Extent


def write_tif(
    path: Path, extent: Extent, epsg: int, data: npt.NDArray[np.float64]
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=data.shape[1],
        height=data.shape[0],
        count=1,
        dtype="float32",
        crs=f"EPSG:{epsg}",
        transform=extent.raster_transform(1),
    ) as dst:
        dst.write(data.astype(np.float32), 1)


FakeService = tuple[set[tuple[int, int]], list[tuple[int, Extent]]]


@pytest.fixture
def fake_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeService:
    """Serve synthetic 1 km tiles: height = easting/1000 + northing/10000 (no network).

    Tiles listed in ``holes`` return 0.0 (no coverage) in the 25832 service.
    """
    holes: set[tuple[int, int]] = set()
    calls: list[tuple[int, Extent]] = []

    def download(cache_dir: Path, kind: str, epsg: int, tile: Extent) -> Path:
        calls.append((epsg, tile))
        size = round(tile.width)
        ys, xs = np.mgrid[0:size, 0:size]
        east = tile.x0 + xs + 0.5
        north = tile.y1 - ys - 0.5
        data = east / 1000 + north / 10000
        if epsg == 25832 and (int(tile.x0), int(tile.y0)) in holes:
            data[:] = 0.0
        path = tmp_path / "tiles" / f"{epsg}_{int(tile.x0)}_{int(tile.y0)}.tif"
        write_tif(path, tile, epsg, data)
        return path

    monkeypatch.setattr(kartverket, "_download_tile", download)
    return holes, calls


def test_mosaic_matches_extent(fake_service: FakeService, tmp_path: Path) -> None:
    extent = Extent(600500, 6600200, 602300, 6601100)
    grid = kartverket.fetch_height_model("dtm", 25832, extent, tmp_path)
    assert grid.shape == (900, 1800)
    # North-west cell centre is (600500.5, 6601099.5).
    assert grid[0, 0] == pytest.approx(600.5005 + 660.10995, abs=1e-3)
    assert grid[-1, -1] == pytest.approx(602.2995 + 660.02005, abs=1e-3)
    assert not np.isnan(grid).any()


def test_gaps_are_filled_from_other_zone(
    fake_service: FakeService, tmp_path: Path
) -> None:
    holes, calls = fake_service
    holes.add((601000, 6600000))
    extent = Extent(600500, 6600200, 602300, 6601100)
    grid = kartverket.fetch_height_model("dtm", 25832, extent, tmp_path)
    assert any(epsg == 25833 for epsg, _ in calls)
    assert not np.isnan(grid).any()


def test_cached_download_writes_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class Response:
        ok = True
        status_code = 200
        headers: ClassVar[dict[str, str]] = {"Content-Type": "image/tiff"}
        content = b"tiff-bytes"
        text = ""

    calls: list[str] = []

    def get(url: str, **kwargs: object) -> Response:
        calls.append(url)
        return Response()

    monkeypatch.setattr("otest.fetch.cache.requests.get", get)
    target = tmp_path / "a" / "b.tif"
    assert cache.cached_download(
        "https://x", {}, target, expect_content_type="image/tiff"
    )
    cache.cached_download("https://x", {}, target, expect_content_type="image/tiff")
    assert target.read_bytes() == b"tiff-bytes"
    assert len(calls) == 1


def test_cached_download_rejects_error_pages(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class Response:
        ok = True
        status_code = 200
        headers: ClassVar[dict[str, str]] = {
            "Content-Type": "application/vnd.ogc.se_xml"
        }
        content = b"<ServiceException/>"
        text = "<ServiceException/>"

    monkeypatch.setattr("otest.fetch.cache.requests.get", lambda url, **kw: Response())
    monkeypatch.setattr("otest.fetch.cache.time.sleep", lambda s: None)
    target = tmp_path / "x.tif"
    with pytest.raises(cache.DownloadError, match="ServiceException"):
        cache.cached_download("https://x", {}, target, expect_content_type="image/tiff")
    assert not target.exists()


def test_cached_download_retries_connection_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def get(url: str, **kwargs: object) -> None:
        raise requests.ConnectionError("down")

    monkeypatch.setattr("otest.fetch.cache.requests.get", get)
    monkeypatch.setattr("otest.fetch.cache.time.sleep", lambda s: None)
    with pytest.raises(cache.DownloadError, match="down"):
        cache.cached_download("https://x", {}, tmp_path / "x.tif")
