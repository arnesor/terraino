import numpy as np
import pytest

from otest.process.heights import fill_missing


def test_complete_grid_is_unchanged_copy() -> None:
    grid = np.arange(6, dtype=np.float32).reshape(2, 3)
    filled = fill_missing(grid)
    np.testing.assert_array_equal(filled, grid)
    assert filled is not grid


def test_missing_cells_take_nearest_value() -> None:
    grid = np.full((5, 5), np.nan, dtype=np.float32)
    grid[0, 0] = 100
    grid[4, 4] = 200
    filled = fill_missing(grid)
    assert not np.isnan(filled).any()
    assert filled[1, 0] == 100
    assert filled[4, 3] == 200


def test_all_missing_raises() -> None:
    with pytest.raises(ValueError, match="no data"):
        fill_missing(np.full((2, 2), np.nan, dtype=np.float32))
