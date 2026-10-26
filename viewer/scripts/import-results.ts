// Copy results lists kept as files by the old Vite server (results/<world>/<key>.json) to a
// running viewer, result by result, through its results endpoint. Results it has already
// are skipped. The delete keys are not kept: only the admin key can delete these results.
//
// Usage: npm run import-results -- <viewer URL> [results folder]
//   e.g. npm run import-results -- https://terraino.arnesor.workers.dev

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResultsFile } from '../worker/results'

const [base, given] = process.argv.slice(2)
if (!base) {
  console.error('Usage: npm run import-results -- <viewer URL> [results folder]')
  process.exit(1)
}
// The repository's results/ by default; npm runs scripts in viewer/, so a folder given is
// from where the command was typed.
const dir = given
  ? path.resolve(process.env.INIT_CWD ?? process.cwd(), given)
  : fileURLToPath(new URL('../../results', import.meta.url))

let failed = false
for (const world of fs.readdirSync(dir)) {
  for (const file of fs.readdirSync(path.join(dir, world)).filter(f => /^[0-9a-f]{16}\.json$/.test(f))) {
    const { course, results } = JSON.parse(fs.readFileSync(path.join(dir, world, file), 'utf8')) as ResultsFile
    const url = new URL(`/results/${encodeURIComponent(world)}/${file}`, base)
    for (const result of results) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course, result }),
      })
      const outcome = response.ok ? 'saved' : response.status === 409 ? 'there already' : `failed: ${response.status}`
      failed ||= !response.ok && response.status !== 409
      console.log(`${world} · ${course.name ?? 'course set by hand'} · ${result.name}: ${outcome}`)
    }
  }
}
process.exit(failed ? 1 : 0)
