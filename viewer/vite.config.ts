import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import type { Connect, Plugin } from 'vite'
import { defineConfig } from 'vite'

// World packages are written by the Python pipeline to ../worlds, and races by
// `npm run add-race` to ../races. Serve them at /worlds/ and /races/ in both the dev
// server and `vite preview`, without copying them into dist; `npm run deploy` uploads them.
const worldsDir = fileURLToPath(new URL('../worlds', import.meta.url))
// Races are kept next to the worlds, so rebuilding a world leaves them alone.
const racesDir = fileURLToPath(new URL('../races', import.meta.url))

const contentTypes: Record<string, string> = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ocd': 'application/octet-stream',
}

function listWorlds(): string[] {
  if (!fs.existsSync(worldsDir)) return []
  return fs
    .readdirSync(worldsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(worldsDir, d.name, 'manifest.json')))
    .map(d => d.name)
    .sort()
}

/** Serve the files in `dir` at `/<prefix>/`. */
function serveDir(prefix: string, dir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(`/${prefix}/`)) return next()
    const file = path.resolve(dir, decodeURIComponent(url.pathname.slice(prefix.length + 2)))
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    res.setHeader('Content-Type', contentTypes[path.extname(file)] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    fs.createReadStream(file).pipe(res)
  }
}

const listWorldsHandler: Connect.NextHandleFunction = (req, res, next) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/worlds/index.json') return next()
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(listWorlds()))
}

function useMiddlewares(app: Connect.Server) {
  app.use(listWorldsHandler)
  app.use(serveDir('worlds', worldsDir))
  app.use(serveDir('races', racesDir))
}

function worldsPlugin(): Plugin {
  return {
    name: 'terraino-worlds',
    configureServer: server => useMiddlewares(server.middlewares),
    configurePreviewServer: server => useMiddlewares(server.middlewares),
  }
}

// The Cloudflare plugin runs the results Worker (worker/index.ts) with a local D1 database.
export default defineConfig({
  plugins: [worldsPlugin(), cloudflare()],
  server: { port: 5173 },
})
