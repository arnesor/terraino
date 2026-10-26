// Races: the courses of one event, set in one course setting file. They are kept next to
// the worlds in races/<world>/, the course files with an index.json that lists them
// (docs/adr/0002-races-kept-as-files-next-to-the-worlds.md). `npm run add-race` adds one;
// the start screen lists them, so runners need no course file of their own.

import type { CourseFile, ImportedCourse } from './ocad/courses'
import { inside } from './placement'
import type { Manifest } from './world'

export interface RaceCourse {
  name: string
  controls: number
  lengthM: number
}

export interface Race {
  /** The date and name as one word, for example "2026-05-21-o-karusell-4". */
  id: string
  name: string
  /** The day the race was run, as YYYY-MM-DD. */
  date: string
  /** The course setting file in races/<world>/. */
  file: string
  /** File name of the map the courses were set on, from the course file, if it is known. */
  setOn: string | null
  courses: RaceCourse[]
}

export interface RaceIndex {
  races: Race[]
}

/** Why a course file cannot be used on a world, as the text key and its values. */
export type CourseFileProblem = { kind: 'noCourses' } | { kind: 'wrongZone'; course: number; map: number }

/** UTM zone of an EPSG code such as EPSG:25832 or EPSG:32632. */
export function utmZone(crs: string): number | null {
  const code = Number(crs.split(':')[1])
  return (code > 25800 && code <= 25860) || (code > 32600 && code <= 32660) ? code % 100 : null
}

export function courseFileProblem(file: CourseFile, manifest: Manifest): CourseFileProblem | null {
  const zone = utmZone(manifest.crs)
  if (file.zone !== null && zone !== null && file.zone !== zone) return { kind: 'wrongZone', course: file.zone, map: zone }
  if (!file.courses.length) return { kind: 'noCourses' }
  return null
}

/** Whether a course has a control outside the map area (or the extent, for a world without one). */
export function outsideMap(course: ImportedCourse, manifest: Manifest): boolean {
  const [x0, y0, x1, y1] = manifest.extent
  const area = manifest.mapArea.length ? manifest.mapArea : null
  return course.controls.some(({ position: [e, n] }) =>
    area ? !inside([e, n], area) : e < x0 || e > x1 || n < y0 || n > y1,
  )
}

/**
 * The date in a course file's name, as YYYY-MM-DD: 2026-05-21, 20260521 or 260521
 * (as in trlop_260521.ocd), or null if it has none.
 */
export function dateFromFileName(name: string): string | null {
  const match = /(?<!\d)(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})|(\d{2})(\d{2})(\d{2}))(?!\d)/.exec(name)
  if (!match) return null
  const [y, m, d] = match[1] ? match.slice(1, 4) : match[4] ? match.slice(4, 7) : [`20${match[7]}`, match[8], match[9]]
  const date = `${y}-${m}-${d}`
  return isDate(date) ? date : null
}

/** Whether a text is a real day as YYYY-MM-DD. */
export function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text)
}

/** A race's id: its date and name in lower case, with æøå spelt out and other signs as dashes. */
export function raceId(date: string, name: string): string {
  const word = name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return word ? `${date}-${word}` : date
}

/** A race from a course file that fits the world. */
export function raceFrom(file: CourseFile, name: string, date: string, fileName: string): Race {
  return {
    id: raceId(date, name),
    name,
    date,
    file: fileName,
    setOn: file.setOn,
    courses: file.courses.map(c => ({
      name: c.name,
      controls: c.controls.filter(x => x.kind === 'control').length,
      lengthM: Math.round(c.lengthM),
    })),
  }
}

/** The index with a race added, or put in place of the race with its id; newest first. */
export function withRace(index: RaceIndex, race: Race): RaceIndex {
  const races = [...index.races.filter(r => r.id !== race.id), race]
  races.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
  return { races }
}

// ------------------------------------------------------------------ the server

const base = (world: string) => `/races/${encodeURIComponent(world)}/`

/** The races on a world, newest first; none if it has no index. */
export async function listRaces(world: string): Promise<Race[]> {
  const response = await fetch(base(world) + 'index.json', { cache: 'no-cache' })
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return ((await response.json()) as RaceIndex).races
}

/** The course setting file of a race. */
export async function fetchRaceFile(world: string, race: Race): Promise<ArrayBuffer> {
  const response = await fetch(base(world) + encodeURIComponent(race.file))
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.arrayBuffer()
}
