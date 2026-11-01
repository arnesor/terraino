"""Test cases for the __main__ module."""

from pathlib import Path

import pytest
from click.testing import CliRunner

from terraino import __main__
from terraino.build import BuildOptions


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
    options = (
        "--out",
        "--name",
        "--owner",
        "--margin",
        "--offset",
        "--cache-dir",
        "--sr16-dir",
        "--epsg",
    )
    for option in (*options, "--symbols", "--no-forest", "--spawn", "--heading"):
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


def test_heading_must_be_a_compass_direction(runner: CliRunner, tmp_path: Path) -> None:
    ocad = tmp_path / "map.ocd"
    ocad.write_bytes(b"")
    args = ["build", str(ocad), "--out", str(tmp_path), "--heading", "360"]
    result = runner.invoke(__main__.main, args)
    assert result.exit_code == 2
    assert "--heading" in result.output


@pytest.fixture
def built(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Path, BuildOptions]]:
    """The folder and options of each build, without building."""
    calls: list[tuple[Path, BuildOptions]] = []

    def build_world(_map_path: Path, out: Path, options: BuildOptions) -> Path:
        calls.append((out, options))
        return out / "manifest.json"

    monkeypatch.setattr(__main__, "build_world", build_world)
    return calls


@pytest.mark.parametrize(
    ("args", "folder", "name"),
    [
        ([], Path("worlds/Langvatnet_261025"), "Langvatnet_261025"),
        (["--name", " Langvatnet "], Path("worlds/Langvatnet"), "Langvatnet"),
        (
            ["--name", "Langvatnet", "--out", "elsewhere"],
            Path("elsewhere"),
            "Langvatnet",
        ),
    ],
)
def test_world_is_named_after_the_map_file_or_name(
    runner: CliRunner,
    tmp_path: Path,
    built: list[tuple[Path, BuildOptions]],
    args: list[str],
    folder: Path,
    name: str,
) -> None:
    ocad = tmp_path / "Langvatnet_261025.ocd"
    ocad.write_bytes(b"")
    result = runner.invoke(__main__.main, ["build", str(ocad), *args])
    assert result.exit_code == 0, result.output
    [(out, options)] = built
    assert out == folder
    assert options.name == name


@pytest.mark.parametrize("name", ["", "  ", "a/b", "..", "Lang:vatnet"])
def test_name_must_be_a_folder_name(
    runner: CliRunner,
    tmp_path: Path,
    built: list[tuple[Path, BuildOptions]],
    name: str,
) -> None:
    ocad = tmp_path / "map.ocd"
    ocad.write_bytes(b"")
    result = runner.invoke(__main__.main, ["build", str(ocad), "--name", name])
    assert result.exit_code == 2
    assert "--name" in result.output
    assert not built


@pytest.mark.parametrize(
    ("args", "owner"),
    [([], None), (["--owner", " Eidskog OL "], "Eidskog OL"), (["--owner", " "], None)],
)
def test_owner_is_passed_to_the_build(
    runner: CliRunner,
    tmp_path: Path,
    built: list[tuple[Path, BuildOptions]],
    args: list[str],
    owner: str | None,
) -> None:
    ocad = tmp_path / "map.ocd"
    ocad.write_bytes(b"")
    result = runner.invoke(__main__.main, ["build", str(ocad), *args])
    assert result.exit_code == 0, result.output
    [(_, options)] = built
    assert options.owner == owner
