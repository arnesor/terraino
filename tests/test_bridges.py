from typing import Any

import numpy as np
import numpy.typing as npt
import pytest
from shapely import LineString, box

from terraino.ingest.georef import Extent
from terraino.process.bridges import (
    Bridge,
    OsmBridge,
    close_underpasses,
    cut_tracks,
    deck_mask,
    find_decks,
    open_underpasses,
    place_pillars,
    suspected_bridges,
)
from terraino.process.layers import rasterize_map
from terraino.process.symbols import Ground, SymbolSet
from terraino.process.tracks import Track

ISOM = SymbolSet.load("isom2017")
EXTENT = Extent(0, 0, 200, 100)
# A road along y = 50 crossing a 20 m wide gap (x 90-110), 6 m deep, on a bridge.
ROAD = Track("paved", 8, [(0.0, 50.0), (200.0, 50.0)])
OSM_BRIDGE = OsmBridge(LineString([(80, 50), (120, 50)]), "Testvegen (way/1)")


def ground(depth: float = 6.0) -> npt.NDArray[np.float32]:
    dtm = np.full((100, 200), 100.0, dtype=np.float32)
    dtm[:, 90:110] -= depth
    return dtm


def surface(dtm: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """The surface model: the deck at road level across the gap."""
    dom = dtm.copy()
    dom[44:56, 90:110] = 100.0
    return dom


def test_deck_spans_the_gap_in_the_ground() -> None:
    dtm = ground()
    [deck] = find_decks([ROAD], [OSM_BRIDGE], dtm, surface(dtm), EXTENT)
    assert deck.start == pytest.approx(89, abs=1.5)
    assert deck.end == pytest.approx(110, abs=1.5)
    assert deck.start_height == pytest.approx(100, abs=0.1)
    assert deck.end_height == pytest.approx(100, abs=0.1)


def test_shallow_dip_stays_on_the_ground() -> None:
    dtm = ground(depth=0.4)
    assert find_decks([ROAD], [OSM_BRIDGE], dtm, surface(dtm), EXTENT) == []


def test_no_deck_where_the_surface_model_has_none() -> None:
    dtm = ground()
    assert find_decks([ROAD], [OSM_BRIDGE], dtm, dtm.copy(), EXTENT) == []


def test_osm_bridge_far_from_the_road_is_dropped_and_reported(
    caplog: pytest.LogCaptureFixture,
) -> None:
    dtm = ground()
    far = OsmBridge(LineString([(80, 62), (120, 62)]), "Testvegen (way/2)")
    assert find_decks([ROAD], [far], dtm, surface(dtm), EXTENT) == []
    [message] = [r.getMessage() for r in caplog.records]
    assert "Testvegen (way/2) at E 100 N 62" in message
    assert "(paved, 8 m) is up to 12.0 m from it" in message


def test_road_cut_by_the_map_edge_on_the_bridge_gets_a_deck_to_its_end() -> None:
    dtm = ground()
    half = Track("paved", 8, [(0.0, 50.0), (100.0, 50.0)])
    [deck] = find_decks([half], [OSM_BRIDGE], dtm, surface(dtm), EXTENT)
    assert deck.end == pytest.approx(100)
    assert deck.end_height == pytest.approx(100, abs=0.2)


def test_deck_cut_by_the_map_edge_takes_its_height_from_the_surface_model() -> None:
    # The road climbs 5 % onto a level deck; the map's edge cuts it at x = 100.
    dtm = ground()
    dtm[:, :90] = 100 - 0.05 * (90 - np.arange(90))
    half = Track("paved", 8, [(0.0, 50.0), (100.0, 50.0)])
    [guessed] = find_decks([half], [OSM_BRIDGE], dtm, None, EXTENT)
    [seen] = find_decks([half], [OSM_BRIDGE], dtm, surface(dtm), EXTENT)
    assert guessed.end_height == pytest.approx(100.5, abs=0.1)
    assert seen.end_height == pytest.approx(100, abs=0.05)


def test_road_under_the_bridge_is_joined_and_the_road_on_it_cut() -> None:
    dtm = ground()
    lower = [
        Track("gravel", 4, [(100.0, 0.0), (100.0, 43.0)]),
        Track("gravel", 4, [(100.0, 57.0), (100.0, 100.0)]),
    ]
    decks = find_decks([ROAD, *lower], [OSM_BRIDGE], dtm, surface(dtm), EXTENT)
    tracks, bridges = cut_tracks([ROAD, *lower], decks)
    tracks, under = close_underpasses(tracks, bridges)
    gravel = [t for t in tracks if t.kind == "gravel"]
    assert len(gravel) == 1
    assert gravel[0].coords[0] == (100.0, 0.0)
    assert gravel[0].coords[-1] == (100.0, 100.0)
    assert [u.coords for u in under] == [[(100.0, 43.0), (100.0, 57.0)]]
    paved = [t for t in tracks if t.kind == "paved"]
    assert [round(t.coords[-1][0]) for t in paved] == [89, 200]


def test_wide_road_under_a_narrow_bridge_at_a_slant_is_joined() -> None:
    # Magnor: a 503 road over Rv2 (502), which the map leaves 14 m apart under it.
    bridge = Bridge("paved", 5.5, [(80.0, 50.0, 100.0), (120.0, 50.0, 100.0)])
    a = Track("paved", 8, [(70.0, 30.0), (95.5, 44.6)])
    b = Track("paved", 8, [(104.5, 55.4), (130.0, 70.0)])
    tracks, under = close_underpasses([a, b], [bridge])
    assert len(tracks) == 1
    assert len(under) == 1


def test_ends_hooked_by_snapping_are_still_joined() -> None:
    # Magnor, Nordli bru: a path end snapped onto the road on the bridge hooks sideways.
    bridge = Bridge("paved", 8, [(80.0, 50.0, 100.0), (120.0, 50.0, 100.0)])
    north = Track("path", 1.2, [(100.0, 100.0), (100.0, 56.0), (99.4, 56.2)])
    south = Track("path", 1.2, [(100.0, 0.0), (100.0, 44.0)])
    tracks, under = close_underpasses([north, south], [bridge])
    assert len(tracks) == 1
    assert len(under) == 1


def test_ends_that_do_not_face_each_other_stay_apart() -> None:
    bridge = Bridge("paved", 8, [(90.0, 50.0, 100.0), (110.0, 50.0, 100.0)])
    # Both ends point along the bridge, not across it.
    a = Track("gravel", 4, [(100.0, 43.0), (60.0, 43.0)])
    b = Track("gravel", 4, [(100.0, 57.0), (140.0, 57.0)])
    tracks, under = close_underpasses([a, b], [bridge])
    assert under == []
    assert len(tracks) == 2


def line(sym: str, coords: list[tuple[float, float]]) -> dict[str, Any]:
    return {
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"sym": sym},
    }


