"""Read an orienteering map image by its colours.

Each pixel is matched to the nearest ISOM print colour. Contours, course overprint and
other line work are ignored and take the class around them; black blobs are buildings,
long thin black lines paths; blue hatching is marsh and other blue lines streams. Each
class then gets the 3D meaning of the matching ISOM 2000 symbol.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import IntEnum

import numpy as np
import numpy.typing as npt
from rasterio.features import rasterize, shapes
from scipy import ndimage
from shapely import Polygon
from shapely.geometry import shape

from terraino.process.layers import TREE_RULES, GroundLayers, split_fields
from terraino.process.symbols import Ground, SymbolRule, SymbolSet


class Colour(IntEnum):
    """Map colour classes."""

    OTHER = 0
    WHITE = 1
    YELLOW = 2
    LIGHT_YELLOW = 3
    GREEN1 = 4
    GREEN2 = 5
    GREEN3 = 6
    WATER = 7
    BLUE_LINE = 8
    OLIVE = 9
    PEACH = 10
    GREY = 11
    BLACK = 12
    BROWN = 13
    PURPLE = 14


# Typical ISOM print colours in sRGB.
PALETTE: dict[Colour, list[tuple[int, int, int]]] = {
    Colour.WHITE: [(255, 255, 255)],
    Colour.YELLOW: [(255, 189, 86), (255, 186, 53)],
    Colour.LIGHT_YELLOW: [(255, 221, 167), (255, 230, 180)],
    Colour.GREEN1: [(195, 231, 201), (197, 255, 185)],
    Colour.GREEN2: [(138, 210, 151), (139, 220, 139)],
    Colour.GREEN3: [(63, 186, 90), (60, 170, 80)],
    Colour.WATER: [(132, 206, 239), (150, 220, 250)],
    Colour.BLUE_LINE: [(11, 167, 225), (0, 140, 210)],
    Colour.OLIVE: [(171, 167, 56), (160, 160, 60)],
    Colour.PEACH: [(241, 177, 126)],
    Colour.GREY: [(196, 197, 199), (170, 170, 170)],
    Colour.BLACK: [(44, 46, 53), (0, 0, 0)],
    Colour.BROWN: [(224, 113, 30), (190, 100, 40)],
    Colour.PURPLE: [(190, 60, 150), (166, 40, 140), (200, 0, 140)],
}
MAX_DISTANCE = 70.0

# The ISOM 2000 symbol whose meaning each area colour gets.
AREA_SYMBOLS = {
    Colour.WHITE: "405",
    Colour.YELLOW: "401",
    Colour.LIGHT_YELLOW: "403",
    Colour.GREEN1: "406",
    Colour.GREEN2: "408",
    Colour.GREEN3: "410",
    Colour.WATER: "301",
    Colour.OLIVE: "527",
    Colour.PEACH: "529",
    Colour.GREY: "212",
}
MARSH_SYMBOL = "310"
FIELD_SYMBOL = "415"
PATH_SYMBOL = "506"
STREAM_SYMBOL = "306"
BUILDING_SYMBOL = "526"

MIN_BUILDING_M2 = 20
# Buildings are drawn as rectangles; round boulder dots and letters fill less of their
# oriented bounding rectangle (a disc fills 79 %).
MIN_BUILDING_RECTANGULARITY = 0.86
# Letter strokes (I, l) are rectangles too, but long and thin.
MAX_BUILDING_ASPECT = 4.0
MIN_BUILDING_SIDE_M = 4.0
MIN_PATH_LENGTH_M = 15
MIN_MARSH_M2 = 150
# White gaps up to twice this many metres wide still belong to the mapped area.
MAP_GAP_M = 15
FILL_WINDOW = 9
# Blue hue: blue this much above red.
BLUE_MARGIN = 30
# Marsh: at least this share of blue line pixels within MARSH_WINDOW metres.
MARSH_WINDOW = 9
MARSH_DENSITY = 0.12
# Lakes: the blue tint varies less than this around each cell.
MAX_LAKE_STRIPES = 12.0
# Cultivated land: small dark dots (at most MAX_DOT_PX cells) at this density.
DOT_LUMINANCE = 130
MAX_DOT_PX = 12
FIELD_WINDOW = 15
FIELD_DOT_DENSITY = 0.015
# Straight lines this long, at most this many degrees off north, are north lines.
NORTH_LINE_MIN_M = 61
NORTH_LINE_MAX_DEG = 6


def _lookup_table() -> npt.NDArray[np.uint8]:
    """Nearest map colour for every RGB value quantised to 32 levels per channel."""
    levels = np.arange(32) * 8 + 4
    r, g, b = np.meshgrid(levels, levels, levels, indexing="ij")
    grid = np.stack([r, g, b], axis=-1).reshape(-1, 1, 3).astype(np.float32)
    colours = [(c, rgb) for c, values in PALETTE.items() for rgb in values]
    refs = np.array([rgb for _, rgb in colours], dtype=np.float32)
    distance = np.linalg.norm(grid - refs[None], axis=2)
    nearest = np.array([c for c, _ in colours], dtype=np.uint8)[distance.argmin(axis=1)]
    nearest[distance.min(axis=1) > MAX_DISTANCE] = Colour.OTHER
    table: npt.NDArray[np.uint8] = nearest.reshape(32, 32, 32)
    return table


_LUT = _lookup_table()


def classify_colours(rgb: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint8]:
    """Match every pixel to its nearest map colour (Colour values).

    Examples:
        >>> img = np.array([[[255, 255, 255], [254, 190, 88], [44, 46, 53]]], np.uint8)
        >>> classify_colours(img).tolist()
        [[1, 2, 12]]
    """
    q = rgb[..., :3] >> 3
    return np.asarray(_LUT[q[..., 0], q[..., 1], q[..., 2]], dtype=np.uint8)


@dataclass
class ClassifiedMap:
    """Ground layers read from an image map, plus what was found in it."""

    layers: GroundLayers
    buildings: list[Polygon]
    map_area: Polygon


def _fill_from_neighbours(
    classes: npt.NDArray[np.uint8], keep: npt.NDArray[np.bool_]
) -> npt.NDArray[np.uint8]:
    """Give cells where ``keep`` is False the most common kept class around them."""
    area_classes = list(AREA_SYMBOLS)
    scores = np.stack(
        [
            ndimage.uniform_filter(
                ((classes == c) & keep).astype(np.float32), FILL_WINDOW
            )
            for c in area_classes
        ]
    )
    best = np.array(area_classes, dtype=np.uint8)[scores.argmax(axis=0)]
    filled = classes.copy()
    filled[~keep] = best[~keep]
    # Cells far from any area colour are white (forest).
    filled[~keep & (scores.max(axis=0) == 0)] = Colour.WHITE
    return filled


def _line_element(length: int, degrees: float) -> npt.NDArray[np.bool_]:
    """A one-pixel line through the centre, ``degrees`` off vertical."""
    half = length // 2
    element = np.zeros((length, length), dtype=bool)
    t = np.arange(-half, half + 1)
    a = math.radians(degrees)
    rows = np.clip(np.round(half + t * math.cos(a)).astype(int), 0, length - 1)
    cols = np.clip(np.round(half + t * math.sin(a)).astype(int), 0, length - 1)
    element[rows, cols] = True
    return element


def _straight_lines(mask: npt.NDArray[np.bool_]) -> npt.NDArray[np.bool_]:
    """Pixels on long, straight, nearly north-south lines (magnetic north lines)."""
    straight = np.zeros_like(mask)
    for degrees in range(-NORTH_LINE_MAX_DEG, NORTH_LINE_MAX_DEG + 1, 2):
        element = _line_element(NORTH_LINE_MIN_M, degrees)
        straight |= ndimage.binary_opening(mask, structure=element)
    return straight


def _building_shaped(polygon: Polygon) -> bool:
    """True for a solid black shape that looks like a building symbol.

    Examples:
        >>> from shapely import Point, box
        >>> _building_shaped(box(0, 0, 10, 6)), _building_shaped(box(0, 0, 30, 4))
        (True, False)
        >>> _building_shaped(Point(0, 0).buffer(4))
        False
    """
    if polygon.area < MIN_BUILDING_M2:
        return False
    rect = polygon.minimum_rotated_rectangle
    if (
        not isinstance(rect, Polygon)
        or polygon.area < MIN_BUILDING_RECTANGULARITY * rect.area
    ):
        return False
    (x0, y0), (x1, y1), (x2, y2) = list(rect.exterior.coords)[:3]
    sides = sorted([math.hypot(x1 - x0, y1 - y0), math.hypot(x2 - x1, y2 - y1)])
    return (
        sides[0] >= MIN_BUILDING_SIDE_M and sides[1] <= MAX_BUILDING_ASPECT * sides[0]
    )


def _components(mask: npt.NDArray[np.bool_]) -> tuple[npt.NDArray[np.int32], int]:
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    return labels.astype(np.int32), int(count)


def _largest_area(mask: npt.NDArray[np.bool_], transform: object) -> Polygon:
    """Outline of the largest connected region of ``mask``, holes filled."""
    labels, count = _components(mask)
    if count == 0:
        msg = "The image has no map content"
        raise ValueError(msg)
    sizes = np.bincount(labels.ravel())[1:]
    region = ndimage.binary_fill_holes(labels == sizes.argmax() + 1)
    polygons = [
        shape(geometry)
        for geometry, value in shapes(region.astype(np.uint8), transform=transform)
        if value == 1
    ]
    largest = max((p for p in polygons if isinstance(p, Polygon)), key=lambda p: p.area)
    outline = Polygon(largest.exterior).simplify(1.0)
    return outline if isinstance(outline, Polygon) else Polygon(largest.exterior)


def classify_map(
    rgb: npt.NDArray[np.uint8],
    covered: npt.NDArray[np.bool_],
    transform: object,
    symbols: SymbolSet,
) -> ClassifiedMap:
    """Read ground layers, buildings and the mapped area from a map image.

    Args:
        rgb: The map resampled to the world's 1 m grid.
        covered: True where the image covers the grid.
        transform: Affine transform of the grid (for outlines).
        symbols: ISOM 2000 symbol rules.
    """
    colours = classify_colours(rgb)
    colours[~covered] = Colour.OTHER

    # Mapped area: everything with map colour, closed over small white gaps.
    ink = covered & (colours != Colour.WHITE) & (colours != Colour.OTHER)
    closed = ndimage.binary_closing(
        ink, structure=np.ones((3, 3), dtype=bool), iterations=MAP_GAP_M
    )
    in_map = ndimage.binary_fill_holes(closed) & covered
    map_area = _largest_area(in_map, transform)

    # Black: solid blobs are buildings, long thin lines are paths.
    black = colours == Colour.BLACK
    solid = ndimage.binary_opening(
        black, structure=np.ones((3, 3), dtype=bool), iterations=1
    )
    labels, count = _components(solid)
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    building = (sizes[labels] >= MIN_BUILDING_M2) & (labels > 0)
    building = ndimage.binary_dilation(building, iterations=1) & black
    footprints = [
        p
        for geometry, value in shapes(building.astype(np.uint8), transform=transform)
        if value == 1
        and isinstance(p := shape(geometry), Polygon)
        and _building_shaped(p)
    ]
    # Black blobs that are not buildings (boulders, letters) take the area around them.
    building = (
        rasterize(
            [(p, 1) for p in footprints],
            out_shape=building.shape,
            transform=transform,
            fill=0,
            dtype=np.uint8,
        ).astype(bool)
        if footprints
        else np.zeros_like(building)
    )
    thin = black & ~ndimage.binary_dilation(building, iterations=1)
    labels, count = _components(thin)
    extent_size = np.zeros(count + 1)
    for i, objects in enumerate(ndimage.find_objects(labels), start=1):
        if objects is not None:
            rows, cols = objects
            extent_size[i] = math.hypot(rows.stop - rows.start, cols.stop - cols.start)
    path = (extent_size[labels] >= MIN_PATH_LENGTH_M) & (labels > 0)
    # Magnetic north lines run straight across the map, a few degrees off grid north.
    path &= ~ndimage.binary_dilation(_straight_lines(thin), iterations=1)

    # Blue: solid areas are lakes, dense hatching is marsh, other lines streams.
    # Hue rather than exact colour, since thin lines blend with what is around them.
    r, g, b = (rgb[..., i].astype(np.int16) for i in range(3))
    blueish = covered & (b > r + BLUE_MARGIN) & (b + 10 >= g)
    # Lakes are smooth; marsh hatching blurred by a coarse scan is still stripy.
    tint = (b - r).astype(np.float32)
    mean = ndimage.uniform_filter(tint, 5)
    stripes = np.sqrt(
        np.maximum(ndimage.uniform_filter(tint * tint, 5) - mean * mean, 0)
    )
    smooth_water = (colours == Colour.WATER) & (stripes < MAX_LAKE_STRIPES)
    lake = ndimage.binary_opening(smooth_water, structure=np.ones((5, 5), dtype=bool))
    lake = ndimage.binary_dilation(lake, iterations=2) & blueish
    lines = blueish & ~lake
    density = ndimage.uniform_filter(lines.astype(np.float32), MARSH_WINDOW)
    hatch = ndimage.binary_closing(density >= MARSH_DENSITY, iterations=2)
    labels, count = _components(hatch)
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    marsh = (sizes[labels] >= MIN_MARSH_M2) & (labels > 0)
    stream = lines & ~marsh

    # Area colours count only where they form solid regions, not on blended edges.
    keep = np.zeros(colours.shape, dtype=bool)
    for colour in AREA_SYMBOLS:
        keep |= ndimage.binary_opening(
            colours == colour, structure=np.ones((3, 3), dtype=bool)
        )
    keep |= lake
    colours[lake] = Colour.WATER
    areas = _fill_from_neighbours(colours, keep)
    areas = ndimage.median_filter(areas, size=3)

    # Cultivated land is yellow with a regular pattern of small dark dots.
    luminance = 0.3 * r + 0.59 * g + 0.11 * b
    labels, count = _components((luminance < DOT_LUMINANCE) & ~path)
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    dots = (sizes[labels] <= MAX_DOT_PX) & (labels > 0)
    dot_density = ndimage.uniform_filter(dots.astype(np.float32), FIELD_WINDOW)
    field = (areas == Colour.YELLOW) & (dot_density >= FIELD_DOT_DENSITY)

    shape_ = rgb.shape[:2]
    ground = np.full(shape_, Ground.UNKNOWN, dtype=np.uint8)
    speed = np.ones(shape_, dtype=np.float32)
    young = np.zeros(shape_, dtype=np.float32)
    thicket = np.zeros(shape_, dtype=np.float32)
    shrubs = np.zeros(shape_, dtype=np.float32)
    tree_rule = np.zeros(shape_, dtype=np.uint8)

    def apply(
        mask: npt.NDArray[np.bool_], number: str | SymbolRule, vegetation: bool = True
    ) -> None:
        rule = symbols.rule(number) if isinstance(number, str) else number
        if rule is None:
            return
        if rule.ground is not None:
            ground[mask] = rule.ground
        if rule.speed is not None and rule.speed_group is not None:
            # Marsh lies on the vegetation: the slower of the two counts.
            speed[mask] = np.minimum(speed[mask], rule.speed)
        elif rule.speed is not None:
            speed[mask] = rule.speed
        if vegetation:
            young[mask] = rule.young
            thicket[mask] = rule.thicket
            shrubs[mask] = rule.shrubs
            tree_rule[mask] = TREE_RULES[rule.trees]

    for colour, number in AREA_SYMBOLS.items():
        apply(areas == colour, number)
    field_rule = symbols.rule(FIELD_SYMBOL)
    if field_rule is not None and field_rule.ground is Ground.GRAIN:
        grain, _ = split_fields(field & ~path & ~stream, field_rule.grass_share)
        apply(grain, field_rule)
        apply(field & ~grain, field_rule.as_grass())
    else:
        apply(field, FIELD_SYMBOL)
    apply(marsh & ~(areas == Colour.WATER), MARSH_SYMBOL, vegetation=False)
    apply(stream, STREAM_SYMBOL, vegetation=False)
    apply(path & (areas != Colour.WATER), PATH_SYMBOL, vegetation=False)
    apply(building, BUILDING_SYMBOL)

    path &= areas != Colour.WATER
    clear = ndimage.binary_dilation(path | stream, iterations=1) | building
    ground[~in_map] = Ground.UNKNOWN
    speed[~in_map] = 1.0
    young[~in_map] = 0
    thicket[~in_map] = 0
    shrubs[~in_map] = 0
    tree_rule[~in_map] = 0
    clear &= in_map

    layers = GroundLayers(
        ground=ground,
        speed=speed,
        young=young,
        thicket=thicket,
        shrubs=shrubs,
        tree_rule=tree_rule,
        clear=clear,
        in_map=in_map,
    )
    return ClassifiedMap(layers=layers, buildings=footprints, map_area=map_area)
