# Lidar fixtures

Laser data © Kartverket, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), downloaded from [hoydedata.no](https://hoydedata.no).

- `425/langvatnet-utsnitt.laz`: project 425 "NDH Eidskog 5pkt 2016",
  cropped to the extent of `LangvatnetUtsnitt.ocd` plus 100 m, with every 2nd point kept
  (about 6.5 points per m², like a "2pkt" project), dense enough to find individual trees.
  It was made with terraino2's `scripts/make_lidar_fixture.py`:

  ```console
  uv run scripts/make_lidar_fixture.py …/Langvatnet/425 tests/fixtures/lidar/425/langvatnet-utsnitt.laz \
      666437.6 6646145.6 667005.3 6646623.5 --keep-every 2 --keep-ground-every 2
  ```

Each folder stands in for one downloaded lidar project folder (`terraino build --lidar`).
