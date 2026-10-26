// Build the viewer and deploy it to Cloudflare: the app, the worlds and the races as static
// assets, and the results Worker with its D1 database
// (docs/adr/0003-results-stored-in-d1-by-a-worker.md).
//
// Usage: npm run deploy [-- <world> …]   (default: every world in worlds/)
//
// Cloudflare's free plan takes up to 20,000 files of up to 25 MiB each.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const viewer = fileURLToPath(new URL('..', import.meta.url))
const worldsDir = path.join(viewer, '..', 'worlds')
const racesDir = path.join(viewer, '..', 'races')
const client = path.join(viewer, 'dist', 'client')
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 25 * 1024 * 1024

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(command: string, ...args: string[]) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: viewer, stdio: 'inherit' })
}

const all = fs.existsSync(worldsDir)
  ? fs.readdirSync(worldsDir).filter(name => fs.existsSync(path.join(worldsDir, name, 'manifest.json')))
  : []
const worlds = process.argv.length > 2 ? process.argv.slice(2) : all
for (const name of worlds) if (!all.includes(name)) fail(`No world "${name}" in worlds/`)
if (!worlds.length) fail('No worlds to deploy: build one first')

run('npm', 'run', 'build')

// The worlds without the build's work files, the races of those worlds, and their list.
for (const name of worlds) {
  fs.cpSync(path.join(worldsDir, name), path.join(client, 'worlds', name), {
    recursive: true,
    filter: source => path.basename(source) !== '_work',
  })
  if (fs.existsSync(path.join(racesDir, name))) {
    fs.cpSync(path.join(racesDir, name), path.join(client, 'races', name), { recursive: true })
  }
}
fs.writeFileSync(path.join(client, 'worlds', 'index.json'), JSON.stringify([...worlds].sort()))

const files = fs.readdirSync(client, { recursive: true, withFileTypes: true }).filter(f => f.isFile())
const large = files.filter(f => fs.statSync(path.join(f.parentPath, f.name)).size > MAX_FILE_BYTES)
if (large.length) fail(`Larger than 25 MiB: ${large.map(f => path.join(f.parentPath, f.name)).join(', ')}`)
if (files.length > MAX_FILES) fail(`${files.length} files: more than the free plan's ${MAX_FILES}; deploy fewer worlds`)
console.log(`\n${worlds.join(', ')}: ${files.length} files`)

run('npx', 'wrangler', 'd1', 'migrations', 'apply', 'terraino-results', '--remote')
run('npx', 'wrangler', 'deploy')