def area(sym: str, x0: float, y0: float, x1: float, y1: float) -> dict[str, Any]:
    ring = [list(c) for c in box(x0, y0, x1, y1).exterior.coords]
    return {
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"sym": sym},
    }


def test_ground_under_the_deck_is_what_the_map_has_under_the_road() -> None:
    # A river under the bridge; the road (502) is drawn across it.
    features = [area("301.1", 90, 0, 110, 100), line("502", [(0, 50), (200, 50)])]
    layers = rasterize_map(features, ISOM, EXTENT, box(0, 0, 200, 100))
    bridge = Bridge("paved", 8, [(89.0, 50.0, 100.0), (110.0, 50.0, 100.0)])
    road_speed = float(layers.speed[50, 50])
    water_speed = float(layers.speed[10, 100])
    assert float(layers.speed[50, 100]) == road_speed != water_speed

    [built] = open_underpasses(layers, features, ISOM, [bridge], [], EXTENT)

    assert built.speed == pytest.approx(road_speed)
    assert float(layers.speed[50, 100]) == water_speed
    assert float(layers.speed[50, 50]) == road_speed
    assert layers.clear[deck_mask([bridge], EXTENT, layers.clear.shape)].all()


def test_pillars_keep_off_the_road_under_the_bridge() -> None:
    dtm = np.full((100, 200), 90.0, dtype=np.float32)
    bridge = Bridge("paved", 8, [(70.0, 50.0, 100.0), (130.0, 50.0, 100.0)])
    under = Track("paved", 6, [(100.0, 0.0), (100.0, 100.0)])
    [placed] = place_pillars([bridge], [under], None, dtm, EXTENT)
    assert len(placed.pillars) == 2
    for at in placed.pillars:
        assert abs(70 + at - 100) > 3 + 1 + 0.6


def test_a_gap_under_an_untagged_road_is_reported() -> None:
    dtm = ground()
    [(x, y, dip)] = suspected_bridges([ROAD], [], [], dtm, surface(dtm), EXTENT, None)
    assert x == pytest.approx(100, abs=2)
    assert y == pytest.approx(50)
    assert dip == pytest.approx(6, abs=0.2)


def test_trees_over_a_dip_are_not_a_bridge() -> None:
    dtm = ground()
    dom = dtm.copy()
    dom[44:56, 90:110] = 115.0
    assert suspected_bridges([ROAD], [], [], dtm, dom, EXTENT, None) == []


def test_ground_layer_under_a_track_road_is_not_paved() -> None:
    """The road on a bridge is a track: it never painted the ground class."""
    layers = rasterize_map(
        [line("502", [(0, 50), (200, 50)])], ISOM, EXTENT, box(0, 0, 200, 100)
    )
    assert layers.ground[50, 100] != int(Ground.PAVED)
