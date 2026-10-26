# Results are stored in D1 by a Cloudflare Worker

Supersedes `0001-results-stored-by-the-vite-server.md`.

The viewer is published on Cloudflare at <https://terraino.arnesor.workers.dev>,
where there is no Vite server to keep results in `results/`.
The app, the worlds and the races are static assets,
and a Worker (`viewer/worker/index.ts`) answers `/results/` with the same endpoint as before,
keeping the lists in a D1 database (`terraino-results`):
one row per course of a world and one per result.
The Cloudflare Vite plugin runs the same Worker, with a local copy of the database,
under `npm run dev`, so there is one implementation of the endpoint.

On the public internet anyone could otherwise delete or flood the lists, so the Worker:

- saves results only for worlds that are deployed, and keeps the size limits;
- returns a delete key with each saved result.
  The browser that saved it keeps the key; only that key, or the admin key
  (a Wrangler secret, given to a browser once with `?admin=<key>`), deletes the result;
- stores routes in decimetres, which keeps the longest route under D1's 2 MB row limit.

Results are still kept by course, not by race or player.

## Considered Options

- **A small server with the JSON files on disk** (a VPS): the endpoint unchanged,
  but a machine to keep updated and backed up.
- **Workers KV**: simple, but a save reads the list, adds to it and writes it back,
  and KV's eventual consistency could lose a result when two runners finish together.
- **Supabase or another hosted database**: also gives user accounts,
  which can come later with Better Auth on D1 instead.

## Consequences

`npm run deploy` publishes the viewer, and `results/` is no longer used.
Results saved earlier are copied over with `npm run import-results`;
only the admin key can delete those.
Cloudflare's free plan takes 20,000 static files of up to 25 MiB:
about 12 worlds the size of Langvatnet.
