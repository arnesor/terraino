"""The chosen area of a mapless world, and the hoydedata.no box."""

import pytest
from pyproj import Transformer
from shapely import box

from terraino.ingest.area import (
    AREA_EPSG,
    AreaError,
    check_area,
    hoydedata_box,
    reproject_area,
    world_epsg,
)
from terraino.ingest.georef import Extent

# Around Kongsberg, in zone 32: the corners hoydedata.no showed for an export there.
KONGSBERG = Extent(193986, 6622759, 198986, 6627759)


@pytest.mark.parametrize(
    ("area", "reason"),
    [
        (Extent(193986, 6622759, 194185, 6627759), "at least 200 m"),
        (Extent(193986, 6622759, 205073, 6628020), "at most 25 km²"),
        (Extent(-200000, 6622759, -197000, 6625759), "not inside Norway"),
        (Extent(500000, 6430000, 503000, 6433000), "not inside Norway"),
    ],
)
def test_unbuildable_areas_are_refused(area: Extent, reason: str) -> None:
    with pytest.raises(AreaError, match=reason):
        check_area(area)


@pytest.mark.parametrize(
    "area",
    [KONGSBERG, Extent(331180, 6646380, 331380, 6646580)],
)
def test_buildable_areas_pass(area: Extent) -> None:
    check_area(area)


@pytest.mark.parametrize(
    ("east", "epsg"),
    [
        (-50_000, 25832),  # Bergen side
        (300_000, 25832),  # just west of 12°E at 60°N
        (380_000, 25833),  # Värmland border, east of 12°E
        (700_000, 25833),  # Tromsø-ish
        (1_090_000, 25835),  # Vardø
    ],
)
def test_world_is_built_in_the_zone_of_the_middle(east: float, epsg: int) -> None:
    north = 6_650_000 if east < 400_000 else 7_880_000
    assert world_epsg(Extent(east, north, east + 1000, north + 1000)) == epsg


def test_area_in_zone_33_stays_the_rectangle() -> None:
    area = Extent(560000, 7440000, 565000, 7445000)
    assert reproject_area(area, AREA_EPSG).equals(box(*area.as_tuple()))


def test_area_in_another_zone_turns_and_comes_back() -> None:
    turned = reproject_area(KONGSBERG, 25832)
    # Grid north differs by several degrees between the zones at Kongsberg.
    (_, y0), (_, y1) = turned.exterior.coords[0], turned.exterior.coords[1]
    assert abs(y1 - y0) > 100
    # Back in UTM33 and with no margin, the hoydedata.no box is the rectangle again.
    found = hoydedata_box(turned, 25832, 0)
    assert found == KONGSBERG.snapped(10)


def test_hoydedata_box_covers_a_map_in_zone_32_with_its_margin() -> None:
    mapped = box(666537.6, 6646245.6, 666905.3, 6646523.5)
    found = hoydedata_box(mapped, 25832, 100)
    to_utm33 = Transformer.from_crs(25832, AREA_EPSG, always_xy=True)
    xs, ys = to_utm33.transform(*mapped.exterior.xy)
    # The map's corners plus the margin, rounded outward to 10 m and no further.
    assert min(xs) - 110 < found.x0 <= min(xs) - 100
    assert min(ys) - 110 < found.y0 <= min(ys) - 100
    assert max(xs) + 100 <= found.x1 < max(xs) + 110
    assert max(ys) + 100 <= found.y1 < max(ys) + 110
    assert all(v % 10 == 0 for v in found.as_tuple())
