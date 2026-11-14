import { execFileSync } from 'node:child_process'
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

/**
 * The version shown on the start screen: `git describe` against the release tags, so a build
 * between releases says how far past the last one it is (`0.8.0-2-g28aae4d`, `-dirty` with
 * local changes). Without git or the tags, the version in pyproject.toml, which the release
 * workflow bumps; viewer/package.json is not kept up to date.
 */
function appVersion(): string {
  const root = fileURLToPath(new URL('..', import.meta.url))
  try {
    // A fixed command without user input.
    const described = execFileSync('git', ['describe', '--tags', '--match', 'v*', '--dirty'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return described.trim().replace(/^v/, '')
  } catch {
    const pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')
    return /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? 'unknown'
  }
}

// The Cloudflare plugin runs the results Worker (worker/index.ts) with a local D1 database.
export default defineConfig({
  plugins: [worldsPlugin(), cloudflare()],
  server: { port: 5173 },
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
})
