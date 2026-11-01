# AGENTS.md

## What this is

Terrain-O builds a walkable 3D world from a Norwegian orienteering map
(OCAD or georeferenced image) and lets you run through it in a browser.
There are three parts:

- `src/terraino/`: Python pipeline (`uv run terraino build <map>`) that writes a world package
  to `worlds/<map name>/`.
- `viewer/`: TypeScript + Three.js + Vite app that renders a world package.
- `tools/ocad-export/`: Node script
  (AGPL, wraps `ocad2geojson`) that turns `.ocd` files into GeoJSON/SVG/PNG.
  Python runs it as a separate process (`ingest/ocad.py`) and never imports it,
  which keeps the Python package MIT.
  It needs `npm ci --prefix tools/ocad-export`.

## Commands

Setup:
`uv sync && npm ci --prefix tools/ocad-export && npm ci --prefix viewer && uv run pre-commit install`

The same checks as CI:

```console
uv run pre-commit run --all-files   # ruff check/format, rumdl (Markdown), yaml/json/toml checks
uv run mypy src tests               # strict mode
uv run deptry .
uv run pytest
uv run python -m xdoctest --modname=terraino --command=all
npm run typecheck --prefix viewer
npm test --prefix viewer            # vitest
```

- Run a single test: `uv run pytest tests/test_roofs.py::test_name`,
  or `npx vitest run test/tracks.test.ts` from inside `viewer/`.
- `pytest` skips `network`-marked tests by default (see `addopts`).
  `uv run pytest -m network` runs an end-to-end build that downloads data.
  The OCAD, offline build and network tests use the data in `tests/fixtures/` and are skipped
  if the OCAD exporter is not installed.
  `tests/fixture_world.py` builds the fixture world offline, from a cache of every download;
  see `tests/fixtures/README.md` for refreshing it.
- `viewer/test/world.test.ts` builds that world with `uv run` first,
  so the viewer tests need the Python environment and the OCAD exporter.
- Coverage: `uv run coverage run -m pytest && uv run coverage report`.
  It fails under 50%.
- Viewer dev server: `npm run dev --prefix viewer`, at <http://localhost:5173/>.
- Git hooks run outside the uv environment.
  Commit with `uv run git commit` or activate `.venv` first.

## Architecture

### Python pipeline (`src/terraino/`)

`__main__.py` (click CLI) → `build.build_world()` → `export.write_world()`.

- `ingest/`: reads the map source.
  `ocad.py` runs the Node exporter.
  `image.py`/`georef.py` read image maps with a world file, KMZ or GeoTIFF.
  `lidar.py` reads LAZ point clouds and caches the result in `data-cache/lidar/`.
- `fetch/`: downloads from Kartverket
  (DTM/DOM height models, topo buildings, masts, Matrikkelen),
  NIBIO (SR16 tree species, AR5 land cover) and OSM Overpass.
  Every download goes through `fetch/cache.py`, which caches files in `data-cache/`.
  Tests do not hit the network unless they are marked `network`.
- `process/`: turns the inputs into world content: ground layers, trees, buildings and roofs,
  map features, tracks, the map area, and fusion of buildings from several sources.
  `boundaries.py` makes distinct vegetation boundaries (416) visible in the trees
  (see `docs/adr/0004-map-wins-over-laser-at-vegetation-boundaries.md`).
- `build.py` hides the map format behind a `MapSource`:
  `_ocad_source` and `_image_source` both produce one,
  and the rest of the build (`_add_nature_and_buildings`) does not care which it came from.
- `symbols/isom2000.toml` and `isom2017.toml`, loaded by `process/symbols.py`,
  set what each map symbol becomes in 3D: ground class, running speed, tree density, feature,
  track style, and draw order.
  Change map-symbol behaviour here first, not in code.

### World package (the Python ↔ viewer contract)

The file layout, chunking (`CHUNK = 256` samples, plus coarse chunks away from the map),
binary formats and layer channel encoding are documented in the module docstring of
`src/terraino/export.py`.
`viewer/src/world.ts` reads the package.
The two sides must agree on several things:

