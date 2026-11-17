"""Test cases for the __main__ module."""

from pathlib import Path

import pytest
from click.testing import CliRunner

from terraino import __main__
from terraino.build import BuildOptions
from terraino.ingest.georef import Extent


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


AREA = ["193986", "6622759", "196356", "6625129"]


def test_area_builds_a_mapless_world(
    runner: CliRunner, built: list[tuple[Path, BuildOptions]]
) -> None:
    args = ["build", "--area", *AREA, "--name", "Kongsberg"]
    result = runner.invoke(__main__.main, args)
    assert result.exit_code == 0, result.output
    [(out, options)] = built
    assert out == Path("worlds/Kongsberg")
    assert options.area == Extent(193986, 6622759, 196356, 6625129)
    assert options.name == "Kongsberg"


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ([], "Give either MAP_PATH or --area"),
        (["--area", *AREA], "needs --name"),
        (
            ["--area", *AREA, "--name", "K", "--owner", "Kongsberg OK"],
            "--owner belongs",
        ),
        (["--area", *AREA, "--name", "K", "--offset", "1", "2"], "--offset belongs"),
        (["--area", *AREA, "--name", "K", "--epsg", "25832"], "--epsg belongs"),
        (["--area", "193986", "6622759", "205073", "6628020"], "at most 25 km²"),
        (["--area", "196356", "6622759", "193986", "6625129"], "XMIN < XMAX"),
    ],
)
def test_area_is_checked(
    runner: CliRunner,
    built: list[tuple[Path, BuildOptions]],
    args: list[str],
    message: str,
) -> None:
    result = runner.invoke(__main__.main, ["build", *args])
    assert result.exit_code == 2
    assert message in result.output
    assert not built


def test_map_and_area_exclude_each_other(
    runner: CliRunner, tmp_path: Path, built: list[tuple[Path, BuildOptions]]
) -> None:
    ocad = tmp_path / "map.ocd"
    ocad.write_bytes(b"")
    args = ["build", str(ocad), "--area", *AREA, "--name", "K"]
    result = runner.invoke(__main__.main, args)
    assert result.exit_code == 2
    assert "either MAP_PATH or --area" in result.output
    assert not built


def test_pick_area_prints_what_to_do_next(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    def pick(margin: float, _announce: object) -> Extent:
        assert margin == 200
        return Extent(193986, 6622759, 196356, 6625129)

    monkeypatch.setattr(__main__, "pick", pick)
    result = runner.invoke(__main__.main, ["pick-area", "--margin", "200"])
    assert result.exit_code == 0, result.output
    assert result.output.splitlines() == [
        "Area: 5.62 km² (2370 × 2370 m), EUREF89 UTM33",  # noqa: RUF001
        (
            "hoydedata.no (UTM33, incl. 200 m margin):"
            " xmin=193780 xmax=196560 ymin=6622550 ymax=6625330"
        ),
        (
            "terraino build --area 193986 6622759 196356 6625129 --margin 200"
            " --name <NAME> --lidar <LAZ folder>"
        ),
    ]


def test_pick_area_says_when_nothing_was_chosen(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(__main__, "pick", lambda _margin, _announce: None)
    result = runner.invoke(__main__.main, ["pick-area"])
    assert result.exit_code == 0
    assert result.output == "No area chosen.\n"
