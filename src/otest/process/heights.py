"""Height grid post-processing."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
from scipy import ndimage


def fill_missing(grid: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Replace NaN cells with the value of the nearest cell that has data.

    Args:
        grid: Height grid with NaN where data is missing.

    Returns:
        A new grid without NaN.

    Raises:
        ValueError: If the grid has no data at all.

    Examples:
        >>> g = np.array([[1.0, np.nan, np.nan], [np.nan, np.nan, 5.0]], dtype=np.float32)
        >>> fill_missing(g).tolist()
        [[1.0, 1.0, 5.0], [1.0, 5.0, 5.0]]
    """
    missing = np.isnan(grid)
    if not missing.any():
        return grid.copy()
    if missing.all():
        msg = "The height grid has no data"
        raise ValueError(msg)
    _, (rows, cols) = ndimage.distance_transform_edt(
        missing, return_distances=True, return_indices=True
    )
    filled: npt.NDArray[np.float32] = grid[rows, cols]
    return filled
