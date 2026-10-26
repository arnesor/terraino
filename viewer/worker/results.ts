// What the viewer and the results Worker exchange: results lists, and the checks a
// result must pass before it is saved. Plain TypeScript, so the browser can use it too.
//
//   GET    /results/<world>/<key>.json          the list, or 404 if it has none
//   POST   /results/<world>/<key>.json          add { course, result }; returns the list
//                                               and the result's delete key
//   DELETE /results/<world>/<key>.json?id=...   delete a result, with its delete key (or the
//                                               admin key) as a bearer token; returns the list

/** Projected coordinates (easting, northing). */
export type Point = [number, number]

/** One finished run in competition mode. */
export interface Result {
  id: string
  name: string
  /** When the run was finished (real time), as an ISO date. */
  date: string
  /** Split times in seconds of game time, one per control after the start; the last is the run time. */
  splits: number[]
  /** Where the runner went: projected positions, one per second of game time from the start. */
  route: Point[]
}

/** What a results list is for: the course as it was when its first result was saved. */
export interface ResultsCourse {
  /** The course name from the course file, or null for a course set by hand. */
  name: string | null
  controls: Point[]
  /** Control codes from the course file, one per control, or null. */
  codes: string[] | null
}

export interface ResultsFile {
  course: ResultsCourse
  results: Result[]
}

/** The answer to saving a result: the list, and the key that deletes the result. */
export interface SavedResults extends ResultsFile {
  deleteKey: string
}

export const MAX_NAME_LENGTH = 40
export const MAX_BODY = 4 * 1024 * 1024
// A route point per second: half a day of running.
const MAX_ROUTE = 43_200
const MAX_CONTROLS = 200

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && v.every(isNumber)

export function validCourse(v: unknown): v is ResultsCourse {
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

export function validResult(v: unknown, course: ResultsCourse): v is Result {
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

/** A world folder name: no path signs, and not a dot name. */
export const validWorld = (name: string): boolean => /^[\w .-]{1,64}$/.test(name) && !/^\.+$/.test(name)

/**
 * The result with only what is saved: its fields, and the route in decimetres, which keeps
 * the longest route under the database's row size.
 */
export function storedResult({ id, name, date, splits, route }: Result): Result {
  const dm = (v: number) => Math.round(v * 10) / 10
  return { id, name, date, splits, route: route.map(([e, n]) => [dm(e), dm(n)]) }
}
