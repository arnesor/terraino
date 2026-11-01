# Terrain-O

Running an orienteering course in a 3D world built from an orienteering map.

## Language

### Time

**Game time**: The simulated time that passes in the terrain.
Run time, split times and pace are all measured in game time.
_Avoid_: simulated time, sim time

**Real time**: The time on the player's wall clock.
_Avoid_: wall time

**Time factor**: How many seconds of game time pass per second of real time,
never less than 1.0 and shown as `2.0×`.
_Avoid_: speed-up, time warp, simulation speed

**Run time**: The game time from passing under the start banner to punching the finish.
_Avoid_: elapsed time, race time

### Results

**Result**: One finished run on a course: the runner's name, run time, split times and route.
_Avoid_: score, high score

**Results list**: All results on one course, sorted by run time.
_Avoid_: high-score list, leaderboard

**Course**: A start, controls and finish on one map, in order.
Two courses with the same control positions are the same course, wherever they came from.
_Avoid_: track (roads and paths are tracks)

**Race**: The courses of one event, set in one course setting file, with the event's name and date.
Runners choose a race on the start screen instead of opening a course file.
_Avoid_: event (OCAD's word for it), competition (see competition mode)

**Split time**: The run time when a control is punched, counted from the start.
_Avoid_: intermediate time

**Leg time**: The time from one control to the next.
_Avoid_: split (on its own)

**Route**: Where the runner went during a run, recorded as the run goes.
_Avoid_: track, GPS track, trail

**Competition mode**: A way of running with no help beyond the map and the compass.
Only runs in competition mode can become results.
_Avoid_: race mode, ranked mode

### Map

**Thumb**: The runner's own mark on the map of where they think they are,
as an orienteer keeps a thumb on the map.
It moves to each control as it is punched; the game never moves it to the runner's position.
There is a thumb only in competition mode; otherwise the map can show the runner's position.
_Avoid_: cursor, marker, pin, position

### Vegetation

**Young tree**: A single small tree, up to about 4.5 m tall, added where the map shows dense forest.
_Avoid_: sapling, small tree

**Thicket**: A dense clump of young trees or brush, about 4 m tall,
that the runner cannot see through.
Thickets are what make the map's green areas hard to see through.
_Avoid_: dense bush, scrub, brush

**Bush**: A single low plant, about 1–2 m tall, that the runner can see over.
_Avoid_: shrub

**Undergrowth**: Low vegetation on the forest floor that slows the runner
but leaves good visibility.
_Avoid_: understorey, ground vegetation

### Landforms

**Earth wall**: A distinct ridge of earth along a line, at least 1 m high.
_Avoid_: embankment, dyke, bank

**Earth bank**: A steep step in the ground, such as the edge of a road cutting.
_Avoid_: earth wall

**Pit**: A hole with steep sides, at least 1 m deep.
_Avoid_: hole, small depression

**Small depression**: A shallow hollow without steep sides, at least 1 m deep,
too small to be shown with contours.
_Avoid_: hollow, dip, pit
