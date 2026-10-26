# Results are stored by the Vite server in `results/`, not in the browser

Superseded by `0003-results-stored-in-d1-by-a-worker.md`.

The viewer has no backend, but results lists must survive browser clean-ups
and be shared by everyone playing through the same viewer, such as a club laptop.
So the Vite server (dev and preview, the only ways the viewer runs, since it also serves `worlds/`)
gets a small endpoint that keeps one JSON file per course in `results/<map>/`.
The folder sits next to `worlds/`, so rebuilding a world leaves the results alone,
and git ignores it.

## Considered Options

- **Browser storage** (`localStorage`): no server code,
  but results live in one browser on one machine, vanish when site data is cleared,
  and hold only about 100 routes.
- **Files in the world folder**: shared, but a rebuild of the world would delete them.

## Consequences

A static deployment of `dist` without the Vite server could not save results;
it would need its own endpoint or a fallback to browser storage.
Anyone who can reach the server can add or delete results: there are no users.
