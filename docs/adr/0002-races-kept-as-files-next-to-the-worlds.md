# Races are kept as course files next to the worlds, added from the command line

Runners on a public viewer should not need a course setting file of their own,
so the viewer lists races: the courses of one event, with its name and date.
For now only the person who deploys the viewer adds races.
`npm run add-race -- <world> <course file>` checks that the file fits the world,
copies it to `races/<world>/<date>-<name>.ocd` and lists it in `races/<world>/index.json`.
The Vite server serves `races/` like `worlds/`, and so can any static host.

The original OCAD file is kept, not courses converted to another format:
the viewer reads it in the browser as it reads an opened course file,
so improvements to the reader reach old races too.
The index holds only what the start screen lists
(name, date, courses), so the viewer does not download every file to show them.

Course files have no date, and the event title is optional,
so the command takes them from `--name` and `--date`,
or from the event title and a date in the file name (`trlop_260521.ocd` is 2026-05-21).
The background map name in the file is only shown: it is the course setter's own path,
and often another revision of the map than the world's.

Results lists stay keyed by course, not by race, so a course run from a race,
an opened file or a link shares one list.

## Considered Options

- **Uploads through the viewer, stored in a database**: lets organisers add races,
  but needs accounts or an admin key to keep strangers out.
  The races index has the shape such tables would have, so this can come later.
- **Races in the world folder**: a rebuild of the world would delete them.

## Consequences

A new race needs a redeploy.
Like `worlds/` and `results/`, `races/` is not in git;
it is deployed from the machine that holds it.
