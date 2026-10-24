from typing import Any

import pytest
from shapely import LineString, box

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
