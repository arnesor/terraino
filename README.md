# Terrain-O

_Orienteering in real terrain, in 3D on your computer._

[![Tests](https://github.com/arnesor/terraino/actions/workflows/tests.yml/badge.svg)][tests]
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=arnesor_terraino&metric=coverage)][sonarcov]
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=arnesor_terraino&metric=alert_status)][sonarquality]

[![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen?logo=pre-commit&logoColor=white)][pre-commit]
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![uv](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/uv/main/assets/badge/v0.json)](https://github.com/astral-sh/uv)

[tests]: https://github.com/arnesor/terraino/actions?workflow=Tests
[sonarcov]: https://sonarcloud.io/summary/overall?id=arnesor_terraino
[sonarquality]: https://sonarcloud.io/summary/overall?id=arnesor_terraino
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
- Building outlines and roof lines traced from Kartverket's topographic map
  (the same buildings as on norgeskart.no), with OSM and the orienteering map where it has none.
  Roofs come from the laser where it saw a roof, otherwise from the map's roof lines.
- Buildings with textured walls (cladding with windows, boards, logs) and roof tiles,
  their kind, colours and floors from the building type registered in Matrikkelen
  (white farmhouses, red barns, dark cabins, garages matching the house they belong to).
- Ground from the map (forest floor, open land, marsh, fields, paths, roads, water),
  and from NIBIO AR5 land cover outside the map.
- Buildings from OpenStreetMap and the map, with heights and gable roofs
  measured from the laser data.
- Boulders (at least 1 m high, large ones 2 m), waterholes with water, cliffs, stone walls, fences,
  power lines and towers from the map,
  with power line poles on the masts registered in Kartverket's topographic map.
  Cliffs are near-vertical rock faces, at least 1 m high, carved into the terrain.
- Roads and paths drawn as their own soft-edged strips on the terrain,
  with distinct junctions joined and nothing growing on them.
  Footpaths show roots and stones; footbridges and log crossings carry them over streams.
- Browser viewer (Three.js): walk, run and fly, with shadows, runnability,
  a compass, the orienteering map with your position, and courses with timing.
- Courses from OCAD course setting files, with the IOF control description table
  on the map and on screen, each flag placed where its description says
  (north side of the boulder, west foot of the hill),
  and start and finish banners.
- English and Norwegian user interface.
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
uv run terraino build path/to/map.ocd
npm run dev --prefix viewer
```

Open <http://localhost:5173/> and click to start.
The world is written to `worlds/<map name>/`; use `--out` to choose another folder.
A build of a 5 x 5 km map takes about a minute once the data is downloaded.

Image maps need their georeferencing: a KMZ overlay or GeoTIFF has it,
a JPG or PNG needs a world file (`.jgw`/`.pgw`) next to it
and the coordinate system given with `--epsg`:

```console
uv run terraino build map.jpg --epsg 25832
```

Image maps are read by their colours, which works well for areas
(forest, open land, green, water, marsh, fields)
but cannot find boulders, cliffs and other point features.

Useful build options (see `uv run terraino build --help`):

- `--offset DX DY` shifts the map east/north if its georeferencing is off.
- `--margin` sets how much terrain to include around the map (default 300 m).
  Terrain more than 100 m from the map is stored at 4 m instead of 1 m,
  which halves what the viewer downloads before it starts.
- `--sr16-dir` points to SR16 GeoTIFFs downloaded from Geonorge (or set `TERRAINO_SR16_DIR`);
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
uv run terraino build map.ocd --lidar ~/hoydedata/5pkt-2016 --lidar ~/hoydedata/2pkt-2016
```

Or set `TERRAINO_LIDAR_DIRS` to the folders separated by `:`.
Reading them takes about a minute; the result is cached in `data-cache/lidar/`.

Maps must be georeferenced in UTM zone 32, 33 or 35 (ETRS89 or WGS 84).

### In the viewer

| Key         | Action                                            |
| ----------- | ------------------------------------------------- |
| W A S D     | Move                                              |
| Mouse       | Look around                                       |
| E / Q       | Time factor up / down: game time runs up to 10 times as fast |
| F           | Fly on/off; look up or down to climb or dive      |
| M           | Map window: drag to move, wheel to zoom, double click to go there |
| H           | Pause, on the start screen: choose another map or course |
| K           | Control descriptions on/off                       |
| N           | With the map open: set a course by clicking (or Set course) |
| L           | Copy a link to the course                         |
| T           | Go to the start, behind the start banner; R restarts the run |
| O           | Orienteering map on the ground on/off             |
| G           | Graphics quality: high, medium, low               |
| Esc         | Pause (while steering with the map open, the first Esc gives the mouse to the map) |

The map window frees the mouse so you can drag, zoom and double click in it,
and you can keep running with W A S D. Click the terrain to steer with the mouse again
while the map stays open, and press Esc to give the mouse back to the map.
Esc again, or H at any time, pauses the game on the start screen,
where game time stands still and you can choose another map or course.
Auto turns the map with your running direction; ⟲, ⟳ and N↑ turn it by hand.
Close the map with M or ✕.
With a course, **Legs** (on by default) zooms the map to the leg you are on and the next one,
and glides on to the next legs when you punch a control;
dragging or zooming the map turns it off until you press Legs again.
The compass in the map's corner is held as you look: its needle points north in the terrain,
and its dial turns with the map.
Turn the map (⟲ ⟳) until the dial's N and the meridians lie along the needle,
and the map matches the terrain; Auto keeps it that way.
Auto, Legs and Position are remembered.

To run a course from an OCAD course setting file
(OCAD 12 or newer),
press **Open course file …** on the start screen, choose the `.ocd` file and pick a course.
You are put a few metres behind the start, looking at the start banner and the start control.
All the controls in the file stand in the terrain, not only those on your course,
so check the code before you punch.
The course is not kept when you reload the page: open the file again, or use a link to it (L).
The control description table is shown on screen while you run
(K turns it on and off), with the next control highlighted.
Each flag stands where its description says: column G
(north side, west foot, south-east corner …)
puts it on that side of the feature from column D
(boulder, building, cliff, wall, hill …) found in the 3D world.
Each control shows its code on plates on both sides of the stand, readable from a few metres,
and the start and finish have a control and a banner.

To set a course yourself, open the map (M), press N
(or Set course) and click the start, the controls and the finish.
The clock starts when you leave the start triangle,
and each control is punched when you get within 2.5 m of the flag.

Only runs in **Competition** mode (the button under the map) go on the course's results list.
During such a run there is no help beyond the map and the compass: no position on the map,
no map that follows you, no coordinates, no flying, no jumps on the map and no map on the ground.
At the finish you give your name, and the results list opens: leg and split times with their places,
as on WinSplits, sorted by run time or, from a column header, by a leg or split time.
Tick a result to see its route on the map; several routes can be compared.
**Results** on the start screen opens the list of the chosen course.
The same course, from a file, a link or set by hand, shares one list.
The lists are kept by the viewer's server in `results/`, next to `worlds/`,
and everyone playing through the same server shares them
(see `docs/adr/0001-results-stored-by-the-vite-server.md`).

The start screen has a language choice (English or Norwegian); the keys are the same in both.
All texts are in `viewer/src/i18n.ts`: to add a language, add it to `LANGS`,
and `npm run typecheck --prefix viewer` lists the texts that still need translating.

The URL can hold a viewpoint and a course,
for example `?world=langvatnet&at=665560,6644900,150&look=0,-20`: `at` is easting,
northing and an optional height above ground
(which turns on flying),
`look` is the compass heading and pitch in degrees,
`course` is a list of `easting,northing` pairs separated by `;`, and `lang` is the language
(`en` or `nb`).

## Development

Please see the [Contributor Guide] for details on running development tasks.
Run the same checks as CI with:

```console
uv run pre-commit run --all-files
uv run mypy src tests
uv run deptry .
uv run pytest
npm run typecheck --prefix viewer
npm test --prefix viewer
```

The tests run without network access:
`tests/fixtures/` holds a small map with every file its build downloads,
and both `uv run pytest` and `npm test --prefix viewer` build its world from them.
The tests that build it are skipped (Python) or fail (viewer) if the OCAD exporter
(`npm ci --prefix tools/ocad-export`) is not installed.
`uv run pytest -m network` also runs the build against the live services.

Git hooks run outside the uv environment unless it is active,
so commit with `uv run git commit` or activate `.venv` first.

How the map symbols become 3D is set in `src/terraino/symbols/*.toml`,
one table per symbol standard.

The control description symbols in `viewer/src/descriptions/symbols.json` are converted from
[Purple Pen]'s `symbols.xml` with
`uv run scripts/convert_symbols.py symbols.xml viewer/src/descriptions/symbols.json`.
How OCAD's description codes map to IOF symbols
and directions is in `viewer/src/descriptions/codes.ts`.

## Data sources and licences

| Data                          | Source                                         | Licence     |
| ----------------------------- | ---------------------------------------------- | ----------- |
| Terrain and surface (1 m)     | Kartverket, Nasjonal høydemodell (WCS)          | CC BY 4.0   |
| Tree species and tree count   | NIBIO, SR16 skogressurskart (WMS or GeoTIFF)   | NLOD 2.0    |
| Land cover outside the map    | NIBIO, AR5 arealressurskart (WMS)              | NLOD 2.0    |
| Buildings, roads, water       | OpenStreetMap (Overpass API)                   | ODbL        |
| Laser point clouds (optional) | Kartverket, hoydedata.no (downloaded by hand)  | CC BY 4.0   |
| Building types                | Kartverket, Matrikkelen bygningspunkt (WFS)    | CC BY 4.0   |
| Building outlines, roof lines | Kartverket, Topografisk Norgeskart (WMS)       | CC BY 4.0   |
| Orienteering map              | Your map file                                  | Map owner's |

The OCAD reader in `tools/ocad-export` uses [ocad2geojson], which is licensed under AGPL-3.0,
and so is that tool.
The Python package runs it as a separate program.
The viewer reads course setting files with its own reader (`viewer/src/ocad`).

The control description symbols come from [Purple Pen]
(© Peter Golde, BSD licence, see `viewer/src/descriptions/LICENSE-PurplePen.txt`).

Not used yet: road widths from NVDB.

[ocad2geojson]: https://github.com/perliedman/ocad2geojson
[Purple Pen]: https://github.com/petergolde/PurplePen

## Contributing

Contributions are very welcome.
To learn more, see the [Contributor Guide].

## License

Distributed under the terms of the [MIT license][license],
_Terrain-O_ is free and open source software.

## Issues

If you encounter any problems, please [file an issue] along with a detailed description.

## Credits

This project was generated with the [Python uv project template].

The procedural textures and the tree,
bush and rock models in `viewer/src/vendor` come from [Orienteering 3D]
(MIT licence, see `viewer/src/vendor/LICENSE`).

[orienteering 3d]: https://claude.ai/artifact/A8dqe89rvxzyN29Az3W29D

[python uv project template]: https://github.com/arnesor/uv-template
[file an issue]: https://github.com/arnesor/terraino/issues
<!-- github-only -->

[license]: https://github.com/arnesor/terraino/blob/main/LICENSE
[contributor guide]: https://github.com/arnesor/terraino/blob/main/CONTRIBUTING.md
