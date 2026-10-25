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
