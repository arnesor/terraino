// The results Worker against a local D1 database from Wrangler, in memory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import schema from './migrations/0001_results.sql?raw'
import worker from './index'
import type { Result, ResultsCourse, ResultsFile, SavedResults } from './results'

const course: ResultsCourse = { name: 'Kort', controls: [[0, 0], [100, 0], [100, 100], [0, 100]], codes: null }
const key = '0123456789abcdef'
const base = 'http://terraino.test'

function result(name: string, splits: number[], date = '2026-10-25T12:00:00Z'): Result {
  return { id: `${name}-${date}`.replace(/[^\w-]/g, '_'), name, date, splits, route: [[1.234, 5.678]] }
}

let proxy: PlatformProxy<Env>
let env: Env

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ persist: false })
  const statements = schema
    .replace(/--.*$/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
  await proxy.env.DB.batch(statements.map(s => proxy.env.DB.prepare(s)))
  // Only the Langvatnet world exists among the static assets.
  const assets = {
    fetch: async (url: string | URL) => new Response(null, { status: String(url).includes('/worlds/Langvatnet/') ? 200 : 404 }),
  } as Partial<Fetcher> as Fetcher
  env = { ...proxy.env, ASSETS: assets, ADMIN_KEY: 'the-admin-key' }
})
afterAll(() => proxy.dispose())

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return worker.fetch(new Request(`${base}${path}`, init) as Parameters<typeof worker.fetch>[0], env)
}

const list = `/results/Langvatnet/${key}.json`

describe('results Worker', () => {
  it('keeps results per world and course, and deletes them with their key', async () => {
    expect((await call('GET', list)).status).toBe(404)
    const ola = result('Ola', [60, 200, 300])
    const saved = await call('POST', list, { course, result: ola })
    expect(saved.status).toBe(200)
    const { deleteKey } = (await saved.json()) as SavedResults
    expect(deleteKey).toMatch(/^[0-9a-f]{64}$/)
    await call('POST', list, { course, result: result('Kari', [70, 180, 290]) })

    const file = (await (await call('GET', list)).json()) as ResultsFile
    expect(file.course).toEqual(course)
    expect(file.results.map(r => r.name)).toEqual(['Ola', 'Kari'])
    // Routes are kept in decimetres.
    expect(file.results[0]!.route).toEqual([[1.2, 5.7]])
    expect((await call('GET', `/results/Other/${key}.json`)).status).toBe(404)

    const left = await call('DELETE', `${list}?id=${ola.id}`, undefined, deleteKey)
    expect(((await left.json()) as ResultsFile).results.map(r => r.name)).toEqual(['Kari'])
  })

  it('lets only the saver or the admin delete a result', async () => {
    const per = result('Per', [65, 190, 300])
    const { deleteKey } = (await (await call('POST', list, { course, result: per })).json()) as SavedResults
    const other = result('Anne', [66, 191, 301])
    const otherKey = ((await (await call('POST', list, { course, result: other })).json()) as SavedResults).deleteKey
    expect(otherKey).not.toBe(deleteKey)

    expect((await call('DELETE', `${list}?id=${per.id}`)).status).toBe(403)
    expect((await call('DELETE', `${list}?id=${per.id}`, undefined, otherKey)).status).toBe(403)
    expect((await call('DELETE', `${list}?id=${per.id}`, undefined, 'the-admin-key')).status).toBe(200)
    expect((await call('DELETE', `${list}?id=${other.id}`, undefined, otherKey)).status).toBe(200)
    expect((await call('DELETE', `${list}?id=${other.id}`, undefined, otherKey)).status).toBe(404)
  })

  it('refuses results that do not fit the course, worlds that do not exist, and doubles', async () => {
    const bad = [
      { course, result: result('', [60, 200, 300]) }, // no name
      { course, result: result('Ola', [60, 200]) }, // a split missing
      { course, result: result('Ola', [60, 50, 300]) }, // time going backwards
      { course, result: result('x'.repeat(41), [60, 200, 300]) }, // name too long
    ]
    for (const body of bad) expect((await call('POST', list, body)).status).toBe(400)
    const ok = { course, result: result('Siri', [60, 200, 300]) }
    expect((await call('POST', `/results/Nowhere/${key}.json`, ok)).status).toBe(404)
    expect((await call('POST', `/results/..%2F..%2Fx/${key}.json`, ok)).status).toBe(400)
    expect((await call('POST', `/results/..%5Cx/${key}.json`, ok)).status).toBe(400)
    expect((await call('POST', list, ok)).status).toBe(200)
    expect((await call('POST', list, ok)).status).toBe(409)
    expect((await call('POST', list, 'x'.repeat(5 * 1024 * 1024))).status).toBe(413)
  })

  it('keeps split times in whole seconds, and takes two punches in the same second', async () => {
    const saved = await call('POST', list, { course, result: result('Liv', [60.7, 60.9, 300.2]) })
    expect(saved.status).toBe(200)
    const liv = ((await saved.json()) as ResultsFile).results.find(r => r.name === 'Liv')!
    expect(liv.splits).toEqual([60, 60, 300])
    expect((await call('POST', list, { course, result: result('Eva', [60, 60, 300]) })).status).toBe(200)
  })
})
