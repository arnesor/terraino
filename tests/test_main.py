"""Test cases for the __main__ module."""

from pathlib import Path

import pytest
from click.testing import CliRunner

from otest import __main__


@pytest.fixture
def runner() -> CliRunner:
    """Fixture for invoking command-line interfaces."""
    return CliRunner()


def test_main_help_succeeds(runner: CliRunner) -> None:
    """It exits with a status code of zero."""
    result = runner.invoke(__main__.main, ["--help"])
    assert result.exit_code == 0
    assert "build" in result.output


def test_build_help_lists_options(runner: CliRunner) -> None:
    result = runner.invoke(__main__.main, ["build", "--help"])
    assert result.exit_code == 0
    options = ("--out", "--margin", "--offset", "--cache-dir", "--sr16-dir", "--epsg")
    for option in (*options, "--symbols", "--no-forest"):
        assert option in result.output


def test_build_rejects_other_file_types(runner: CliRunner, tmp_path: Path) -> None:
    document = tmp_path / "map.pdf"
    document.write_bytes(b"not a map")
    result = runner.invoke(
        __main__.main, ["build", str(document), "--out", str(tmp_path)]
    )
    assert result.exit_code != 0
    assert "Unsupported map file" in str(result.exception)


def test_image_without_georeference_is_reported(
    runner: CliRunner, tmp_path: Path
) -> None:
    image = tmp_path / "map.png"
    image.write_bytes(b"not an image")
    result = runner.invoke(__main__.main, ["build", str(image), "--out", str(tmp_path)])
    assert result.exit_code != 0
    assert "No georeference" in str(result.exception)
