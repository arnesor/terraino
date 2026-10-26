// Courses from an OCAD course setting file: the controls of each course with their
// IOF control descriptions, in projected coordinates, and where the description table
// goes on the map.

import { type OcadFile, type ParameterString, param, readOcad } from './reader'

/** Projected coordinates (easting, northing). */
export type Point = [number, number]

/** IOF control description columns C–H as OCAD codes (for example d "2.004"), and free text. */
export interface Description {
  c?: string
  d?: string
  e?: string
  f?: string
  g?: string
  h?: string
  text?: string
}

export type ControlKind = 'start' | 'control' | 'finish'

export interface CourseControl {
  kind: ControlKind
  code: string
  /** Centre of the control circle (the control feature). */
  position: Point
  description: Description
  /** Where OCAD puts the control number on the map (baseline start), if it does. */
  numberAt?: Point
}

export interface ImportedCourse {
  event: string
  name: string
  /** Straight legs from start to finish, in metres. */
  lengthM: number
  climbM?: number
  controls: CourseControl[]
  /** Top-left corner of the description table on the map, and the size of its boxes. */
  table: { topLeft: Point; boxM: number } | null
  /** Height of control numbers on the map, in metres. */
  numberSizeM: number
}

export interface CourseFile {
  courses: ImportedCourse[]
  /** Every control in the file, also those no course uses (they stand in the terrain too). */
  controls: CourseControl[]
  /** UTM zone of the file's georeferencing, if it is known. */
  zone: number | null
  /** The event title from the course setting settings, or '' if the file has none. */
  event: string
  /** File name of the map the courses were set on (OCAD's background map), if it is known. */
  setOn: string | null
}

// Parameter string types.
const COURSE = 2
const BACKGROUND_MAP = 8
const COURSE_SETTING = 1031
const SCALE_PAR = 1039
// Course setting symbols are numbered 7xx; OCAD stores symbol numbers times 1000.
const isCourseSymbol = (sym: number) => sym >= 700000 && sym < 800000
const PLACEHOLDER = '720.0'
const CONTROL_NUMBER = '704.0'
const DEFAULT_BOX_MM = 6
const DEFAULT_NUMBER_MM = 4
// OCAD paper units are 1/100 mm.
const PAPER_UNITS_PER_M = 100_000
// A text box is about this much taller than the font size.
const LINE_HEIGHT = 1.2

/** Turns OCAD paper coordinates into projected coordinates. */
export class Georef {
  readonly scale: number
  readonly origin: Point
  readonly grivation: number
  readonly offset: Point

  constructor(scalePar: ParameterString | undefined, offset: Point = [0, 0]) {
    this.scale = Number(param(scalePar, 'm', '10000')) || 10000
    this.origin = [Number(param(scalePar, 'x', '0')) || 0, Number(param(scalePar, 'y', '0')) || 0]
    this.grivation = ((Number(param(scalePar, 'a', '0')) || 0) * Math.PI) / 180
    this.offset = offset
  }

  /** Metres on the ground per paper unit. */
  get metresPerUnit(): number {
    return this.scale / PAPER_UNITS_PER_M
  }

  toProjected([x, y]: [number, number]): Point {
    // Paper is turned by the grivation against grid north.
    const c = Math.cos(-this.grivation)
    const s = Math.sin(-this.grivation)
    const k = this.metresPerUnit
    return [
      this.origin[0] + (x * c - y * s) * k + this.offset[0],
      this.origin[1] + (x * s + y * c) * k + this.offset[1],
    ]
  }
}

/** UTM zone of OCAD's georeferencing: an EPSG code 326zz / 258zz, or OCAD grid id 20zz. */
function utmZone(scalePar: ParameterString | undefined): number | null {
  const epsg = Number(param(scalePar, 'e'))
  if ((epsg > 32600 && epsg <= 32660) || (epsg > 25800 && epsg <= 25860)) return epsg % 100
  const grid = Number(param(scalePar, 'i'))
  if (grid > 2000 && grid <= 2060) return grid - 2000
  return null
}

interface ControlObject {
  kind: string
  code: string
  at: [number, number]
  description: Description
}

