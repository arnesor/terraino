// Add a race to a world: check that its course setting file fits the world, copy the file
// to races/<world>/ and list it in races/<world>/index.json.
//
// Usage: npm run add-race -- <world> <course file.ocd> [--name "O-karusell 4"] [--date 2026-05-21]
//
// The name defaults to the event title in the file, the date to one in the file name
// (trlop_260521.ocd is 2026-05-21). Adding a race with the same date and name replaces it.
//
// Node runs this file as it is; the viewer modules go through Vite, which resolves their imports.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runnerImport } from 'vite'
import type * as Courses from '../src/ocad/courses'
import type * as Races from '../src/races'
import type { Manifest } from '../src/world'

const root = fileURLToPath(new URL('..', import.meta.url))
const load = async <T>(module: string): Promise<T> =>
  (await runnerImport<T>(path.join(root, module), { configFile: false, logLevel: 'error' })).module

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string' }, date: { type: 'string' } },
})
const [world, given] = positionals
if (!world || !given || positionals.length > 2) {
  fail('Usage: npm run add-race -- <world> <course file.ocd> [--name "Race name"] [--date YYYY-MM-DD]')
}
// npm runs scripts in viewer/; a relative path is from where the command was typed.
const source = path.resolve(process.env.INIT_CWD ?? process.cwd(), given)
if (!fs.existsSync(source)) fail(`No such file: ${given}`)

const { readCourseFile } = await load<typeof Courses>('src/ocad/courses.ts')
const races = await load<typeof Races>('src/races.ts')

const manifestFile = path.join(root, '..', 'worlds', world, 'manifest.json')
if (!fs.existsSync(manifestFile)) fail(`No world "${world}" in worlds/`)
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest

const bytes = fs.readFileSync(source)
const file = readCourseFile(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  manifest.map.offset ?? [0, 0],
)
const problem = races.courseFileProblem(file, manifest)
if (problem?.kind === 'wrongZone') fail(`The course file is in UTM zone ${problem.course}, the world in zone ${problem.map}`)
if (problem?.kind === 'noCourses') fail('The file has no courses')
const outside = file.courses.filter(c => races.outsideMap(c, manifest)).map(c => c.name)
if (outside.length) fail(`Outside the map of ${world}: ${outside.join(', ')}`)

const name = values.name?.trim() || file.event.trim()
if (!name) fail('The file has no event title; give the race a name with --name')
const date = values.date ?? races.dateFromFileName(path.basename(source))
if (!date) fail('There is no date in the file name; give it with --date YYYY-MM-DD')
if (!races.isDate(date)) fail(`Not a date: ${date} (write it as YYYY-MM-DD)`)

const dir = path.join(root, '..', 'races', world)
const indexFile = path.join(dir, 'index.json')
const index: Races.RaceIndex = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { races: [] }
const id = races.raceId(date, name)
const race = races.raceFrom(file, name, date, `${id}.ocd`)
const replaced = index.races.find(r => r.id === race.id)

fs.mkdirSync(dir, { recursive: true })
fs.copyFileSync(source, path.join(dir, race.file))
fs.writeFileSync(indexFile, `${JSON.stringify(races.withRace(index, race), null, 2)}\n`)

console.log(`${replaced ? 'Replaced' : 'Added'} ${race.name} (${race.date}) on ${world}, as races/${world}/${race.file}`)
for (const c of race.courses) console.log(`  ${c.name}: ${c.controls} controls, ${(c.lengthM / 1000).toFixed(1)} km`)
if (race.setOn) console.log(`Set on ${race.setOn}`)
