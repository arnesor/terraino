// The results Worker: results lists in D1, one row per course and one per result
// (docs/adr/0003-results-stored-in-d1-by-a-worker.md). Everything else on the site is
// static assets, which Cloudflare serves without it.

import {
  MAX_BODY,
  type ResultsCourse,
  type SavedResults,
  storedResult,
  validCourse,
  validResult,
  validWorld,
} from './results'

const PATH = /^\/results\/([^/]+)\/([0-9a-f]{16})\.json$/
// D1 rows hold at most 2 MB.
const MAX_ROW = 1_900_000

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function json(status: number, body: string | object): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** The results list of a course as JSON text, or null if it has none. */
async function list(db: D1Database, world: string, key: string): Promise<string | null> {
  const [course, results] = await db.batch<{ course?: string; result?: string }>([
    db.prepare('SELECT course FROM courses WHERE world = ? AND key = ?').bind(world, key),
    db.prepare('SELECT result FROM results WHERE world = ? AND key = ? ORDER BY saved_at, rowid').bind(world, key),
  ])
  const text = course?.results[0]?.course
  if (!text) return null
  // The rows are JSON already; join them rather than parse and write them again.
  return `{"course":${text},"results":[${(results?.results ?? []).map(r => r.result).join(',')}]}`
}

/** A request body as JSON, refusing more than MAX_BODY bytes. */
async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) throw new HttpError(413, 'too large')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BODY) throw new HttpError(413, 'too large')
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError(400, 'bad request')
  }
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
}

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')

/**
 * Whether a key hashes to `hash` (hex). Both digests have the same length, and every byte
 * is compared, so the time taken says nothing about how much of it matched.
 */
async function keyMatches(key: string, hash: string): Promise<boolean> {
  const given = new Uint8Array(await sha256(key))
  const stored = hash.match(/../g)?.map(h => parseInt(h, 16)) ?? []
  if (stored.length !== given.length) return false
  let difference = 0
  given.forEach((byte, i) => (difference |= byte ^ stored[i]!))
  return difference === 0
}

async function worldExists(env: Env, url: URL, world: string): Promise<boolean> {
  const response = await env.ASSETS.fetch(new URL(`/worlds/${encodeURIComponent(world)}/manifest.json`, url))
  await response.body?.cancel()
  return response.ok
}

async function save(request: Request, env: Env, url: URL, world: string, key: string): Promise<Response> {
  const body = (await readJson(request)) as { course?: unknown; result?: unknown } | null
  if (!(await worldExists(env, url, world))) throw new HttpError(404, 'no such world')
  const known = await env.DB.prepare('SELECT course FROM courses WHERE world = ? AND key = ?')
    .bind(world, key)
    .first<{ course: string }>()
  const course: unknown = known ? (JSON.parse(known.course) as ResultsCourse) : body?.course
  if (!validCourse(course) || !validResult(body?.result, course)) throw new HttpError(400, 'bad result')
  const result = JSON.stringify(storedResult(body.result))
  if (result.length > MAX_ROW) throw new HttpError(413, 'route too long')

  const deleteKey = hex(crypto.getRandomValues(new Uint8Array(32)))
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO courses (world, key, course) VALUES (?, ?, ?)').bind(
        world,
        key,
        JSON.stringify(course),
      ),
      env.DB.prepare(
        'INSERT INTO results (id, world, key, result, delete_hash, saved_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(body.result.id, world, key, result, hex(await sha256(deleteKey)), new Date().toISOString()),
    ])
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new HttpError(409, 'result already saved')
    throw err
  }
  const saved = JSON.parse((await list(env.DB, world, key))!) as SavedResults
  saved.deleteKey = deleteKey
  return json(200, saved)
}

async function remove(request: Request, env: Env, url: URL, world: string, key: string): Promise<Response> {
  const id = url.searchParams.get('id')
  const row = id
    ? await env.DB.prepare('SELECT delete_hash FROM results WHERE id = ? AND world = ? AND key = ?')
        .bind(id, world, key)
        .first<{ delete_hash: string }>()
    : null
  if (!row) throw new HttpError(404, 'no such result')
  const given = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? ''
  const admin = env.ADMIN_KEY ? hex(await sha256(env.ADMIN_KEY)) : null
  if (!given || !((await keyMatches(given, row.delete_hash)) || (admin && (await keyMatches(given, admin))))) {
    throw new HttpError(403, 'not your result')
  }
  await env.DB.prepare('DELETE FROM results WHERE id = ?').bind(id).run()
  // The course stays, so the list is there, even when it is now empty.
  return json(200, (await list(env.DB, world, key))!)
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const match = PATH.exec(url.pathname)
    if (!match) return json(404, { error: 'not found' })
    try {
      let world: string
      try {
        world = decodeURIComponent(match[1]!)
      } catch {
        throw new HttpError(400, 'bad world name')
      }
      if (!validWorld(world)) throw new HttpError(400, 'bad world name')
      const key = match[2]!
      if (request.method === 'GET') {
        const text = await list(env.DB, world, key)
        return text ? json(200, text) : json(404, { error: 'no results' })
      }
      if (request.method === 'POST') return await save(request, env, url, world, key)
      if (request.method === 'DELETE') return await remove(request, env, url, world, key)
      return json(405, { error: 'method not allowed' })
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message })
      console.error(JSON.stringify({ message: 'results request failed', path: url.pathname, error: String(err) }))
      return json(500, { error: 'server error' })
    }
  },
} satisfies ExportedHandler<Env>
