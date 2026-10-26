"""Where the runner stands when a world opens."""

import logging

import pytest
from shapely import Polygon

from terraino.build import choose_spawn
from terraino.ingest.georef import Extent

EXTENT = Extent(0, 0, 1000, 800)
MAP_AREA = Polygon([(100, 100), (900, 100), (900, 700), (100, 700)])


def test_default_is_inside_the_map() -> None:
    east, north = choose_spawn(None, EXTENT, MAP_AREA)
    assert 100 < east < 900
    assert 100 < north < 700


def test_a_position_on_the_map_is_kept(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING):
        assert choose_spawn((250.0, 600.0), EXTENT, MAP_AREA) == (250.0, 600.0)
    assert not caplog.records


def test_a_position_off_the_map_is_kept_with_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        assert choose_spawn((50.0, 50.0), EXTENT, MAP_AREA) == (50.0, 50.0)
    assert "outside the map" in caplog.text


def test_a_position_outside_the_world_is_refused() -> None:
    with pytest.raises(ValueError, match="outside the world"):
        choose_spawn((1200.0, 400.0), EXTENT, MAP_AREA)
