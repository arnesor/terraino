import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resultsMiddleware } from '../server/results'
import { courseKey, type Result, type ResultsCourse, resultsTable } from '../src/results'

/** A result with these split times (seconds) on a three-leg course. */
function result(name: string, splits: number[], date = '2026-10-25T12:00:00Z'): Result {
  return { id: `${name}-${date}`.replace(/[^\w-]/g, '_'), name, date, splits, route: [] }
}

describe('results table', () => {
  const ola = result('Ola', [60, 200, 300])
  const kari = result('Kari', [70, 180, 290])
  const per = result('Per', [65, 190, 300])

  it('is sorted by run time, with places per leg and split, and the best bold', () => {
    const rows = resultsTable([ola, kari, per])
    expect(rows.map(r => [r.label, r.place, r.behind])).toEqual([
      ['Kari', 1, 0],
      ['Ola', 2, 10],
      ['Per', 2, 10], // equal times share a place
    ])
    const kariRow = rows[0]!
    expect(kariRow.legs).toEqual([70, 110, 110])
    expect(kariRow.legPlaces).toEqual([3, 1, 2])
    expect(kariRow.splitPlaces).toEqual([3, 1, 1])
    expect(kariRow.bestLegs).toEqual([false, true, false])
    // Ola's last leg (100) is the best; Ola has the fastest first leg too.
    expect(rows[1]!.bestLegs).toEqual([true, false, true])
  })

  it('sorts by a leg time or a split time', () => {
    expect(resultsTable([ola, kari, per], { sort: { by: 'leg', index: 1 } }).map(r => r.label)).toEqual(['Kari', 'Per', 'Ola'])
    expect(resultsTable([ola, kari, per], { sort: { by: 'split', index: 0 } }).map(r => r.label)).toEqual(['Ola', 'Per', 'Kari'])
  })

  it("shows each name's best run, or every run numbered by date", () => {
    const again = result('ola ', [55, 180, 280], '2026-10-26T12:00:00Z')
    expect(resultsTable([ola, kari, again]).map(r => [r.label, r.place])).toEqual([
      ['ola ', 1],
      ['Kari', 2],
    ])
    expect(resultsTable([ola, kari, again], { allRuns: true }).map(r => r.label)).toEqual(['ola  (2)', 'Kari', 'Ola (1)'])
  })

  it('adds an unsaved run without a place, not counted in the places', () => {
    const practice = result('Me', [50, 150, 250])
    const rows = resultsTable([ola, kari], { extra: practice })
    expect(rows.map(r => [r.label, r.place])).toEqual([
      ['Me', null],
      ['Kari', 1],
      ['Ola', 2],
    ])
    expect(rows[0]!.legPlaces).toEqual([null, null, null])
    expect(rows[0]!.bestLegs).toEqual([false, false, false])
    expect(rows[0]!.behind).toBe(-40)
  })
})

describe('course key', () => {
  it('is the same for the same control positions, to the metre', () => {
    const a = courseKey({ controls: [[665400.2, 6645000.4], [665500, 6645100]] })
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(courseKey({ controls: [[665399.9, 6645000.1], [665500.3, 6645099.8]] })).toBe(a)
    expect(courseKey({ controls: [[665401, 6645000], [665500, 6645100]] })).not.toBe(a)
    expect(courseKey({ controls: [[665500, 6645100], [665400, 6645000]] })).not.toBe(a)
  })
})

describe('results server', () => {
  let dir: string
  let server: http.Server
  let base: string
  const course: ResultsCourse = { name: 'Kort', controls: [[0, 0], [100, 0], [100, 100], [0, 100]], codes: null }
  const key = courseKey(course)

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraino-results-'))
    const middleware = resultsMiddleware(dir)
    server = http.createServer((req, res) =>
      middleware(req, res, () => {
        res.statusCode = 418
        res.end()
      }),
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const post = (map: string, body: unknown) =>
    fetch(`${base}/results/${encodeURIComponent(map)}/${key}.json`, { method: 'POST', body: JSON.stringify(body) })

  it('keeps results per map and course, and deletes them', async () => {
    expect((await fetch(`${base}/results/Langvatnet/${key}.json`)).status).toBe(404)
    const ola = result('Ola', [60, 200, 300])
    const saved = await post('Langvatnet', { course, result: ola })
    expect(saved.status).toBe(200)
    await post('Langvatnet', { course, result: result('Kari', [70, 180, 290]) })
    const list = await (await fetch(`${base}/results/Langvatnet/${key}.json`)).json()
    expect(list.course).toEqual(course)
    expect(list.results.map((r: Result) => r.name)).toEqual(['Ola', 'Kari'])
    expect(fs.existsSync(path.join(dir, 'Langvatnet', `${key}.json`))).toBe(true)

    const left = await fetch(`${base}/results/Langvatnet/${key}.json?id=${ola.id}`, { method: 'DELETE' })
    expect((await left.json()).results.map((r: Result) => r.name)).toEqual(['Kari'])
    expect((await fetch(`${base}/results/Other/${key}.json`)).status).toBe(404)
  })

  it('refuses results that do not fit the course, and paths out of its folder', async () => {
    const bad = [
      { course, result: result('', [60, 200, 300]) }, // no name
      { course, result: result('Ola', [60, 200]) }, // a split missing
      { course, result: result('Ola', [60, 50, 300]) }, // time going backwards
      { course, result: result('x'.repeat(41), [60, 200, 300]) }, // name too long
    ]
    for (const body of bad) expect((await post('Langvatnet', body)).status).toBe(400)
    // An encoded backslash reaches the server; '..' is resolved away by the URL already.
    expect((await post('..\\..\\x', { course, result: result('Ola', [60, 200, 300]) })).status).toBe(400)
    expect((await post('..', { course, result: result('Ola', [60, 200, 300]) })).status).not.toBe(200)
    expect(fs.readdirSync(dir)).toEqual(['Langvatnet'])
  })
})
