# SR16 fixtures

SR16 forest resource data © NIBIO,
licensed under the [Norwegian Licence for Open Government Data (NLOD)](https://data.norge.no/nlod/en),
downloaded from [Geonorge](https://www.geonorge.no) as county 34, EPSG:25832, raster.

- `sr16_34_SRRTRESLAG.tif`: the dominant tree species per 16 m square
  (1 spruce, 2 pine, 3 deciduous, -9999 not forest),
  cropped to the extent of `LangvatnetUtsnitt.ocd` plus 200 m.
  It was made with terraino2's `scripts/make_sr16_fixture.py`:

  ```console
  uv run scripts/make_sr16_fixture.py …/34_25832_sr16_RASTER tests/fixtures/sr16 \
      666337.6 6646045.6 667105.3 6646723.5 TRESLAG
  ```

The folder stands in for a downloaded SR16 folder
(`terraino build --sr16-dir`), which holds one GeoTIFF per layer.
