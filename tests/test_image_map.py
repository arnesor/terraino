import math
import zipfile
from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest
from PIL import Image
from pyproj import Transformer

from terraino.ingest.georef import Extent
from terraino.ingest.image import ImageMapError, parse_world_file, read_image_map
from terraino.process.classify import Colour, classify_colours, classify_map
from terraino.process.symbols import Ground, SymbolSet

ISOM = SymbolSet.load("isom2000")
WHITE = (255, 255, 255)
YELLOW = (255, 189, 86)
GREEN = (138, 210, 151)
LAKE = (132, 206, 239)
BLACK = (44, 46, 53)
BLUE_LINE = (11, 167, 225)
BROWN = (224, 113, 30)


def test_world_file_with_rotation_terms() -> None:
    t = parse_world_file("1.0\n0.5\n0.25\n-1.0\n100.5\n200.5\n")
    # The world file gives the centre of the upper-left pixel.
    assert t @ (0.5, 0.5) == pytest.approx((100.5, 200.5))
    assert t @ (1.5, 0.5) == pytest.approx((101.5, 201.0))


def test_bad_world_file() -> None:
    with pytest.raises(ImageMapError, match="six numbers"):
        parse_world_file("1 2 3")


def write_png_with_world(
    path: Path, rgb: npt.NDArray[np.uint8], x0: float, y1: float
) -> None:
    Image.fromarray(rgb).save(path)
    path.with_suffix(".pgw").write_text(f"1\n0\n0\n-1\n{x0 + 0.5}\n{y1 - 0.5}\n")


def test_world_file_needs_epsg(tmp_path: Path) -> None:
    write_png_with_world(
        tmp_path / "map.png", np.zeros((4, 4, 3), np.uint8), 1000, 2000
    )
    with pytest.raises(ImageMapError, match="--epsg"):
        read_image_map(tmp_path / "map.png")
    image = read_image_map(tmp_path / "map.png", 32633)
    assert image.epsg == 25833
    assert image.bounds == Extent(1000, 1996, 1004, 2000)


def test_missing_georeference(tmp_path: Path) -> None:
    Image.new("RGB", (4, 4)).save(tmp_path / "map.png")
    with pytest.raises(ImageMapError, match="No georeference"):
        read_image_map(tmp_path / "map.png", 25832)


def test_kmz_overlay(tmp_path: Path) -> None:
    kml = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><GroundOverlay>
  <Icon><href>files/map.png</href></Icon>
  <LatLonBox><north>59.95</north><south>59.90</south>
  <east>12.00</east><west>11.90</west><rotation>0</rotation></LatLonBox>
</GroundOverlay></Document></kml>"""
    png = tmp_path / "map.png"
    Image.new("RGB", (100, 200), WHITE).save(png)
    kmz = tmp_path / "map.kmz"
    with zipfile.ZipFile(kmz, "w") as z:
        z.writestr("doc.kml", kml)
        z.write(png, "files/map.png")
    image = read_image_map(kmz)
    assert image.epsg == 25832
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    x, y = to_utm.transform(11.95, 59.925)
    centre = image.transform @ (50, 100)
    assert centre == pytest.approx((x, y), abs=1.0)
    assert image.rgb.shape == (200, 100, 3)


def test_rotated_kmz_corners(tmp_path: Path) -> None:
    kml = """<kml xmlns="http://www.opengis.net/kml/2.2"><GroundOverlay>
  <Icon><href>m.png</href></Icon>
  <LatLonBox><north>59.95</north><south>59.90</south>
  <east>12.00</east><west>11.90</west><rotation>90</rotation></LatLonBox>
</GroundOverlay></kml>"""
    kmz = tmp_path / "m.kmz"
    buf = tmp_path / "m.png"
    Image.new("RGB", (10, 10), WHITE).save(buf)
    with zipfile.ZipFile(kmz, "w") as z:
        z.writestr("doc.kml", kml)
        z.write(buf, "m.png")
    image = read_image_map(kmz)
    # Rotated a quarter turn: the image's top edge now points west.
    (x0, y0), (x1, y1) = image.transform @ (0, 0), image.transform @ (10, 0)
    assert math.degrees(math.atan2(y1 - y0, x1 - x0)) == pytest.approx(90, abs=1)


def test_classify_colours_tolerates_scan_noise() -> None:
    img = np.array(
        [[[250, 192, 90], [140, 205, 155], [40, 40, 50], [120, 30, 200]]], np.uint8
    )
    assert classify_colours(img).tolist() == [
        [Colour.YELLOW, Colour.GREEN2, Colour.BLACK, Colour.OTHER]
    ]


def synthetic_map() -> npt.NDArray[np.uint8]:
    """A 200 x 200 m map: forest, a yellow field, a green thicket, a lake, a house.

    Brown contour lines cross the whole map, as on a real map.
    """
    rgb = np.full((200, 200, 3), WHITE, dtype=np.uint8)
    for row in range(5, 200, 12):
        rgb[row, 5:195] = BROWN
    rgb[20:80, 20:100] = YELLOW
    rgb[100:160, 20:80] = GREEN
    rgb[110:150, 120:180] = LAKE
    rgb[30:40, 140:155] = BLACK  # house, 10 x 15 m
    rgb[60:62, 110:190] = BLACK  # a path, 80 m long
    for row in range(170, 196, 4):  # marsh hatching
        rgb[row : row + 1, 100:190] = BLUE_LINE
    return rgb


def test_classify_map() -> None:
    rgb = synthetic_map()
    extent = Extent(0, 0, 200, 200)
    result = classify_map(
        rgb, np.ones((200, 200), bool), extent.raster_transform(1), ISOM
    )
    ground = result.layers.ground
    assert ground[50, 60] == Ground.OPEN
    assert ground[130, 50] == Ground.FOREST
    assert result.layers.young[130, 50] == pytest.approx(8)
    assert ground[130, 150] == Ground.WATER
    assert ground[100, 100] == Ground.FOREST
    assert ground[101, 100] == Ground.FOREST  # on a contour line
    assert ground[61, 150] == Ground.PATH
    assert result.layers.clear[61, 150]
    assert ground[180, 140] == Ground.MARSH
    assert len(result.buildings) == 1
    assert result.buildings[0].area == pytest.approx(150, rel=0.2)
    assert result.map_area.area > 150 * 150


def test_boulder_dots_are_not_buildings() -> None:
    rgb = np.full((100, 100, 3), YELLOW, dtype=np.uint8)
    yy, xx = np.mgrid[0:100, 0:100]
    rgb[(yy - 50) ** 2 + (xx - 50) ** 2 <= 9] = BLACK  # a 6 m dot
    extent = Extent(0, 0, 100, 100)
    result = classify_map(
        rgb, np.ones((100, 100), bool), extent.raster_transform(1), ISOM
    )
    assert result.buildings == []
    assert result.layers.ground[50, 50] == Ground.OPEN


def test_north_lines_are_not_paths() -> None:
    rgb = np.full((300, 300, 3), WHITE, dtype=np.uint8)
    rgb[:, 100:102] = BLACK  # a north line across the whole map, 2 m wide
    for x in range(20, 280):  # a winding path
        y = int(150 + 30 * math.sin(x / 25))
        rgb[y : y + 2, x] = BLACK
    extent = Extent(0, 0, 300, 300)
    result = classify_map(
        rgb, np.ones((300, 300), bool), extent.raster_transform(1), ISOM
    )
    ground = result.layers.ground
    assert ground[30, 100] != Ground.PATH
    assert ground[int(150 + 30 * math.sin(200 / 25)), 200] == Ground.PATH
