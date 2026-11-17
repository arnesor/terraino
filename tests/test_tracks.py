from typing import Any

import pytest
from shapely import LineString, box

from terraino.fetch.nvdb import NvdbLine
from terraino.fetch.osm import OsmFeature
from terraino.process.symbols import SymbolSet
from terraino.process.tracks import collect_tracks, snap_ends

ISOM = SymbolSet.load("isom2000")


def line(oid: int, sym: str, coords: list[tuple[float, float]]) -> dict[str, Any]:
    return {
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"oid": oid, "sym": sym},
    }


def test_small_gap_is_snapped_large_gap_kept() -> None:
    main = LineString([(0, 0), (100, 0)])
    near = LineString([(40, 1.2), (40, 50)])
    far = LineString([(70, 3.0), (70, 50)])
    joined, branch, open_branch = snap_ends([main, near, far])
    assert joined.equals(main)
    assert branch.coords[0] == (40.0, 0.0)
    assert open_branch.coords[0] == (70.0, 3.0)


def test_touching_ends_are_unchanged() -> None:
    a = LineString([(0, 0), (10, 0)])
    b = LineString([(10, 0), (10, 10)])
    assert [list(s.coords) for s in snap_ends([a, b])] == [
        list(a.coords),
        list(b.coords),
    ]


def test_collect_tracks_from_map_and_osm() -> None:
    omap = [
        line(0, "506.0", [(0, 0), (50, 0)]),  # footpath
        line(1, "505.0", [(0, 10), (50, 10)]),  # vehicle track
        line(2, "509.0", [(0, 20), (50, 20)]),  # narrow ride: ground, not a strip
        line(3, "101.0", [(0, 30), (50, 30)]),  # contour
    ]
    road = OsmFeature(
        LineString([(-50, 40), (150, 40)]), {"highway": "tertiary"}, "way/1"
    )
    tracks = collect_tracks(omap, ISOM, [road], box(0, -10, 100, 50))
    kinds = sorted((t.kind, t.width) for t in tracks)
    assert ("path", 1.2) in kinds  # footpaths are drawn at least 1.2 m wide
    assert ("vehicle_track", 2.5) in kinds
    paved = [t for t in tracks if t.kind == "paved"]
    # Only the parts of the OSM road outside the mapped area.
    assert len(paved) == 2
    assert sum(LineString(t.coords).length for t in paved) == pytest.approx(100)


def test_unknown_track_style_is_rejected() -> None:
    from terraino.process.symbols import SymbolRule

    with pytest.raises(ValueError, match="Unknown track"):
        SymbolRule.from_table({"track": "motorway"})


def test_pieces_of_a_road_are_joined() -> None:
    omap = [
        line(0, "504.0", [(0, 0), (50, 0)]),
        line(1, "504.0", [(50, 0), (100, 10)]),
        line(2, "504.0", [(100, 10), (150, 10)]),
    ]
    (road,) = collect_tracks(omap, ISOM, [], None)
    assert road.kind == "gravel"
    assert road.coords[0] == (0.0, 0.0)
    assert road.coords[-1] == (150.0, 10.0)


# An NVDB path along y = 0, and OSM ways near it.
NVDB_PATH = NvdbLine("path", 1.2, LineString([(0, 0), (400, 0)]))


def osm_way(coords: list[tuple[float, float]], highway: str = "path") -> OsmFeature:
    return OsmFeature(LineString(coords), {"highway": highway}, "way/1")


def drawn(tracks: list[Any], kind: str) -> list[list[tuple[float, float]]]:
    return [t.coords for t in tracks if t.kind == kind]


def test_nvdb_paths_are_drawn_like_osm_paths() -> None:
    track = NvdbLine("vehicle_track", 3.0, LineString([(0, 50), (400, 50)]))
    tracks = collect_tracks([], ISOM, [], None, [NVDB_PATH, track])
    assert sorted((t.kind, t.width) for t in tracks) == [
        ("path", 1.2),
        ("vehicle_track", 3.0),
    ]


@pytest.mark.parametrize("offset", [0.0, 4.0, 9.0])
def test_osm_path_along_an_nvdb_path_is_left_out(offset: float) -> None:
    way = osm_way([(0, offset), (150, -offset), (400, offset)])
    tracks = collect_tracks([], ISOM, [way], None, [NVDB_PATH])
    assert drawn(tracks, "path") == [[(0.0, 0.0), (400.0, 0.0)]]


def test_branch_leaving_an_nvdb_path_is_joined_onto_it() -> None:
    # Follows the NVDB path, then turns north.
    way = osm_way([(0, 2), (200, 2), (200, 150)])
    tracks = collect_tracks([], ISOM, [way], None, [NVDB_PATH])
    branch = next(c for c in drawn(tracks, "path") if c[-1] == (200.0, 150.0))
    assert branch[0] == pytest.approx((200.0, 0.0))


def test_short_piece_where_the_osm_path_drifts_out_is_dropped() -> None:
    # 15 m off the NVDB path for about 20 m, otherwise on it.
    way = osm_way([(0, 2), (190, 2), (195, 15), (205, 15), (210, 2), (400, 2)])
    tracks = collect_tracks([], ISOM, [way], None, [NVDB_PATH])
    assert drawn(tracks, "path") == [[(0.0, 0.0), (400.0, 0.0)]]


def test_osm_path_away_from_nvdb_is_kept_whole() -> None:
    way = osm_way([(0, 100), (20, 100)])  # short, but not cut
    tracks = collect_tracks([], ISOM, [way], None, [NVDB_PATH])
    assert [(0.0, 100.0), (20.0, 100.0)] in drawn(tracks, "path")


def test_cycleway_and_roads_are_never_compared() -> None:
    cycleway = osm_way([(0, 3), (400, 3)], "cycleway")
    road = osm_way([(0, -4), (400, -4)], "tertiary")
    tracks = collect_tracks([], ISOM, [cycleway, road], None, [NVDB_PATH])
    assert {t.kind for t in tracks} == {"path", "vehicle_track", "paved"}


def test_the_map_wins_over_nvdb() -> None:
    mapped = box(0, -50, 200, 50)
    way = osm_way([(150, 2), (250, 2)])  # half in the map
    tracks = collect_tracks([], ISOM, [way], mapped, [NVDB_PATH])
    # NVDB outside the map only; the OSM path is cut against that part only.
    assert drawn(tracks, "path") == [[(200.0, 0.0), (400.0, 0.0)]]
