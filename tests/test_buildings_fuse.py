import math
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest
from shapely import LineString, Polygon, box

from otest.fetch.ar5 import decode_land_cover
from otest.fetch.osm import OsmFeature, parse_overpass
from otest.ingest.georef import Extent
from otest.process.buildings import (
    building_kind,
    collect_footprints,
    fit_roof,
    measure_buildings,
)
from otest.process.fuse import apply_land_cover, apply_osm, road_style
from otest.process.layers import TREES_LIDAR, GroundLayers
from otest.process.symbols import Ground, SymbolSet

EXTENT = Extent(0, 0, 100, 100)
# 12 x 8 m, the long side east-west.
ROOF_FOOTPRINT = box(0, 0, 12, 8)


def empty_layers(in_map: npt.NDArray[np.bool_] | None = None) -> GroundLayers:
    shape = EXTENT.raster_shape(1)
    zeros = np.zeros(shape, dtype=np.float32)
    return GroundLayers(
        ground=np.zeros(shape, dtype=np.uint8),
        speed=zeros + 1,
        young=zeros.copy(),
        shrubs=zeros.copy(),
        tree_rule=np.zeros(shape, dtype=np.uint8),
        clear=np.zeros(shape, dtype=bool),
        in_map=in_map if in_map is not None else np.zeros(shape, dtype=bool),
    )


def cell(x: float, y: float) -> tuple[int, int]:
    return int(EXTENT.y1 - y), int(x - EXTENT.x0)


def test_parse_multipolygon_with_hole() -> None:
    def ring(x0: float, y0: float, x1: float, y1: float) -> list[dict[str, float]]:
        pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
        return [{"lon": x, "lat": y} for x, y in pts]

    data = {
        "elements": [
            {
                "type": "relation",
                "id": 7,
                "tags": {"natural": "water", "type": "multipolygon"},
                "members": [
                    {"type": "way", "role": "outer", "geometry": ring(0, 0, 10, 10)},
                    {"type": "way", "role": "inner", "geometry": ring(4, 4, 6, 6)},
                ],
            },
            {
                "type": "way",
                "id": 8,
                "tags": {"highway": "track"},
                "geometry": [{"lon": 0, "lat": 0}, {"lon": 5, "lat": 5}],
            },
        ]
    }
    lake, track = parse_overpass(data)
    assert lake.osm_id == "relation/7"
    assert lake.geometry.area == pytest.approx(96)
    assert track.geometry.geom_type == "LineString"


def test_ar5_bog_hatching_becomes_marsh() -> None:
    img = np.full((10, 10, 3), 255, dtype=np.uint8)
    img[::3] = (181, 236, 252)
    classes = decode_land_cover(img)
    assert (classes == Ground.MARSH).all()


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"highway": "secondary"}, (6.5, Ground.PAVED)),
        ({"highway": "service", "surface": "gravel"}, (3.5, Ground.GRAVEL)),
        ({"highway": "path"}, (1.0, Ground.PATH)),
        ({"highway": "residential", "surface": "dirt"}, (5.0, Ground.PATH)),
        ({"building": "yes"}, None),
    ],
)
def test_road_style(tags: dict[str, str], expected: Any) -> None:
    assert road_style(tags) == expected


def test_land_cover_only_outside_map() -> None:
    in_map = np.zeros(EXTENT.raster_shape(1), dtype=bool)
    in_map[:, :50] = True
    layers = empty_layers(in_map)
    layers.ground[:] = Ground.FOREST
    land_cover = np.full(EXTENT.raster_shape(1), Ground.FIELD, dtype=np.uint8)
    apply_land_cover(layers, land_cover)
    assert layers.ground[cell(25, 50)] == Ground.FOREST
    assert layers.ground[cell(75, 50)] == Ground.FIELD
    assert layers.tree_rule[cell(75, 50)] == TREES_LIDAR
    assert layers.speed[cell(75, 50)] == pytest.approx(0.6)


def test_osm_roads_outside_map_and_buildings_everywhere() -> None:
    in_map = np.zeros(EXTENT.raster_shape(1), dtype=bool)
    in_map[:, :50] = True
    layers = empty_layers(in_map)
    road = OsmFeature(
        LineString([(0, 50), (100, 50)]), {"highway": "tertiary"}, "way/1"
    )
    houses = [box(10, 10, 20, 20), box(70, 10, 80, 20)]
    apply_osm(layers, [road], houses, EXTENT)
    assert layers.ground[cell(25, 50)] == Ground.UNKNOWN  # inside the map: map decides
    assert layers.ground[cell(75, 50)] == Ground.UNKNOWN  # drawn as a strip
    assert layers.clear[cell(75, 50)]
    for x in (15, 75):
        assert layers.ground[cell(x, 15)] == Ground.BUILDING
        assert layers.speed[cell(x, 15)] == 0
        assert layers.clear[cell(x - 5.5, 15)]  # clearance around the building


def test_building_kind() -> None:
    assert building_kind({"building": "farm_auxiliary"}) == "farm_auxiliary"
    assert building_kind({"building": "church"}) == "other"


def test_map_buildings_only_added_where_osm_has_none() -> None:
    osm = [OsmFeature(box(10, 10, 20, 20), {"building": "house"}, "way/1")]

    def omap_building(oid: int, poly: Polygon) -> dict[str, Any]:
        coords = [list(poly.exterior.coords)]
        return {
            "geometry": {"type": "Polygon", "coordinates": coords},
            "properties": {"oid": oid, "sym": "526.0"},
        }

    omap = [
        omap_building(1, box(11, 11, 21, 21)),
        omap_building(2, box(60, 60, 70, 66)),
    ]
    footprints = collect_footprints(osm, omap, SymbolSet.load("isom2000"))
    assert [(source, ident) for _, _, source, ident in footprints] == [
        ("osm", "way/1"),
        ("map", "map/2"),
    ]


