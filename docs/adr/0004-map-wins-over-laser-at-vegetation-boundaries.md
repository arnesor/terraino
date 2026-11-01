# The map wins over the laser at vegetation boundaries

Trees come from the laser canopy and SR16,
but a distinct vegetation boundary (symbol 416) must be easy to see and follow in the forest,
and the map is almost always newer than the laser scan:
a stand felled and replanted after the scan is on the map but not in the laser data.
So where the two sides of a vegetation boundary look alike,
the build invents the difference instead of trusting the data.

Pieces of one boundary that the map draws as separate lines,
with ends within 15 m that face each other, are joined first.
The sides are compared per 20 m of the line, 2–12 m out.
They are alike unless the median height of the laser trees on one side
is at least 1.5 times and 5 m more than on the other,
or SR16's dominant species differ (by 0.3 in their shares).
A difference of a few metres between two mixed stands cannot be seen from the ground,
and species drawn at random for a handful of trees differ by chance.

The side to change is chosen once per line:
the side the map shows as slower or greener,
else the side with fewer or lower laser trees, else the side with the smaller stand;
if that side is cut off by an edge, road, path or stream more than 8 m out,
the other side changes instead.
If the map shows a slower side, that side becomes a young stand (4–8 m);
otherwise its trees keep their places, lowered to half the lower of their own
and the other side's height (a young stand if the other side is under 10 m).
Species are never invented: they change across a boundary only where SR16 changes.
The change reaches 30 m into the stand, fades out by 50 m,
and stops at the next vegetation boundary, map area edge, road, path or stream,
except those within 8 m of the boundary, which run along it.

## Considered Options

- **Trust the data and only log boundaries without contrast**:
  true to the laser, but the runner cannot see boundaries the map relies on.
- **Invent a species change**: does not touch the laser heights,
  but puts species in the forest that SR16 says are not there.
