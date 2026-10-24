# ocad-export

Exports an OCAD map to the files the Terrain-O pipeline reads: `meta.json`, `objects.geojson`,
`map.svg`, `map.png` and `drape.png`.
See the header of `export.mjs` for the options.

```console
npm ci
node export.mjs map.ocd out-dir
```

This tool uses [ocad2geojson](https://github.com/perliedman/ocad2geojson), which is licensed under AGPL-3.0.
This tool is therefore licensed under AGPL-3.0 too.
The `terraino` Python package only runs it as a separate program.