def gable_house_canopy() -> npt.NDArray[np.float32]:
    """Canopy over a 10 x 20 m house at x 40..50, y 40..60, ridge north-south at 8 m."""
    canopy = np.zeros(EXTENT.raster_shape(1), dtype=np.float32)
    for x in range(40, 50):
        across = abs(x + 0.5 - 45) / 5  # 0 at the ridge, 1 at the eaves
        row0, col = cell(x, 59.5)
        canopy[row0 : row0 + 20, col] = 8 - 3 * across
    return canopy


def test_measure_gable_house() -> None:
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    dtm[:, 45:] = 99.0  # sloping ground under half the house
    footprints = [(box(40, 40, 50, 60), "house", "osm", "way/1")]
    (house,) = measure_buildings(footprints, dtm, gable_house_canopy(), EXTENT)
    assert house.roof_type == "gable"
    assert house.base == pytest.approx(99.0)
    assert house.wall + house.roof == pytest.approx(7.8, abs=0.5)
    assert house.roof > 1.0
    # The long side runs north-south.
    assert abs(math.cos(house.ridge)) < 0.01
    assert house.wall_color.startswith("#")


def test_measure_without_laser_heights_uses_defaults() -> None:
    dtm = np.full(EXTENT.raster_shape(1), 50.0, dtype=np.float32)
    canopy = np.zeros_like(dtm)
    (shed,) = measure_buildings(
        [(box(10, 10, 14, 13), "shed", "map", "map/3")], dtm, canopy, EXTENT
    )
    assert (shed.wall, shed.roof) == (2.3, 0.9)
    assert shed.base == 50.0


def roof_samples(
    height: Any, footprint: Polygon = ROOF_FOOTPRINT
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Samples every 0.5 m inside the footprint, of height(x, y)."""
    x0, y0, x1, y1 = footprint.bounds
    yy, xx = np.mgrid[y0 + 0.25 : y1 : 0.5, x0 + 0.25 : x1 : 0.5]
    return xx.ravel(), yy.ravel(), height(xx, yy).ravel()


@pytest.mark.parametrize(
    ("height", "roof_type", "ridge_deg", "eave", "ridge"),
    [
        # Hipped: 12 x 8 m, the ridge 4 m long, 2 m above the eaves at 3 m.
        (
            lambda x, y: 5 - 0.5 * np.maximum(np.abs(y - 4), np.abs(x - 6) - 2),
            "hip",
            0,
            3.0,
            5.0,
        ),
        # Shed rising to the south: its high edge runs east, the roof to its right.
        (lambda x, y: 3 + 0.25 * (8 - y), "shed", 0, 3.0, 5.0),
        # Shed rising to the east, along the building.
        (lambda x, y: 3 + 0.2 * x, "shed", 90, 3.0, 5.4),
        # Gable with the ridge across the building (north-south).
        (lambda x, y: 6 - 0.4 * np.abs(x - 6), "gable", 90, 3.6, 6.0),
    ],
)
def test_fit_roof(
    height: Any, roof_type: str, ridge_deg: float, eave: float, ridge: float
) -> None:
    rng = np.random.default_rng(0)
    x, y, z = roof_samples(height)
    z = z + rng.normal(0, 0.05, len(z))
    z[::37] += 1.5  # a chimney and an overhanging branch or two
    fit = fit_roof(x, y, z, ROOF_FOOTPRINT)
    assert fit is not None
    assert fit.roof_type == roof_type
    period = 360 if roof_type == "shed" else 180
    assert math.degrees(fit.angle) % period == pytest.approx(ridge_deg % period, abs=3)
    assert fit.eave == pytest.approx(eave, abs=0.25)
    assert fit.ridge == pytest.approx(ridge, abs=0.25)


def test_measure_buildings_with_laser_surface() -> None:
    dtm = np.full(EXTENT.raster_shape(1), 100.0, dtype=np.float32)
    footprint = box(40, 40, 52, 48)  # 12 x 8 m, long side east-west
    fine = 2
    rows, cols = np.mgrid[0 : 100 * fine, 0 : 100 * fine]
    x = (cols + 0.5) / fine
    y = 100 - (rows + 0.5) / fine
    # Hipped roof, eaves 3.5 m and ridge 6 m above the ground.
    roof = 6 - 2.5 / 4 * np.maximum(np.abs(y - 44), np.abs(x - 46) - 2)
    inside = (x > 40) & (x < 52) & (y > 40) & (y < 48)
    surface = np.where(inside, roof, 0.0).astype(np.float32)
    (house,) = measure_buildings(
        [(footprint, "house", "osm", "osm/1")],
        dtm,
        np.zeros_like(dtm),
        EXTENT,
        surface=surface,
        fine=fine,
    )
    assert house.roof_type == "hip"
    assert len(house.parts) == 1  # measured as one wing, hipped at both ends
    assert house.parts[0].hips == (True, True)
    assert house.wall == pytest.approx(3.5, abs=0.3)
    assert house.wall + house.roof == pytest.approx(6.0, abs=0.3)
    assert abs(math.sin(house.ridge)) < 0.05  # ridge east-west
