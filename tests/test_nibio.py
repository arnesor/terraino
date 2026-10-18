from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest
import rasterio
from PIL import Image

from terraino.fetch import nibio
from terraino.ingest.georef import Extent


def write_sr16(path: Path, extent: Extent, data: npt.NDArray[np.int_]) -> None:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=data.shape[1],
        height=data.shape[0],
        count=1,
        dtype="int16",
        crs="EPSG:25832",
        transform=extent.raster_transform(16),
        nodata=-9999,
    ) as dst:
        dst.write(data.astype(np.int16), 1)


def test_local_sr16_is_resampled_to_1m(tmp_path: Path) -> None:
    grid = Extent(1600, 3200, 1664, 3264)  # 4 x 4 cells of 16 m
    species = np.array(
        [[1, 1, 2, 2], [1, 1, 2, 2], [3, 3, -9999, -9999], [3, 3, -9999, -9999]]
    )
    write_sr16(tmp_path / "sr16_34_SRRTRESLAG.tif", grid, species)
    write_sr16(tmp_path / "sr16_34_SRRTREANTALL.tif", grid, np.full((4, 4), 800))
    world = Extent(1608, 3208, 1656, 3256)
    forest = nibio.fetch_forest(25832, world, tmp_path / "cache", tmp_path)
    assert forest.species.shape == (48, 48)
    assert forest.species[0, 0] == nibio.Species.SPRUCE
    assert forest.species[0, -1] == nibio.Species.PINE
    assert forest.species[-1, 0] == nibio.Species.DECIDUOUS
    assert forest.species[-1, -1] == nibio.Species.NONE
    assert forest.trees_per_ha is not None
    assert np.nanmax(forest.trees_per_ha) == pytest.approx(800)
    assert forest.crown_cover is None


def test_wms_species_image_is_decoded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fake_download(url: str, params: dict[str, str], path: Path, **kw: str) -> Path:
        width, height = int(params["width"]), int(params["height"])
        img = np.full((height, width, 3), 255, dtype=np.uint8)
        img[:, : width // 2] = (82, 176, 56)
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(img).save(path)
        return path

    monkeypatch.setattr("terraino.fetch.nibio.cached_download", fake_download)
    world = Extent(0, 0, 64, 32)
    forest = nibio.fetch_forest(25832, world, tmp_path)
    assert forest.source == "WMS"
    assert forest.species[:, :32].min() == nibio.Species.SPRUCE
    assert forest.species[:, 32:].max() == nibio.Species.NONE
