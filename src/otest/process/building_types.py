"""What a building's type (Matrikkelen, NS 3457) means for its look.

The type decides the kind of building (house, farmhouse, cabin, garage, barn ...), its
colours and its default size. Colours follow Norwegian building traditions: farmhouses
mostly white, barns Falu red, cabins dark stained, churches white. Buildings older than
1900 (SEFRAK) lean to the old colours, and old cabins and summer farms may have turf
roofs.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass

# A floor of a house, and the plinth below the first floor, in metres.
FLOOR_M = 2.7
PLINTH_M = 0.4
TURF = "#5f6b3c"


@dataclass(frozen=True)
class Style:
    """Look of one kind of building.

    Attributes:
        walls: Wall colours (sRGB hex) with weights.
        roofs: Roof colours with weights.
        old_walls: Wall colours for buildings older than 1900, or None for ``walls``.
        old_roofs: Roof colours for old buildings, or None for ``roofs``.
        floors: Floors, when no laser data gives the height.
        wall: Wall height in metres, when no laser data gives it.
        roof: Roof height above the walls, when no laser data gives it.
        turf: Share of old buildings of this kind with a turf roof.
    """

    walls: Sequence[tuple[str, int]]
    roofs: Sequence[tuple[str, int]]
    old_walls: Sequence[tuple[str, int]] | None = None
    old_roofs: Sequence[tuple[str, int]] | None = None
    floors: int = 1
    wall: float = 4.0
    roof: float = 2.0
    turf: float = 0.0


_DARK_ROOFS = [("#2c2c2e", 6), ("#3d3f42", 3), ("#55524e", 1)]
_OLD_ROOFS = [("#7a3527", 4), ("#2c2c2e", 3), ("#5a4a40", 2)]
_HOUSE_WALLS = [
    ("#f2f0e8", 6),  # white
    ("#d9d8d0", 2),  # light grey
    ("#ead9a0", 2),  # pale yellow
    ("#d9b25c", 1),  # ochre
    ("#b33a2c", 1),  # red
    ("#9fb0b8", 1),  # grey-blue
    ("#6b5a48", 1),  # brown stain
]
_RED = [("#9e2f24", 8), ("#7d2a22", 3), ("#a8a59c", 1), ("#e8e4da", 1)]
_CABIN = [
    ("#5a4636", 4),
    ("#3f342b", 2),
    ("#8a3a2a", 2),
    ("#6e6a5a", 1),
    ("#7a6a4a", 1),
]

STYLES: dict[str, Style] = {
    "house": Style(
        _HOUSE_WALLS, [*_DARK_ROOFS, ("#7a3527", 2)], floors=2, wall=5.0, roof=2.8
    ),
    "farmhouse": Style(
        [
            ("#f4f2ea", 8),
            ("#ead9a0", 2),
            ("#d9b25c", 1),
            ("#d9d8d0", 1),
            ("#b33a2c", 1),
        ],
        [*_DARK_ROOFS, ("#7a3527", 2)],
        old_roofs=_OLD_ROOFS,
        floors=2,
        wall=5.6,
        roof=3.2,
    ),
    "cabin": Style(
        _CABIN,
        _DARK_ROOFS,
        old_walls=[("#4e3c2e", 4), ("#7a2f22", 2), ("#3a3028", 2)],
        floors=1,
        wall=2.7,
        roof=1.8,
        turf=0.4,
    ),
    "summer_farm": Style(
        [("#4e3c2e", 4), ("#7a2f22", 2), ("#3a3028", 2)],
        _DARK_ROOFS,
        floors=1,
        wall=2.5,
        roof=1.6,
        turf=0.6,
    ),
    "garage": Style(_HOUSE_WALLS, _DARK_ROOFS, floors=1, wall=2.6, roof=1.2),
    "shed": Style(_RED, _DARK_ROOFS, floors=1, wall=2.3, roof=0.9),
    "boathouse": Style(
        _RED, [*_DARK_ROOFS, ("#7a3527", 1)], floors=1, wall=2.6, roof=2.0
    ),
    "barn": Style(
        _RED,
        [*_DARK_ROOFS, ("#7a3527", 1)],
        old_walls=[("#8a2a20", 5), ("#6e3a2a", 2), ("#8c8576", 1)],
        old_roofs=_OLD_ROOFS,
        floors=2,
        wall=5.5,
        roof=3.8,
    ),
    "farm_auxiliary": Style(
        _RED,
        _DARK_ROOFS,
        old_walls=[("#8a2a20", 4), ("#5a4636", 3)],
        old_roofs=_OLD_ROOFS,
        floors=1,
        wall=3.5,
        roof=2.4,
    ),
    "industry": Style(
        [("#a7a9a6", 4), ("#c9c7c0", 3), ("#7f8a8f", 2), ("#9e2f24", 1)],
        [("#3b3d40", 5), ("#6b6e70", 2)],
        floors=1,
        wall=6.0,
        roof=1.0,
    ),
    "church": Style(
        [("#f5f3ee", 1)], [("#2e3133", 3), ("#7a3527", 1)], floors=1, wall=7.0, roof=6.0
    ),
    "other": Style(
        [("#d9d6cc", 3), ("#9aa0a4", 2), ("#b33a2c", 1), ("#ead9a0", 1)],
        _DARK_ROOFS,
        floors=1,
        wall=4.0,
        roof=2.0,
    ),
}


def kind_for_type(code: int) -> str | None:
    """The kind of building of an NS 3457 building type, or None if it has no style.

    Examples:
        >>> kind_for_type(113), kind_for_type(181), kind_for_type(241), kind_for_type(671)
        ('farmhouse', 'garage', 'barn', 'church')
    """
    if code in (113, 123, 124, 163):
        return "farmhouse"
    if code in (161, 162):
        return "cabin"
    if code in (171, 172):
        return "summer_farm"
    if code in (181, 182, 441, 449):
        return "garage"
    if code in (183, 245):
        return "boathouse"
    if code in (241, 244):
        return "barn"
    if code in (243, 248, 249):
        return "farm_auxiliary"
    if 100 <= code < 200:
        return "house"
    if 200 <= code < 240:
        return "industry"
    if 670 <= code < 680:
        return "church"
    if 300 <= code < 1000:
        return "other"
    return None


def type_rank(code: int) -> int:
    """Which of several registered buildings in one footprint describes it best.

    Dwellings first, then farm buildings, then the rest; garages and outbuildings
    last, as they are often registered inside the house they are built onto.
    """
    kind = kind_for_type(code)
    order = ["house", "farmhouse", "cabin", "summer_farm", "church", "barn", "industry"]
    return order.index(kind) if kind in order else len(order) + (code in (181, 182))


def pick(options: Sequence[tuple[str, int]], seed: str) -> str:
    """Deterministic weighted choice: the same seed always gives the same value."""
    total = sum(w for _, w in options)
    r = (
        int(hashlib.md5(seed.encode(), usedforsecurity=False).hexdigest()[:8], 16)
        % total
    )
    for value, weight in options:
        if r < weight:
            return value
        r -= weight
    return options[-1][0]


def colours(kind: str, seed: str, old: bool) -> tuple[str, str]:
    """Wall and roof colour of a building of ``kind``.

    Examples:
        >>> colours("church", "x", old=False)[0]
        '#f5f3ee'
    """
    style = STYLES.get(kind, STYLES["other"])
    walls = style.old_walls if old and style.old_walls else style.walls
    roofs = style.old_roofs if old and style.old_roofs else style.roofs
    roof = pick(roofs, seed + "roof")
    if old and style.turf:
        chance = int(
            hashlib.md5((seed + "turf").encode(), usedforsecurity=False).hexdigest()[
                :4
            ],
            16,
        )
        if chance / 0xFFFF < style.turf:
            roof = TURF
    return pick(walls, seed), roof


def floors_for(kind: str, wall: float | None) -> int:
    """Number of floors: from the measured wall height, or the kind's default.

    Examples:
        >>> floors_for("house", 5.8), floors_for("house", 3.1), floors_for("cabin", None)
        (2, 1, 1)
    """
    if wall is None:
        return STYLES.get(kind, STYLES["other"]).floors
    return max(1, min(8, round((wall - PLINTH_M) / FLOOR_M)))
