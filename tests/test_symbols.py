import pytest

from terraino.process.symbols import Ground, SymbolRule, SymbolSet, detect_symbol_set


@pytest.mark.parametrize("key", ["isom2000", "isom2017"])
def test_tables_load(key: str) -> None:
    symbols = SymbolSet.load(key)
    assert symbols.name.startswith("ISOM")
    lake = symbols.rule("301.0")
    assert lake is not None
    assert lake.ground is Ground.WATER
    assert lake.trees == "none"


def test_building_symbol_differs_between_standards() -> None:
    old = SymbolSet.load("isom2000").rule("526")
    new = SymbolSet.load("isom2017").rule("521")
    assert old is not None
    assert new is not None
    assert old.ground is new.ground is Ground.BUILDING


def test_line_symbols_have_widths() -> None:
    symbols = SymbolSet.load("isom2000")
    for number in ("503", "504", "505", "506", "507", "508", "306"):
        rule = symbols.rule(number)
        assert rule is not None
        assert rule.width is not None
        assert rule.clear is not None
        assert rule.clear >= rule.width


def test_unknown_keys_are_rejected() -> None:
    with pytest.raises(ValueError, match="Unknown symbol keys"):
        SymbolRule.from_table({"ground": "forest", "colour": "green"})


def test_unknown_tree_rule_is_rejected() -> None:
    with pytest.raises(ValueError, match="trees rule"):
        SymbolRule.from_table({"trees": "many"})


def test_detect_symbol_set() -> None:
    assert detect_symbol_set({"521", "520"}) == "isom2017"
    assert detect_symbol_set({"526", "521"}) == "isom2000"
    assert detect_symbol_set(set()) == "isom2000"


@pytest.mark.parametrize("key", ["isom2000", "isom2017"])
def test_rough_open_land_has_no_trees(key: str) -> None:
    symbols = SymbolSet.load(key)
    rough = symbols.rule("403")
    scattered = symbols.rule("404")
    assert rough is not None
    assert scattered is not None
    assert rough.trees == "none"
    assert scattered.trees == "scattered"
    open_scattered = symbols.rule("402")
    assert open_scattered is not None
    assert open_scattered.trees == "scattered"


@pytest.mark.parametrize(("key", "number"), [("isom2000", "509"), ("isom2017", "508")])
def test_narrow_ride_is_a_faint_path(key: str, number: str) -> None:
    symbols = SymbolSet.load(key)
    ride = symbols.rule(number)
    faint = symbols.rule("508" if key == "isom2000" else "507")
    assert ride is not None
    assert faint is not None
    assert ride.track == faint.track == "faint_path"
    assert ride.speed == 1.0
    assert ride.clear is not None
    assert ride.clear >= 4


@pytest.mark.parametrize(
    ("key", "stream", "small", "channel"),
    [("isom2000", "305", "306", "307"), ("isom2017", "304", "305", "306")],
)
def test_water_lines_are_drawn_as_water(
    key: str, stream: str, small: str, channel: str
) -> None:
    symbols = SymbolSet.load(key)
    tracks = [symbols.rule(n) for n in (stream, small, channel)]
    assert [r.track for r in tracks if r is not None] == [
        "stream",
        "small_stream",
        "water_channel",
    ]
    assert all(r is not None and r.ground is Ground.WATER for r in tracks)


def test_helper_symbols_are_recognised() -> None:
    from terraino.process.symbols import is_helper_symbol

    assert is_helper_symbol("Hjelpelinje")
    assert is_helper_symbol("Construction line")
    assert not is_helper_symbol("Crossable small watercourse")
    assert not is_helper_symbol("Slep - EN strek")
