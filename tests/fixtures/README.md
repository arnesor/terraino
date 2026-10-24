# Test fixtures

Data for a small part of the Langvatnet orienteering map
(Eidskog, EPSG:25832), enough to build and load its world without network access.

- `ocad/LangvatnetUtsnitt.ocd`: a crop of the Langvatnet map (ISOM 2000, 1:10 000),
  mapped area 666537.6–666905.3 E, 6646245.6–6646523.5 N.
- `lidar/`: a laser point cloud of the map plus 100 m; see [its README](lidar/README.md).
- `sr16/`: SR16 tree species for the map plus 200 m; see [its README](sr16/README.md).
- `cache/`: every file the build downloads for this map, as a filled build cache (below).

The course `viewer/test/fixtures/TestCourseLangvatnet.ocd` is set on this map.

The lidar and SR16 extracts were made with `scripts/make_lidar_fixture.py`
and `scripts/make_sr16_fixture.py` in [terraino2](https://github.com/arnesor/terraino2).

## The fixture world

`tests/fixture_world.py` builds the world of this map from the fixtures alone,
with the settings in its `options()` and every download refused.
`tests/test_build_offline.py` checks the result,
and `viewer/test/world.test.ts` builds it with `uv run python -m tests.fixture_world OUT`
and loads it as the viewer does.

The cached file names depend on the world extent
(the build's `margin`) and, for OpenStreetMap, on the Overpass query.
When either changes, the offline build stops with `NetworkUsedError`.
Download the files again with:

```console
uv run python -m tests.fixture_world --refresh-cache
```

This keeps only the part of Kartverket's 1 km height model tiles inside the world, compressed,
since the build reads nothing else of them.
The pre-commit hooks leave `cache/` alone, so the files stay as the services sent them.

## Sources and licences of `cache/`

- `kartverket/`: terrain (DTM) and surface (DOM) height models,
  © Kartverket (Nasjonal høydemodell), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- `topo/`: building outlines (`fkb_bygning`) and masts (`ledning_punkt`)
  from Topografisk Norgeskart, © Kartverket, CC BY 4.0.
- `matrikkel/`: building points from Matrikkelen, © Kartverket, CC BY 4.0.
- `nibio/`: AR5 land cover, © NIBIO,
  [NLOD 2.0](https://data.norge.no/nlod/en/2.0).
- `osm/`: roads, paths and buildings from OpenStreetMap,
  © OpenStreetMap contributors, available under the
  [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
