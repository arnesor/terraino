"""What orienteering map symbols mean for the 3D world.

The meaning of each symbol is kept in TOML tables in ``terraino/symbols/``, one per symbol
standard. See ``isom2000.toml`` for a description of the keys.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, replace
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
# Symbols drawn on top of the vegetation that make it slower; see SymbolRule.speed_group.
SPEED_GROUPS = frozenset({"undergrowth", "wet", "stony"})
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
        "waterhole",
        "pit",
        "small_depression",
        "knoll",
        "elongated_knoll",
        "earth_wall",
        "contour",
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
    # Standing grain (barley, oats, wheat). The class has four bits: this is the last.
    GRAIN = 15


@dataclass(frozen=True)
class SymbolRule:
    """The 3D meaning of one map symbol.

    Attributes:
        ground: Ground class painted by the symbol, or None.
        trees: What happens to trees from the laser canopy under the symbol.
        narrow_trees: Tree rule instead of ``trees`` for long, narrow areas (see
            terraino.process.layers.is_narrow), or None: mappers often draw a row of
            trees along a road or field as a strip of the open land around it.
        young: Young trees added per 100 m².
        thicket: Thickets (dense clumps of young trees or brush, about 4 m tall)
            added per 100 m².
        shrubs: Undergrowth density, 0..1.
        speed: Running speed factor, or None to leave it unchanged.
        speed_group: Group (see SPEED_GROUPS) of a symbol drawn on top of the vegetation,
            such as undergrowth or marsh, or None. Within a group the topmost symbol
            counts, and the slowest of the groups and the symbol below them sets the
            speed. Other symbols replace the speed of everything below them.
        width: Real-world width in metres of a line symbol, or the side of a ruin drawn
            as a point, or None.
        clear: Width in metres of a tree-free strip along a line, or None.
        order: Drawing order; higher values are painted on top.
        feature: 3D object placed for the symbol (see FEATURES), or None.
        size: Size of the feature in metres, or None for its default.
        overprint: The symbol is drawn on top of other areas (undergrowth patterns):
            it adds its shrubs and speed but keeps the ground and trees below.
        track: Style of a road or path drawn as its own strip on the terrain (see
            TRACKS), or None. Such lines set speed and clear trees, but do not paint
            the ground layer.
        grass_share: For grain: the share of the symbol's fields that grow grass (ley)
            instead. Which fields is picked at random, the same in every build.
        grass_speed: For grain: running speed in grass fields and in the grass verge
            along grain fields, or None for ``speed``.
        field_edge: A line between fields (a cultivation boundary): grain land is
            split into fields along it, with a grass verge.
    """

    ground: Ground | None = None
    trees: TreeRule = "keep"
    narrow_trees: TreeRule | None = None
    young: float = 0.0
    thicket: float = 0.0
    shrubs: float = 0.0
    speed: float | None = None
    speed_group: str | None = None
    width: float | None = None
    clear: float | None = None
    order: int = 0
    feature: str | None = None
    size: float | None = None
    overprint: bool = False
    track: str | None = None
    grass_share: float = 0.0
    grass_speed: float | None = None
    field_edge: bool = False

    def as_grass(self) -> SymbolRule:
        """The rule for grass fields and verges of a grain symbol.

        Examples:
            >>> grain = SymbolRule(ground=Ground.GRAIN, speed=0.5, grass_speed=0.7)
            >>> grass = grain.as_grass()
            >>> grass.ground.name, grass.speed
            ('FIELD', 0.7)
        """
        speed = self.speed if self.grass_speed is None else self.grass_speed
        return replace(
            self, ground=Ground.FIELD, speed=speed, grass_share=0.0, grass_speed=None
        )

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
        if values.get("speed_group") is not None and (
            values["speed_group"] not in SPEED_GROUPS
        ):
            msg = f"Unknown speed group {values['speed_group']!r}"
            raise ValueError(msg)
        if values.get("feature") is not None and values["feature"] not in FEATURES:
            msg = f"Unknown feature {values['feature']!r}"
            raise ValueError(msg)
        grain = values.get("ground") is Ground.GRAIN
        if not grain and ("grass_share" in values or "grass_speed" in values):
            msg = "grass_share and grass_speed are only for grain"
            raise ValueError(msg)
        for key in ("trees", "narrow_trees"):
            if values.get(key, "keep") not in ("keep", "none", "lidar", "scattered"):
                msg = f"Unknown trees rule {values[key]!r}"
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
            resources.files("terraino.symbols")
            .joinpath(f"{key}.toml")
            .read_text("utf-8")
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
