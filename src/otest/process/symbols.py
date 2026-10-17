"""What orienteering map symbols mean for the 3D world.

The meaning of each symbol is kept in TOML tables in ``otest/symbols/``, one per symbol
standard. See ``isom2000.toml`` for a description of the keys.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from enum import IntEnum
from importlib import resources
from typing import Any, Literal

TreeRule = Literal["keep", "none", "lidar", "scattered"]
TRACKS = frozenset(
    {
        "paved",
        "gravel",
        "vehicle_track",
        "path",
        "small_path",
        "faint_path",
        "stream",
        "small_stream",
        "water_channel",
    }
)
# Words in a symbol's name (in the map file) that mark mapper's helper symbols, such as
# construction lines; they are not part of the terrain.
HELPER_WORDS = (
    "hjelpelinje",
    "hjelpe",
    "helper",
    "help line",
    "construction",
    "konstruksjon",
)


def is_helper_symbol(description: str) -> bool:
    """True for a mapper's helper symbol, judged by its name in the map file.

    Examples:
        >>> is_helper_symbol("Hjelpelinje kurver"), is_helper_symbol("Minor water channel")
        (True, False)
    """
    name = description.lower()
    return any(word in name for word in HELPER_WORDS)


FEATURES = frozenset(
    {
        "boulder",
        "boulder_cluster",
        "boulder_field",
        "stones",
        "cliff",
        "rock_face",
        "stone_wall",
        "ruined_wall",
        "fence",
        "ruined_fence",
        "power_line",
        "pylon_line",
        "tower",
        "cairn",
        "fodder_rack",
        "ruin",
        "footbridge",
    }
)


class Ground(IntEnum):
    """Ground surface classes, shared with the viewer's terrain shader."""

    UNKNOWN = 0
    FOREST = 1
    OPEN = 2
    ROUGH = 3
    MARSH = 4
    ROCK = 5
    FIELD = 6
    PAVED = 7
    GRAVEL = 8
    PATH = 9
    WATER = 10
    LAWN = 11
    STONY = 12
    SAND = 13
    BUILDING = 14


@dataclass(frozen=True)
class SymbolRule:
    """The 3D meaning of one map symbol.

    Attributes:
        ground: Ground class painted by the symbol, or None.
        trees: What happens to trees from the laser canopy under the symbol.
        young: Young trees added per 100 m².
        shrubs: Undergrowth density, 0..1.
        speed: Running speed factor, or None to leave it unchanged.
        width: Real-world width in metres of a line symbol, or None.
        clear: Width in metres of a tree-free strip along a line, or None.
        order: Drawing order; higher values are painted on top.
        feature: 3D object placed for the symbol (see FEATURES), or None.
        size: Size of the feature in metres, or None for its default.
        overprint: The symbol is drawn on top of other areas (undergrowth patterns):
            it adds its shrubs and speed but keeps the ground and trees below.
        track: Style of a road or path drawn as its own strip on the terrain (see
            TRACKS), or None. Such lines set speed and clear trees, but do not paint
            the ground layer.
    """

    ground: Ground | None = None
    trees: TreeRule = "keep"
    young: float = 0.0
    shrubs: float = 0.0
    speed: float | None = None
    width: float | None = None
    clear: float | None = None
    order: int = 0
    feature: str | None = None
    size: float | None = None
    overprint: bool = False
    track: str | None = None

    @classmethod
    def from_table(cls, entry: Mapping[str, Any]) -> SymbolRule:
        """Create a rule from a TOML table entry."""
        known = set(cls.__dataclass_fields__)
        unknown = set(entry) - known
        if unknown:
            msg = f"Unknown symbol keys: {sorted(unknown)}"
            raise ValueError(msg)
        values = dict(entry)
        if "ground" in values:
            values["ground"] = Ground[str(values["ground"]).upper()]
        if values.get("track") is not None and values["track"] not in TRACKS:
            msg = f"Unknown track {values['track']!r}"
            raise ValueError(msg)
        if values.get("feature") is not None and values["feature"] not in FEATURES:
            msg = f"Unknown feature {values['feature']!r}"
            raise ValueError(msg)
        if values.get("trees", "keep") not in ("keep", "none", "lidar", "scattered"):
            msg = f"Unknown trees rule {values['trees']!r}"
            raise ValueError(msg)
        return cls(**values)


@dataclass(frozen=True)
class SymbolSet:
    """A symbol standard and the rules for its symbols."""

    name: str
    rules: Mapping[str, SymbolRule]

    @classmethod
    def load(cls, key: str) -> SymbolSet:
        """Load a bundled table, for example ``"isom2000"``."""
        text = (
            resources.files("otest.symbols").joinpath(f"{key}.toml").read_text("utf-8")
        )
        table = tomllib.loads(text)
        rules = {num: SymbolRule.from_table(e) for num, e in table["symbols"].items()}
        return cls(name=str(table["name"]), rules=rules)

    def rule(self, number: str) -> SymbolRule | None:
        """Return the rule for symbol ``number`` (like ``"406.1"``), or None.

        Examples:
            >>> isom = SymbolSet.load("isom2000")
            >>> isom.rule("509.2").track, isom.rule("509.1").track
            ('gravel', 'faint_path')
            >>> isom.rule("801.3") is None
            True
        """
        exact = self.rules.get(number)
        if exact is not None:
            return exact
        base = number.split(".")[0]
        return self.rules.get(base)


def detect_symbol_set(area_symbols: set[str]) -> str:
    """Guess the symbol standard from the area symbols a map uses.

    Buildings are the clearest sign: symbol 526 in ISOM 2000 and 521 in ISOM 2017.

    Args:
        area_symbols: Base numbers (``"526"``) of the map's area symbols.

    Returns:
        ``"isom2017"`` or ``"isom2000"`` (the default).

    Examples:
        >>> detect_symbol_set({"301", "521", "406"})
        'isom2017'
        >>> detect_symbol_set({"526", "527"})
        'isom2000'
    """
    if "521" in area_symbols and "526" not in area_symbols:
        return "isom2017"
    return "isom2000"
