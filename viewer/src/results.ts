import type { Course } from './course'
import { type Point, type Result, type ResultsCourse, type ResultsFile, runTime, type SavedResults } from '../worker/results'

// Results lists, one per course. The results Worker keeps them in D1
// (docs/adr/0003-results-stored-in-d1-by-a-worker.md); this module is what the viewer
// needs to read, write and rank them.

export type { Result, ResultsCourse, ResultsFile } from '../worker/results'
export { MAX_NAME_LENGTH, runTime } from '../worker/results'

/**
 * The results list's key for a course: a hash of its control positions in order, rounded
 * to whole metres, so the same course from a file, a link or set by hand shares one list.
 */
export function courseKey(course: Course): string {
  const text = course.controls.map(([e, n]) => `${Math.round(e)},${Math.round(n)}`).join(';')
  // Two 32-bit FNV-1a hashes with different offsets: 16 hex digits.
  const fnv = (offset: number) => {
    let h = offset
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
    return h.toString(16).padStart(8, '0')
  }
  return fnv(0x811c9dc5) + fnv(0x01234567)
}

/** The course of a results list, from the course being run. */
export function resultsCourse(course: Course): ResultsCourse {
  const codes = course.imported?.controls.map(c => c.code) ?? null
  return { name: course.imported?.name ?? null, controls: course.controls, codes }
}

/** A leg on which the runner made a mistake (docs/adr/0005-mistakes-found-with-winsplits-time-loss-algorithm.md). */
export interface Mistake {
  /** Time loss: seconds more than the runner's normal leg time. */
  loss: number
  /** The time loss as a share of the normal leg time. */
  share: number
}

/** A leg is a mistake when its time loss is above both parts of the mistake threshold. */
export const MISTAKE_SECONDS = 30
export const MISTAKE_SHARE = 0.2

/** One row of the results table: a result with its places, ready to show. */
export interface Row {
  result: Result
  /** Place by run time, or null for a run that is not on the list (not saved). */
  place: number | null
  /** The name, numbered by date when the list shows every run: "Arne (2)". */
  label: string
  /** Run time behind the best placed result. */
  behind: number
  legs: number[]
  /** Places per leg and per split, among the placed rows; null for an unplaced row. */
  legPlaces: (number | null)[]
  splitPlaces: (number | null)[]
  /** Per leg, the mistake made on it, or null. */
  mistakes: (Mistake | null)[]
}

/** How the table is sorted: by run time, by name, or by one leg's leg time or split time. */
export type Sort = { by: 'time' | 'name' } | { by: 'leg' | 'split'; index: number }

const legTimes = (result: Result): number[] => result.splits.map((t, i) => t - (result.splits[i - 1] ?? 0))

const sameName = (name: string) => name.trim().toLocaleLowerCase()

/**
 * A result with its split times in whole seconds, as a punch records them. Every time in
 * the table is then whole seconds, so times that look the same are the same.
 */
const punched = (result: Result): Result => ({ ...result, splits: result.splits.map(Math.floor) })

/** The length of each leg of a course: the straight line between its controls, in metres. */
export function legLengths(controls: Point[]): number[] {
  return controls.slice(1).map(([e, n], i) => Math.hypot(e - controls[i]![0], n - controls[i]![1]))
}

/**
 * The median of `values` weighted by `weights`: the value at which half the weight lies on
 * either side, or the mean of the two values that split it exactly in half. With no weight
 * at all, every value weighs the same.
 */
export function weightedMedian(values: number[], weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0)
  const w = total > 0 ? weights : values.map(() => 1)
  const half = (total > 0 ? total : values.length) / 2
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!)
  let sum = 0
  for (let k = 0; k < order.length; k++) {
    sum += w[order[k]!]!
    // Rounding must not turn an exact half into a little more or less.
    if (Math.abs(sum - half) < 1e-9 * half && k + 1 < order.length) return (values[order[k]!]! + values[order[k + 1]!]!) / 2
    if (sum > half) return values[order[k]!]!
  }
  return values[order[order.length - 1]!]!
}

/** The reference time of a leg: the mean of the fastest quarter of its leg times, at least one. */
function referenceTime(times: number[]): number {
  const fastest = [...times].sort((a, b) => a - b).slice(0, Math.max(1, Math.round(times.length / 4)))
  return fastest.reduce((a, b) => a + b, 0) / fastest.length
}

/** The mistakes on each leg of a run, measured against the reference times of the legs. */
function mistakes(legs: number[], references: number[], weights: number[]): (Mistake | null)[] {
  if (references.length !== legs.length) return legs.map(() => null)
  const normal = weightedMedian(
    legs.map((t, i) => references[i]! / t),
    weights,
  )
  return legs.map((t, i) => {
    const normalLeg = references[i]! / normal
    const loss = t - normalLeg
    return loss > MISTAKE_SECONDS && loss > MISTAKE_SHARE * normalLeg ? { loss, share: loss / normalLeg } : null
  })
}

/**
 * The results table: each name's best result (or every result with `allRuns`), plus an
 * unplaced `extra` run that is not on the list, sorted by `sort`. Places count only
 * the placed rows; equal times share a place. Mistakes are measured against the placed
 * rows, with each run's normal performance weighted by `legLengths` (all legs alike if left out).
 * Each row's result has its split times in whole seconds.
 */
