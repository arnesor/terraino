import pytest

from otest.process.symbols import Ground, SymbolRule, SymbolSet, detect_symbol_set


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
