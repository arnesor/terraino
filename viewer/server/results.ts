import fs from 'node:fs'
import path from 'node:path'
import type { Connect } from 'vite'
import type { Result, ResultsCourse, ResultsFile } from '../src/results'
import { MAX_NAME_LENGTH } from '../src/results'

// Results lists on disk: one JSON file per course in <dir>/<map>/<key>.json
// (docs/adr/0001-results-stored-by-the-vite-server.md).
//
//   GET    /results/<map>/<key>.json          the list, or 404 if it has none
//   POST   /results/<map>/<key>.json          add { course, result }; returns the list
//   DELETE /results/<map>/<key>.json?id=...   delete a result; returns the list

const MAX_BODY = 4 * 1024 * 1024
// A route point per second: half a day of running.
const MAX_ROUTE = 43_200
const MAX_CONTROLS = 200

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNumber)

function validCourse(v: unknown): v is ResultsCourse {
  const c = v as ResultsCourse
  return (
    typeof c === 'object' &&
    c !== null &&
    (c.name === null || typeof c.name === 'string') &&
    Array.isArray(c.controls) &&
    c.controls.length >= 2 &&
    c.controls.length <= MAX_CONTROLS &&
    c.controls.every(isPoint) &&
    (c.codes === null || (Array.isArray(c.codes) && c.codes.every(s => typeof s === 'string')))
  )
}

function validResult(v: unknown, course: ResultsCourse): v is Result {
  const r = v as Result
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.id === 'string' &&
    /^[\w-]{1,64}$/.test(r.id) &&
    typeof r.name === 'string' &&
    r.name.trim().length > 0 &&
    r.name.length <= MAX_NAME_LENGTH &&
    typeof r.date === 'string' &&
    !Number.isNaN(Date.parse(r.date)) &&
    Array.isArray(r.splits) &&
    r.splits.length === course.controls.length - 1 &&
    r.splits.every((t, i) => isNumber(t) && t > (r.splits[i - 1] ?? 0)) &&
    Array.isArray(r.route) &&
    r.route.length <= MAX_ROUTE &&
    r.route.every(isPoint)
  )
}

/** Read a request body as JSON, up to MAX_BODY. */
function readJson(req: Connect.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

/** Write a file whole or not at all: a new file, renamed over the old one. */
function writeAtomic(file: string, data: ResultsFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

/** The results endpoint, keeping its files under `dir`. */
export function resultsMiddleware(dir: string): Connect.NextHandleFunction {
  const root = path.resolve(dir)
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/results\/([^/]+)\/([0-9a-f]{16})\.json$/.exec(url.pathname)
    if (!match) return next()
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }
    const map = decodeURIComponent(match[1]!)
    const file = path.resolve(root, map, `${match[2]}.json`)
    if (map === '.' || map === '..' || /[/\\]/.test(map) || !file.startsWith(root + path.sep)) {
      return send(400, { error: 'bad map name' })
    }
    const read = (): ResultsFile | null => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ResultsFile) : null)

    if (req.method === 'GET') {
      const data = read()
      return data ? send(200, data) : send(404, { error: 'no results' })
    }
    if (req.method === 'DELETE') {
      const data = read()
      const id = url.searchParams.get('id')
      if (!data || !id || !data.results.some(r => r.id === id)) return send(404, { error: 'no such result' })
      data.results = data.results.filter(r => r.id !== id)
      writeAtomic(file, data)
      return send(200, data)
    }
    if (req.method === 'POST') {
      readJson(req).then(
        body => {
          const { course, result } = (body ?? {}) as { course?: unknown; result?: unknown }
          const data = read()
          const known = data?.course ?? course
          if (!validCourse(known) || !validResult(result, known)) return send(400, { error: 'bad result' })
          const saved: ResultsFile = { course: known, results: [...(data?.results ?? []), result] }
          writeAtomic(file, saved)
          send(200, saved)
        },
        () => send(400, { error: 'bad request' }),
      )
      return
    }
    send(405, { error: 'method not allowed' })
  }
}
