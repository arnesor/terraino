# Otest

[![Tests](https://github.com/arnesor/otest/actions/workflows/tests.yml/badge.svg)][tests]
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=arnesor_otest&metric=coverage)][sonarcov]
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=arnesor_otest&metric=alert_status)][sonarquality]

[![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen?logo=pre-commit&logoColor=white)][pre-commit]
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![uv](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/uv/main/assets/badge/v0.json)](https://github.com/astral-sh/uv)

[tests]: https://github.com/arnesor/otest/actions?workflow=Tests
[sonarcov]: https://sonarcloud.io/summary/overall?id=arnesor_otest
[sonarquality]: https://sonarcloud.io/summary/overall?id=arnesor_otest
[pre-commit]: https://github.com/pre-commit/pre-commit

Build a walkable 3D world from a Norwegian orienteering map,
and run through it in the browser like in a first-person game.

## Features

- Reads OCAD maps (version 10–2018, ISOM 2000 and ISOM 2017) with their georeferencing,
  and image maps (JPG/PNG with a world file, KMZ overlays, GeoTIFF).
- Real terrain heights from Kartverket's national 1 m terrain model,
  instead of heights interpolated from contour lines.
- Individual trees from the laser surface model, with species from NIBIO SR16,
  thinned on open land and made denser where the map shows green.
- With a laser point cloud: sharper tree positions and true heights, each tree's crown
  size and how far down its live branches reach, undergrowth where the laser hits it,
  and roofs split into their planes, giving wings with gable, hipped, shed and flat
  roofs (cross gables, L- and T-shaped houses) and their eave and ridge heights.
- Buildings with textured walls (cladding with windows, boards, logs) and roof tiles.
- Ground from the map (forest floor, open land, marsh, fields, paths, roads, water),
  and from NIBIO AR5 land cover outside the map.
- Buildings from OpenStreetMap and the map, with heights and gable roofs
  measured from the laser data.
- Boulders, cliffs, stone walls, fences, power lines and towers from the map.
  Cliffs are near-vertical rock faces, at least 1 m high, carved into the terrain.
- Roads and paths drawn as their own soft-edged strips on the terrain,
  with distinct junctions joined and nothing growing on them.
  Footpaths show roots and stones; footbridges and log crossings carry them over streams.
- Browser viewer (Three.js): walk, run and fly, with shadows, runnability,
  a compass, the orienteering map with your position, and courses with timing.
- Textured spruce, pine and birch that sway in the wind, with impostors for distant trees,
  ground textures by ground type, and ground cover (blueberry, heather, fern, grass, sedge),
  bushes, fallen logs and twigs near the player.

## Requirements

- [uv](https://docs.astral.sh/uv/) (Python 3.12 or newer is installed by uv)
- [Node.js](https://nodejs.org/) 20 or newer
- An internet connection when building a world (data is cached in `data-cache/`)

## Installation

```console
uv sync
npm ci --prefix tools/ocad-export
npm ci --prefix viewer
uv run pre-commit install
```

## Usage

Build a world from a map, then start the viewer:

```console
uv run otest build path/to/map.ocd
npm run dev --prefix viewer
```

Open <http://localhost:5173/> and click to start.
The world is written to `worlds/<map name>/`; use `--out` to choose another folder.
A build of a 5 x 5 km map takes about a minute once the data is downloaded.

Image maps need their georeferencing: a KMZ overlay or GeoTIFF has it,
a JPG or PNG needs a world file (`.jgw`/`.pgw`) next to it
and the coordinate system given with `--epsg`:

```console
uv run otest build map.jpg --epsg 25832
```

Image maps are read by their colours, which works well for areas
(forest, open land, green, water, marsh, fields)
but cannot find boulders, cliffs and other point features.

Useful build options (see `uv run otest build --help`):

- `--offset DX DY` shifts the map east/north if its georeferencing is off.
- `--margin` sets how much terrain to include around the map (default 300 m).
- `--sr16-dir` points to SR16 GeoTIFFs downloaded from Geonorge (or set `OTEST_SR16_DIR`);
  they add the number of trees per hectare to the species from the SR16 web map.
- `--symbols` sets the symbol standard of an OCAD map if the guess is wrong.
- `--no-forest` builds the terrain only.
- `--lidar FOLDER` uses a laser point cloud (see below).

### Laser point clouds

Without them, trees and roofs come from Kartverket's 1 m height models.
Point clouds from [hoydedata.no](https://hoydedata.no/) give much more detail.
Download the projects covering the map (LAZ, "Punktsky") and unpack each into its own folder.
Give the folders with `--lidar`, the densest first; each place uses the first one that covers it:

```console
uv run otest build map.ocd --lidar ~/hoydedata/5pkt-2016 --lidar ~/hoydedata/2pkt-2016
```

Or set `OTEST_LIDAR_DIRS` to the folders separated by `:`.
Reading them takes about a minute; the result is cached in `data-cache/lidar/`.

Maps must be georeferenced in UTM zone 32, 33 or 35 (ETRS89 or WGS 84).

### In the viewer

| Key         | Action                                            |
| ----------- | ------------------------------------------------- |
| W A S D     | Move                                              |
| Mouse       | Look around                                       |
| Shift       | Run (fly fast)                                    |
| Space       | Jump (fly up)                                     |
| F           | Fly on/off, C flies down                          |
| M           | Map window: drag to move, wheel to zoom, double click to go there |
| E           | With the map open: set a course by clicking (or Set course) |
| L           | Copy a link to the course                         |
| T           | Go to the start; R restarts the run               |
| O           | Orienteering map on the ground on/off             |
| G           | Graphics quality: high, medium, low               |
| Esc         | Pause                                             |

The map window frees the mouse so you can drag, zoom and double click in it,
and you can keep running with W A S D. Click the terrain to steer with the mouse again
while the map stays open, and press Esc to give the mouse back to the map.
Auto turns the map with your running direction; ⟲, ⟳ and N↑ turn it by hand.
Close the map with M or ✕.

To run a course, open the map (M), press E
(or Set course) and click the start, the controls and the finish.
The clock starts when you leave the start triangle,
and each control is punched when you get within 2.5 m of the flag.

The URL can hold a viewpoint and a course,
for example `?world=langvatnet&at=665560,6644900,150&look=0,-20`: `at` is easting,
northing and an optional height above ground
(which turns on flying),
`look` is the compass heading and pitch in degrees,
and `course` is a list of `easting,northing` pairs separated by `;`.

## Development

Please see the [Contributor Guide] for details on running development tasks.
Run the same checks as CI with:

```console
uv run pre-commit run --all-files
uv run mypy src tests
uv run deptry .
uv run pytest
npm run typecheck --prefix viewer
```

`uv run pytest -m network` also runs an end-to-end build that downloads data.
It and the OCAD tests use the map in `OTEST_TEST_MAP` and are skipped if that file does not exist.

Git hooks run outside the uv environment unless it is active,
so commit with `uv run git commit` or activate `.venv` first.

How the map symbols become 3D is set in `src/otest/symbols/*.toml`, one table per symbol standard.

## Data sources and licences

| Data                          | Source                                         | Licence     |
| ----------------------------- | ---------------------------------------------- | ----------- |
| Terrain and surface (1 m)     | Kartverket, Nasjonal høydemodell (WCS)          | CC BY 4.0   |
| Tree species and tree count   | NIBIO, SR16 skogressurskart (WMS or GeoTIFF)   | NLOD 2.0    |
| Land cover outside the map    | NIBIO, AR5 arealressurskart (WMS)              | NLOD 2.0    |
| Buildings, roads, water       | OpenStreetMap (Overpass API)                   | ODbL        |
| Laser point clouds (optional) | Kartverket, hoydedata.no (downloaded by hand)  | CC BY 4.0   |
| Orienteering map              | Your map file                                  | Map owner's |

The OCAD reader in `tools/ocad-export` uses [ocad2geojson], which is licensed under AGPL-3.0,
and so is that tool.
The Python package runs it as a separate program.

Not used yet: road widths from NVDB.

[ocad2geojson]: https://github.com/perliedman/ocad2geojson

## Contributing

Contributions are very welcome.
To learn more, see the [Contributor Guide].

## License

Distributed under the terms of the [MIT license][license], _Otest_ is free and open source software.

## Issues

If you encounter any problems, please [file an issue] along with a detailed description.

## Credits

This project was generated with the [Python uv project template].

The procedural textures and the tree,
bush and rock models in `viewer/src/vendor` come from [Orienteering 3D]
(MIT licence, see `viewer/src/vendor/LICENSE`).

[orienteering 3d]: https://claude.ai/artifact/A8dqe89rvxzyN29Az3W29D

[python uv project template]: https://github.com/arnesor/uv-template
[file an issue]: https://github.com/arnesor/otest/issues
<!-- github-only -->

[license]: https://github.com/arnesor/otest/blob/main/LICENSE
[contributor guide]: https://github.com/arnesor/otest/blob/main/CONTRIBUTING.md
