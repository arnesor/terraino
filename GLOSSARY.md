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

**Run time**: The game time from leaving the start triangle to punching the finish.
_Avoid_: elapsed time, race time

### Results

**Result**: One finished run on a course: the runner's name, run time, split times and route.
_Avoid_: score, high score

**Results list**: All results on one course, sorted by run time.
_Avoid_: high-score list, leaderboard

**Course**: A start, controls and finish on one map, in order.
Two courses with the same control positions are the same course, wherever they came from.
_Avoid_: track (roads and paths are tracks)

**Split time**: The run time when a control is punched, counted from the start.
_Avoid_: intermediate time

**Leg time**: The time from one control to the next.
_Avoid_: split (on its own)

**Route**: Where the runner went during a run, recorded as the run goes.
_Avoid_: track, GPS track, trail

**Competition mode**: A way of running with no help beyond the map and the compass.
Only runs in competition mode can become results.
_Avoid_: race mode, ranked mode
