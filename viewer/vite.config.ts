import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'
import { defineConfig } from 'vite'

// World packages are written by the Python pipeline to ../worlds. Serve them at
// /worlds/ in both the dev server and `vite preview`, without copying them into dist.
const worldsDir = fileURLToPath(new URL('../worlds', import.meta.url))

const contentTypes: Record<string, string> = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function listWorlds(): string[] {
  if (!fs.existsSync(worldsDir)) return []
  return fs
    .readdirSync(worldsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(worldsDir, d.name, 'manifest.json')))
    .map(d => d.name)
    .sort()
}

const serveWorlds: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/worlds/')) return next()
  if (url.pathname === '/worlds/index.json') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(listWorlds()))
    return
  }
  const file = path.resolve(worldsDir, decodeURIComponent(url.pathname.slice('/worlds/'.length)))
  if (!file.startsWith(worldsDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404
    res.end('Not found')
    return
  }
  res.setHeader('Content-Type', contentTypes[path.extname(file)] ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
  fs.createReadStream(file).pipe(res)
}

function worldsPlugin(): Plugin {
  return {
    name: 'terraino-worlds',
    configureServer(server) {
      server.middlewares.use(serveWorlds)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveWorlds)
    },
  }
}

export default defineConfig({
  plugins: [worldsPlugin()],
  server: { port: 5173 },
})
