import pytest

from terraino.ingest.georef import Extent, UnsupportedCrsError, etrs89_utm_epsg


@pytest.mark.parametrize(
    ("epsg", "expected"),
    [(32632, 25832), (32633, 25833), (32635, 25835), (25832, 25832), (25835, 25835)],
)
def test_utm_codes_map_to_etrs89(epsg: int, expected: int) -> None:
    assert etrs89_utm_epsg(epsg) == expected


@pytest.mark.parametrize("epsg", [4326, 32634, 3857])
def test_other_codes_are_rejected(epsg: int) -> None:
    with pytest.raises(UnsupportedCrsError):
        etrs89_utm_epsg(epsg)


def test_empty_extent_is_rejected() -> None:
    with pytest.raises(ValueError, match="Empty extent"):
        Extent(10, 0, 10, 5)


def test_extent_size_and_buffer() -> None:
    e = Extent(100, 200, 400, 300)
    assert (e.width, e.height) == (300, 100)
    assert e.buffered(10).as_tuple() == (90, 190, 410, 310)


def test_snapped_covers_original() -> None:
    e = Extent(663658.4, 6643764.4, 667757.0, 6648392.7).snapped(16)
    assert e.as_tuple() == (663648, 6643760, 667760, 6648400)


def test_intersection() -> None:
    a = Extent(0, 0, 10, 10)
    assert a.intersection(Extent(5, 5, 20, 20)) == Extent(5, 5, 10, 10)
    assert a.intersection(Extent(10, 0, 20, 10)) is None


def test_grid_tiles_are_globally_aligned() -> None:
    tiles = list(Extent(1500, 2500, 2100, 3100).grid_tiles(1000))
    assert [t.as_tuple() for t in tiles] == [
        (1000, 2000, 2000, 3000),
        (2000, 2000, 3000, 3000),
        (1000, 3000, 2000, 4000),
        (2000, 3000, 3000, 4000),
    ]


def test_raster_shape_and_transform() -> None:
    e = Extent(100, 200, 110, 205)
    assert e.raster_shape(1) == (5, 10)
    transform = e.raster_transform(1)
    assert transform @ (0, 0) == (100, 205)
    assert transform @ (10, 5) == (110, 200)
