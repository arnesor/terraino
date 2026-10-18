import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readCourseFile } from '../src/ocad/courses'
import { OcadError, readOcad } from '../src/ocad/reader'

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url)

function load(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(fixture(name))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** WGS 84 / UTM north (Krüger series), good to well under a millimetre. */
function utm(lat: number, lon: number, zone: number): [number, number] {
  const a = 6378137
  const f = 1 / 298.257223563
  const n = f / (2 - f)
  const A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64)
  const alpha = [n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3, (13 / 48) * n ** 2 - (3 / 5) * n ** 3, (61 / 240) * n ** 3]
  const phi = (lat * Math.PI) / 180
  const lambda = ((lon - (zone * 6 - 183)) * Math.PI) / 180
  const e = (2 * Math.sqrt(n)) / (1 + n)
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)))
  const xi = Math.atan(t / Math.cos(lambda))
  const eta = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t))
  let x = eta
  let y = xi
  alpha.forEach((al, j) => {
    const k = 2 * (j + 1)
    x += al * Math.cos(k * xi) * Math.sinh(k * eta)
    y += al * Math.sin(k * xi) * Math.cosh(k * eta)
  })
  return [500000 + 0.9996 * A * x, 0.9996 * A * y]
}

/** Control id → lat/lon from OCAD's IOF XML export of the same file. */
function xmlPositions(): Map<string, [number, number]> {
  const xml = fs.readFileSync(fixture('trlop_260521.Courses.xml'), 'utf8')
  const out = new Map<string, [number, number]>()
  for (const m of xml.matchAll(/<Id>([^<]+)<\/Id>\s*<Position lng="([\d.]+)" lat="([\d.]+)"/g)) {
    out.set(m[1]!, [Number(m[3]), Number(m[2])])
  }
  return out
}

describe('OCAD course setting file', () => {
  const file = readCourseFile(load('trlop_260521.ocd'))

  it('lists the courses in the file', () => {
    expect(file.courses.map(c => c.name)).toEqual(['Lett', 'Kort', 'Mellom', 'Lang'])
    expect(file.zone).toBe(32)
  })

  it('lists every control in the file, also those no course uses', () => {
    expect(file.controls).toHaveLength(21)
    expect(file.controls.every(c => c.kind === 'control')).toBe(true)
    const lang = file.courses.find(c => c.name === 'Lang')!
    const codes = new Set(file.controls.map(c => c.code))
    for (const c of lang.controls.filter(c => c.kind === 'control')) expect(codes.has(c.code)).toBe(true)
  })

  it('reads a course in running order with its descriptions', () => {
    const lang = file.courses.find(c => c.name === 'Lang')!
    expect(lang.event).toBe('O-karusell 4')
    expect(lang.controls.map(c => c.code)).toEqual(
      ['S1', '126', '135', '136', '137', '128', '133', '134', '139', '142', '141', '138', '129', 'M1'],
    )
    expect(lang.controls[0]!.kind).toBe('start')
    expect(lang.controls.at(-1)!.kind).toBe('finish')
    expect(lang.controls[1]!.description).toEqual({ d: '2.004', g: '12.105' })
    expect(lang.controls[6]!.description).toEqual({ c: '0.104', d: '1.010', g: '12.103' })
    // Printed as 4,0 km.
    expect(lang.lengthM).toBeCloseTo(3965.5, 0)
  })

  it('places the description table and numbers where OCAD has them', () => {
    const lang = file.courses.find(c => c.name === 'Lang')!
    expect(lang.table!.boxM).toBeCloseTo(60)
    expect(lang.table!.topLeft[0]).toBeCloseTo(675000 - 8007.1, 1)
    expect(lang.table!.topLeft[1]).toBeCloseTo(6650000 - 3372.5, 1)
    expect(lang.controls[1]!.numberAt).toBeDefined()
    expect(lang.numberSizeM).toBeGreaterThan(50)
    expect(lang.numberSizeM).toBeLessThan(120)
  })

  it('georeferences controls like OCAD does', () => {
    const xml = xmlPositions()
    let compared = 0
    for (const course of file.courses) {
      for (const control of course.controls) {
        const latLon = xml.get(control.code)
        if (!latLon) continue
        const [e, n] = utm(latLon[0], latLon[1], 32)
        // The XML has 6 decimals of a degree: about 0.1 m.
        expect(Math.hypot(control.position[0] - e, control.position[1] - n)).toBeLessThan(1)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(20)
  })

  it('applies the offset the map was built with', () => {
    const shifted = readCourseFile(load('trlop_260521.ocd'), [10, -5])
    const [a, b] = [file.courses[3]!.controls[1]!.position, shifted.courses[3]!.controls[1]!.position]
    expect(b[0] - a[0]).toBeCloseTo(10)
    expect(b[1] - a[1]).toBeCloseTo(-5)
  })
})

describe('OCAD reader', () => {
  it('rejects files that are not OCAD files', () => {
    expect(() => readOcad(new ArrayBuffer(100))).toThrow(OcadError)
  })

  it('rejects OCAD versions before 12', () => {
    const buffer = load('trlop_260521.ocd')
    new DataView(buffer).setInt16(4, 11, true)
    expect(() => readOcad(buffer)).toThrow(expect.objectContaining({ reason: 'version', version: 11 }))
  })
})