- When the package format changes, bump `FORMAT_VERSION` in `export.py`
  and update `SUPPORTED_FORMATS` in `viewer/src/world.ts`.
- The `Ground` enum in `process/symbols.py` is copied in `viewer/src/layers.ts`
  and used by the terrain shader.
  Keep both copies in sync.
- Coordinates: scene x points east and z points south,
  both relative to the north-west height sample.

`viewer/vite.config.ts` serves `../worlds/` at `/worlds/`
(and `/worlds/index.json` lists them) and `../races/` at `/races/` in both dev and preview.
Worlds and races are never copied into `dist`;
`npm run deploy` (`viewer/scripts/deploy.ts`) adds them to the build it uploads to Cloudflare.

### Results Worker (`viewer/worker/`)

The viewer runs on Cloudflare at <https://terraino.arnesor.workers.dev>: the app,
worlds and races are static assets, and `worker/index.ts` answers `/results/`,
keeping results lists in the D1 database `terraino-results`
(see `docs/adr/0003-results-stored-in-d1-by-a-worker.md`).
`viewer/wrangler.jsonc` configures it, and `worker/migrations/` holds the schema.
`worker/results.ts` is the endpoint's contract and checks, shared with the browser,
so it must not use Workers types.
The Worker has its own `worker/tsconfig.json`,
with the binding and runtime types that `npm run types` writes to `worker-configuration.d.ts`
(not in git); `npm run typecheck` runs it first.
`npm run dev` runs the Worker through the Cloudflare Vite plugin with a local database;
the tests use `vitest.config.ts`, without that plugin.

### Viewer (`viewer/src/`)

`main.ts` starts the app.
`world.ts` loads chunks, and `terrain.ts`/`heightfield.ts` build the ground from them.
`forest.ts`, `undergrowth.ts`, `grain.ts`, `buildings.ts`,
`features.ts` and `tracks.ts` render content.
`player.ts` handles movement, and `hud.ts`/`mapview.ts` the UI and in-game map.
`clock.ts` keeps game time, which runs at the time factor (E/Q) and measures the run;
the game loop moves the player and the run on in its short steps.
`course.ts` and `ocad/` read OCAD course setting files with the viewer's own reader,
independent of `tools/ocad-export`.
`races.ts` checks that a course file fits a world and lists the races of a world;
`scripts/add-race.ts` (`npm run add-race`) adds one
(see `docs/adr/0002-races-kept-as-files-next-to-the-worlds.md`).
`descriptions/` holds the IOF control description table.
`results.ts` ranks results, finds the mistakes on each leg
(see `docs/adr/0005-mistakes-found-with-winsplits-time-loss-algorithm.md`)
and talks to the results endpoint;
`resultsView.ts` is the Finished panel and the results list window.
Competition mode (`Hud.restricted`) turns off every help during a run;
only competition runs can be saved.
`tutorial.ts` is the competition mode tutorial, opened from the map window.
`placement.ts` puts each flag on the side of the feature that its description names.

- All UI text is in `i18n.ts` (English and Norwegian).
  To add a language, add it to `LANGS`;
  `npm run typecheck` lists the texts and the flag still missing.
- `vendor/` (textures, tree/bush/rock models) comes from another project, under its own licence.
- `descriptions/symbols.json` is generated from Purple Pen's `symbols.xml` by
  `uv run scripts/convert_symbols.py symbols.xml viewer/src/descriptions/symbols.json`.
  `descriptions/codes.ts` maps OCAD description codes to IOF symbols.

## Conventions

- Python ≥ 3.12, strict mypy, ruff with Google-style docstrings
  (`D` rules), and an `S` (bandit) rule set.
  Subprocess calls carry an `# noqa: S603` with a reason.
- Markdown is checked by rumdl with semantic line breaks (one sentence or clause per line)
  and a 100-character line length.
- Maps must be in UTM zone 32, 33 or 35 (ETRS89/WGS 84).
  The build works in the map's projected EPSG throughout.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `arnesor/terraino` via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`.
See `docs/agents/domain.md`.
