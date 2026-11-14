"""How well the map lies on the ground: its buildings against Kartverket's.

A map whose georeference is a few metres off puts every road, building and vegetation
edge beside the terrain and the laser trees. A road drawn beside its bridge gets no deck
(terraino.process.bridges). Matching the map's buildings with Kartverket's finds the shift
that the build's ``--offset`` option can apply.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from shapely import Point, STRtree, get_coordinates
from shapely.geometry.base import BaseGeometry

# Buildings this far apart (m) at most, after the shift found so far, are the same one...
MATCH_M = 25.0
# ...if their areas differ by at most this factor.
AREA_FACTOR = 2.0
# Only buildings of at least this area (m²) are matched; sheds are too easily confused.
MIN_AREA_M2 = 20.0
# The worst matches beyond this share are left out of each fit as mismatches.
KEEP_SHARE = 0.85
ROUNDS = 10
# At least this many matched buildings make a fit.
MIN_MATCHES = 20


@dataclass(frozen=True)
class Alignment:
    """The shift that brings the map's buildings onto Kartverket's.

    Attributes:
        shift: Metres east and north to move the map by.
        before: Mean distance between matched buildings now, in metres.
        after: Mean distance after the shift.
        matched: Number of buildings matched.
    """

    shift: tuple[float, float]
    before: float
    after: float
    matched: int


def _centres(
    outlines: Sequence[BaseGeometry],
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    big = [g for g in outlines if g.area >= MIN_AREA_M2]
    if not big:
        return np.zeros((0, 2)), np.zeros(0)
    centres = get_coordinates([g.centroid for g in big])
    areas = np.array([g.area for g in big])
    return centres, areas


def align(
    outlines: Sequence[BaseGeometry], reference: Sequence[BaseGeometry]
) -> Alignment | None:
    """The shift of ``outlines`` onto ``reference``, or None if too few buildings match.

    Each building is matched with the nearest reference building of a similar size, after
    the shift found so far; the shift is the median of the matches' differences.

    Examples:
        >>> from shapely import box
        >>> truth = [box(x, y, x + 10, y + 8) for x in range(0, 500, 50) for y in range(0, 300, 60)]
        >>> drawn = [box(x - 6, y + 1, x + 4, y + 9) for x in range(0, 500, 50) for y in range(0, 300, 60)]
        >>> found = align(drawn, truth)
        >>> found.shift, round(found.before, 1), found.after
        ((6.0, -1.0), 6.1, 0.0)
    """
    points, areas = _centres(outlines)
    targets, target_areas = _centres(reference)
    if len(points) < MIN_MATCHES or len(targets) < MIN_MATCHES:
        return None
    tree = STRtree([Point(p) for p in targets])
    shift = np.zeros(2)
    matched = np.zeros(len(points), dtype=bool)
    nearest = np.zeros(len(points), dtype=np.int64)
    for _ in range(ROUNDS):
        moved = points + shift
        nearest = np.asarray(tree.nearest([Point(p) for p in moved]), dtype=np.int64)
        distance = np.hypot(*(targets[nearest] - moved).T)
        ratio = target_areas[nearest] / areas
        matched = (
            (distance < MATCH_M) & (ratio < AREA_FACTOR) & (ratio > 1 / AREA_FACTOR)
        )
        if matched.sum() < MIN_MATCHES:
            return None
        matched &= distance <= max(
            float(np.quantile(distance[matched], KEEP_SHARE)), 1.0
        )
        shift = np.median(targets[nearest][matched] - points[matched], axis=0)
    differences = targets[nearest][matched] - points[matched]
    return Alignment(
        shift=(round(float(shift[0]), 1), round(float(shift[1]), 1)),
        before=float(np.mean(np.hypot(*differences.T))),
        after=float(np.mean(np.hypot(*(differences - shift).T))),
        matched=int(matched.sum()),
    )


def worth_shifting(alignment: Alignment) -> bool:
    """True if the shift is large and clearly brings the buildings closer.

    Examples:
        >>> worth_shifting(Alignment((5.3, -0.8), before=5.7, after=2.7, matched=460))
        True
        >>> worth_shifting(Alignment((0.8, 0.2), before=2.4, after=2.3, matched=460))
        False
    """
    return (
        math.hypot(*alignment.shift) >= 2.0 and alignment.after < 0.7 * alignment.before
    )
