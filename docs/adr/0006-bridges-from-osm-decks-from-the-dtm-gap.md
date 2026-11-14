# Bridges come from OSM, decks from the gap in the DTM

Kartverket's terrain model (DTM) has bridge decks removed,
so a road on a bridge sinks to the level of the road or water under it: at Nordli bru in Magnor,
Rv2 drops 5.8 m into the underpass.
The build therefore makes bridges as decks of their own, which a runner can cross and pass under.
OSM's `bridge` and `layer` tags say where a bridge is and which road is on it,
as OSM is downloaded already and tagged every road bridge we checked on the Magnor map.
The deck's ends are where the DTM drops away steeply from the road and climbs back,
and its height is the straight line between them, since the OSM way runs well past the deck
(about 100 m against 35 m at Nordli bru)
and the surface model (DOM) also holds cars and branches over the road.
The DOM is used only to check the deck.
A valley the road runs through on the ground has no such walls, however deep.

A deck is built only where the DTM drops more than 0.5 m below that line;
shallower crossings stay on the ground.
Inside the mapped area an OSM bridge only marks a stretch of a road the map draws within 10 m of it,
in line with the map winning over other data
(see `0004-map-wins-over-laser-at-vegetation-boundaries.md`);
OSM bridges with no road on the map there are dropped.
Where the map draws a road well away from its bridge
(Rv2 over the Vrangselva at Magnor is drawn 18 m off),
the road is on the ground in the world, as the map shows it.
Under the deck, the ground is what the map shows under the upper road,
and the gap that mappers leave in the lower road is closed.

## Considered Options

- **Fill the terrain under the bridge**: one change to the height grid,
  but it walls off the lower road or the river.
- **NVDB (Statens vegvesen's bridge register) or Elveg's `MEDIUM` flag**:
  authoritative, but a new download, and NVDB covers only public roads.
- **Detect bridges from the lidar alone**: finds bridges OSM lacks,
  but trees over a road also raise the DOM above the DTM.
  Crossings that look like bridges without an OSM tag are logged during the build instead,
  to learn how common they are.

## Consequences

The world package gets a `bridges.json`, so `FORMAT_VERSION` goes from 7 to 8.
A runner has two levels at one place: they step onto a deck only from its ends,
run on it at the upper road's speed, and pass under it on the ground otherwise.
Under a deck too low to pass beneath
(slab and runner, 2.6 m), the runner is on the deck, as on a footbridge.
