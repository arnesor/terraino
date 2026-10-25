import type { Control, Course } from './course'

// Results lists, one per course. The Vite server keeps them in results/<map>/<key>.json
// (docs/adr/0001-results-stored-by-the-vite-server.md); this module is what the viewer
// needs to read, write and rank them.

/** One finished run in competition mode. */
export interface Result {
  id: string
  name: string
  /** When the run was finished (real time), as an ISO date. */
  date: string
  /** Split times in seconds of game time, one per control after the start; the last is the run time. */
  splits: number[]
  /** Where the runner went: projected positions, one per second of game time from the start. */
  route: Control[]
}

/** What a results list is for: the course as it was when its first result was saved. */
export interface ResultsCourse {
  /** The course name from the course file, or null for a course set by hand. */
  name: string | null
  controls: Control[]
  /** Control codes from the course file, one per control, or null. */
  codes: string[] | null
}

export interface ResultsFile {
  course: ResultsCourse
  results: Result[]
}

export const MAX_NAME_LENGTH = 40

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
  /** True where this row has the best leg or split time of the placed rows. */
  bestLegs: boolean[]
  bestSplits: boolean[]
}

/** How the table is sorted: by run time, or by one leg's leg time or split time. */
export type Sort = { by: 'time' } | { by: 'leg' | 'split'; index: number }

export const runTime = (result: Result): number => result.splits[result.splits.length - 1]!

const legTimes = (result: Result): number[] => result.splits.map((t, i) => t - (result.splits[i - 1] ?? 0))

const sameName = (name: string) => name.trim().toLocaleLowerCase()

/**
 * The results table: each name's best result (or every result with `allRuns`), plus an
 * unplaced `extra` run that is not on the list, sorted by `sort`. Places count only
 * the placed rows; equal times share a place.
 */
export function resultsTable(
  results: Result[],
  { allRuns = false, extra = null, sort = { by: 'time' } }: { allRuns?: boolean; extra?: Result | null; sort?: Sort } = {},
): Row[] {
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
      bestLegs: legs.map((t, i) => placed && t === Math.min(...(legColumns[i] ?? []))),
      bestSplits: result.splits.map((t, i) => placed && t === Math.min(...(splitColumns[i] ?? []))),
    }
  }
  const rows = shown.map(r => row(r, true))
  if (extra) rows.push(row(extra, false))
  const key = (r: Row): number =>
    sort.by === 'time' ? runTime(r.result) : ((sort.by === 'leg' ? r.legs : r.result.splits)[sort.index] ?? Infinity)
  return rows.sort((a, b) => key(a) - key(b) || (a.place === null ? 1 : 0) - (b.place === null ? 1 : 0))
}

// ------------------------------------------------------------------ the server

const url = (map: string, key: string) => `/results/${encodeURIComponent(map)}/${key}.json`

/** The results list for a course on a map, or null if it has none yet. */
export async function fetchResults(map: string, key: string): Promise<ResultsFile | null> {
  const response = await fetch(url(map, key), { cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return (await response.json()) as ResultsFile
}

/** Add a result to a course's list; returns the list as saved. */
export async function saveResult(map: string, key: string, course: ResultsCourse, result: Result): Promise<ResultsFile> {
  const response = await fetch(url(map, key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course, result }),
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return (await response.json()) as ResultsFile
}

/** Delete a result from a course's list; returns the list as left. */
export async function deleteResult(map: string, key: string, id: string): Promise<ResultsFile> {
  const response = await fetch(`${url(map, key)}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return (await response.json()) as ResultsFile
}
