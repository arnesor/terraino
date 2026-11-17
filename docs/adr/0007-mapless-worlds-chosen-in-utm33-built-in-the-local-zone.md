# Mapless worlds are chosen in UTM33, built in the local zone, with Kartverket's topographic map

A mapless world is built for a rectangle instead of an orienteering map.
The rectangle is given (`--area`) or drawn
(`terraino pick-area`)
in EUREF89 UTM33, because hoydedata.no takes its export corners in UTM33 for all of Norway:
at Kongsberg, in zone 32, its export box reads xmin 193986, not an easting near 532000.
The same four numbers can then be pasted into hoydedata.no and into the build.
The world itself is built in the UTM zone of the rectangle's centre
(32, 33 or 35),
as an orienteering map of the same place would be,
so grid north and the compass agree and a later o-map of the area fits the world.
The core area is the rectangle reprojected into that zone, a slightly turned quadrilateral,
and the world's extent is the box around it plus the margin.
With no orienteering map to drape on the ground or show in the map view,
the world uses Kartverket's topographic map
(`topo`, from their WMTS cache) for both, and the manifest says which kind of map the world has.

## Considered Options

- **Build the world in UTM33 too**: the rectangle would be the extent,
  but in western Norway grid north would be up to about 8° off and the scale 0.3 % off.
- **No map at all**: the viewer would hide the map view and the draped map,
  leaving the runner nothing to find their way by.
- **Generate a map from the DTM, roads and buildings**: closer to an orienteering map,
  but much more work than fetching one.

## Consequences

The hoydedata.no box printed for a world outside zone 33 is the UTM33 rectangle grown by the margin,
so the far corners of the world's extent may lack laser data;
they are coarse chunks away from the core area.
The manifest's map-area key becomes the core area and gains the map's kind,
so `FORMAT_VERSION` goes up.