export function resultsTable(
  results: Result[],
  {
    allRuns = false,
    extra = null,
    sort = { by: 'time' },
    legLengths = [],
  }: { allRuns?: boolean; extra?: Result | null; sort?: Sort; legLengths?: number[] } = {},
): Row[] {
  results = results.map(punched)
  extra = extra && punched(extra)
  // Each name's runs by date, to number them.
  const byName = new Map<string, Result[]>()
  for (const r of [...results].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = sameName(r.name)
    byName.set(key, [...(byName.get(key) ?? []), r])
  }
  const label = (r: Result) => {
    const runs = byName.get(sameName(r.name)) ?? []
    return allRuns && runs.length > 1 ? `${r.name} (${runs.indexOf(r) + 1})` : r.name
  }
  const shown = allRuns
    ? results
    : [...byName.values()].map(runs => runs.reduce((best, r) => (runTime(r) < runTime(best) ? r : best)))

  const placeOf = (values: number[], value: number) => values.filter(v => v < value).length + 1
  const count = Math.max(0, ...shown.map(r => r.splits.length))
  const column = (index: number, of: (r: Result) => number[]) => shown.map(r => of(r)[index]!).filter(Number.isFinite)
  const legColumns = Array.from({ length: count }, (_, i) => column(i, legTimes))
  const splitColumns = Array.from({ length: count }, (_, i) => column(i, r => r.splits))
  const references = legColumns.map(referenceTime)
  const weights = Array.from({ length: count }, (_, i) => legLengths[i] ?? 1)
  const times = shown.map(runTime)
  const best = Math.min(...times)

  const row = (result: Result, placed: boolean): Row => {
    const legs = legTimes(result)
    return {
      result,
      place: placed ? placeOf(times, runTime(result)) : null,
      label: label(result),
      behind: runTime(result) - (Number.isFinite(best) ? best : runTime(result)),
      legs,
      legPlaces: legs.map((t, i) => (placed ? placeOf(legColumns[i] ?? [], t) : null)),
      splitPlaces: result.splits.map((t, i) => (placed ? placeOf(splitColumns[i] ?? [], t) : null)),
      mistakes: mistakes(legs, references, weights),
    }
  }
  const rows = shown.map(r => row(r, true))
  if (extra) rows.push(row(extra, false))
  const key = (r: Row): number =>
    sort.by === 'leg' || sort.by === 'split'
      ? ((sort.by === 'leg' ? r.legs : r.result.splits)[sort.index] ?? Infinity)
      : runTime(r.result)
  const byLabel = (a: Row, b: Row) => (sort.by === 'name' ? a.label.localeCompare(b.label) : 0)
  return rows.sort((a, b) => byLabel(a, b) || key(a) - key(b) || (a.place === null ? 1 : 0) - (b.place === null ? 1 : 0))
}

// ------------------------------------------------------------------ the server

const url = (map: string, key: string) => `/results/${encodeURIComponent(map)}/${key}.json`

// The key that deletes each result saved in this browser, by result id.
const DELETE_KEYS = 'terraino.deleteKeys'
// The admin key, which deletes any result; ?admin=<key> stores it.
const ADMIN_KEY = 'terraino.adminKey'

function deleteKeys(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DELETE_KEYS) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function storeDeleteKeys(keys: Record<string, string>) {
  try {
    localStorage.setItem(DELETE_KEYS, JSON.stringify(keys))
  } catch {
    // Not remembered: the result can then only be deleted with the admin key.
  }
}

function adminKey(): string | null {
  try {
    return localStorage.getItem(ADMIN_KEY)
  } catch {
    return null
  }
}

/** Keep an admin key given as ?admin=<key>, and take it out of the address. */
export function takeAdminKey() {
  const params = new URLSearchParams(location.search)
  const key = params.get('admin')
  if (key === null) return
  try {
    if (key) localStorage.setItem(ADMIN_KEY, key)
    else localStorage.removeItem(ADMIN_KEY)
  } catch {
    // Not remembered.
  }
  params.delete('admin')
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`)
}

/** Whether this browser may delete a result: it saved it, or it has the admin key. */
export const canDelete = (id: string): boolean => id in deleteKeys() || adminKey() !== null

/** The results list for a course on a map, or null if it has none yet. */
export async function fetchResults(map: string, key: string): Promise<ResultsFile | null> {
  const response = await fetch(url(map, key), { cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return (await response.json()) as ResultsFile
}

/** Add a result to a course's list, keeping the key that deletes it; returns the list as saved. */
export async function saveResult(map: string, key: string, course: ResultsCourse, result: Result): Promise<ResultsFile> {
  const response = await fetch(url(map, key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course, result }),
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  const { deleteKey, ...file } = (await response.json()) as SavedResults
  storeDeleteKeys({ ...deleteKeys(), [result.id]: deleteKey })
  return file
}

/** Delete a result from a course's list; returns the list as left. */
export async function deleteResult(map: string, key: string, id: string): Promise<ResultsFile> {
  const keys = deleteKeys()
  const response = await fetch(`${url(map, key)}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${keys[id] ?? adminKey() ?? ''}` },
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  delete keys[id]
  storeDeleteKeys(keys)
  return (await response.json()) as ResultsFile
}