/** A course setting object string: `<type digit><code>\tY<type>\ta<code>\td<symbol>…`. */
function controlObject(objectString: string, at: [number, number]): ControlObject | null {
  const fields = new Map<string, string>()
  for (const field of objectString.split('\t').slice(1)) {
    if (field) fields.set(field[0]!, field.slice(1))
  }
  const kind = fields.get('Y')
  const code = fields.get('a')
  if (!kind || !code) return null
  const description: Description = {}
  for (const column of ['c', 'd', 'e', 'f', 'g', 'h'] as const) {
    const value = fields.get(column)
    if (value) description[column] = value
  }
  const text = fields.get('t')
  if (text) description.text = text
  return { kind, code, at, description }
}

const KINDS: Record<string, ControlKind> = { s: 'start', c: 'control', f: 'finish' }

function legLength(controls: CourseControl[]): number {
  let length = 0
  for (let i = 1; i < controls.length; i++) {
    const [ax, ay] = controls[i - 1]!.position
    const [bx, by] = controls[i]!.position
    length += Math.hypot(bx - ax, by - ay)
  }
  return length
}

export function coursesFromOcad(file: OcadFile, offset: Point = [0, 0]): CourseFile {
  const byType = (type: number) => file.strings.filter(s => s.type === type)
  const scalePar = byType(SCALE_PAR)[0]
  const settings = byType(COURSE_SETTING)[0]
  const georef = new Georef(scalePar, offset)

  const controls = new Map<string, ControlObject>()
  let placeholder: [number, number] | null = null
  // Control number positions, by course name and control code.
  const numbers = new Map<string, { at: [number, number]; height: number }>()
  for (const o of file.objects) {
    const first = o.points[0]
    if (!first) continue
    if (o.symbol === CONTROL_NUMBER && o.objectString) {
      const [course = '', codeField = ''] = o.objectString.split('\t')
      // Points: the text anchor, then the corners of its box.
      const ys = o.points.slice(1).map(p => p[1])
      const height = ys.length ? (Math.max(...ys) - Math.min(...ys)) / LINE_HEIGHT : 0
      if (codeField.startsWith('d')) numbers.set(`${course}\t${codeField.slice(1)}`, { at: first, height })
      continue
    }
    if (!o.objectString) continue
    const control = controlObject(o.objectString, first)
    if (!control) continue
    if (control.kind === 'd' || o.symbol === PLACEHOLDER) placeholder ??= first
    else controls.set(control.code, control)
  }

  const boxMm = Number(param(settings, 's', String(DEFAULT_BOX_MM))) || DEFAULT_BOX_MM
  const boxM = (boxMm * georef.scale) / 1000
  const table = placeholder ? { topLeft: georef.toProjected(placeholder), boxM } : null
  const event = param(settings, 'e')

  const courses: ImportedCourse[] = []
  for (const s of byType(COURSE)) {
    const list: CourseControl[] = []
    let numberHeight = 0
    for (const [code, value] of s.pairs) {
      const kind = KINDS[code]
      const control = kind ? controls.get(value) : undefined
      if (!kind || !control) continue
      const number = numbers.get(`${s.first}\t${value}`)
      if (number) numberHeight = Math.max(numberHeight, number.height)
      list.push({
        kind,
        code: control.code,
        position: georef.toProjected(control.at),
        description: control.description,
        ...(number && kind === 'control' ? { numberAt: georef.toProjected(number.at) } : {}),
      })
    }
    if (list.length < 2) continue
    courses.push({
      event,
      name: s.first,
      lengthM: legLength(list),
      controls: list,
      table,
      numberSizeM: numberHeight ? numberHeight * georef.metresPerUnit : (DEFAULT_NUMBER_MM * georef.scale) / 1000,
    })
  }
  const all = [...controls.values()]
    .filter(c => c.kind === 'c')
    .map(c => ({ kind: 'control' as const, code: c.code, position: georef.toProjected(c.at), description: c.description }))
  // Background maps are stored with the course setter's full path, often a Windows one.
  const setOn = byType(BACKGROUND_MAP)[0]?.first.split(/[\\/]/).pop() || null
  return { courses, controls: all, zone: utmZone(scalePar), event, setOn }
}

export function readCourseFile(buffer: ArrayBuffer, offset: Point = [0, 0]): CourseFile {
  return coursesFromOcad(readOcad(buffer, isCourseSymbol), offset)
}
