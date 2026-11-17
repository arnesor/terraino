"""Kartverket's topographic map, joined from its tiles."""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from terraino.fetch import topomap
from terraino.ingest.georef import Extent


def test_tiles_are_joined_in_place(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each tile lands where the tile matrix puts it: fill each with its row and col."""

    def download(url: str, _params: object, path: Path, **_kwargs: object) -> Path:
        row, col = (int(v) for v in url.removesuffix(".png").split("/")[-2:])
        assert f"/utm33n/{topomap.LEVEL}/" in url
        path.parent.mkdir(parents=True, exist_ok=True)
        colour = (row % 256, col % 256, 7)
        Image.new("RGB", (topomap.TILE_PX, topomap.TILE_PX), colour).save(path)
        return path

    monkeypatch.setattr(topomap, "cached_download", download)
    extent = Extent(193986, 6622759, 194186, 6622959)
    image = topomap.fetch_topo_map(25833, extent, tmp_path)
    rows, cols = topomap.tile_range(25833, extent)
    assert image.rgb.shape == (len(rows) * 256, len(cols) * 256, 3)
    assert image.bounds.intersection(extent) == extent
    # The pixel at the extent's south-east corner comes from the tile that holds it.
    size = topomap.tile_size_m()
    _, west = topomap.MATRIX_SETS[25833]
    row = int((topomap.MATRIX_TOP - (extent.y0 + 0.5)) // size)
    col = int((extent.x1 - 0.5 - west) // size)
    pixel = image.resample(extent, 1)[-1, -1]
    np.testing.assert_array_equal(pixel, (row % 256, col % 256, 7))
