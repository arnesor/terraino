import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readCourseFile } from '../src/ocad/courses'
import {
  courseFileProblem,
  dateFromFileName,
  isDate,
  outsideMap,
  raceFrom,
  raceId,
  type RaceIndex,
  withRace,
} from '../src/races'
import type { Manifest } from '../src/world'

function load(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** A world around the O-karusell courses (controls near 664–667 km E, 6644–6648 km N). */
function manifest(crs = 'EPSG:25832', mapArea: [number, number][] = []): Manifest {
  return { crs, extent: [663344, 6643456, 668064, 6648688], mapArea } as unknown as Manifest
}

const file = readCourseFile(load('trlop_260521.ocd'))

describe('a course file on a world', () => {
  it('reads the event title and the map the courses were set on', () => {
    expect(file.event).toBe('O-karusell 4')
    expect(file.setOn).toBe('Langvatnet-Hornåsen_260521_ocad2018.ocd')
    const test = readCourseFile(load('TestCourseLangvatnet.ocd'))
    expect(test.event).toBe('')
    expect(test.setOn).toBe('LangvatnetUtsnitt.ocd')
  })

  it('fits a world in the same UTM zone', () => {
    expect(courseFileProblem(file, manifest())).toBeNull()
    expect(courseFileProblem(file, manifest('EPSG:25833'))).toEqual({ kind: 'wrongZone', course: 32, map: 33 })
    expect(courseFileProblem({ ...file, courses: [] }, manifest())).toEqual({ kind: 'noCourses' })
  })

  it('finds courses outside the map area, or the extent without one', () => {
    const lang = file.courses.find(c => c.name === 'Lang')!
    expect(outsideMap(lang, manifest())).toBe(false)
    const around: [number, number][] = [[663344, 6643456], [668064, 6643456], [668064, 6648688], [663344, 6648688]]
    expect(outsideMap(lang, manifest('EPSG:25832', around))).toBe(false)
    // A map area over the west half only: the extent alone would let the course through.
    const west: [number, number][] = [[663344, 6643456], [664000, 6643456], [664000, 6648688], [663344, 6648688]]
    expect(outsideMap(lang, manifest('EPSG:25832', west))).toBe(true)
  })
})

describe('races', () => {
  it('takes the date from the course file name', () => {
    expect(dateFromFileName('trlop_260521.ocd')).toBe('2026-05-21')
    expect(dateFromFileName('Langvatnet 20260521.ocd')).toBe('2026-05-21')
    expect(dateFromFileName('karusell-2026-05-21.ocd')).toBe('2026-05-21')
    expect(dateFromFileName('O-karusell 4.ocd')).toBeNull()
    expect(dateFromFileName('trlop_261399.ocd')).toBeNull()
    expect(dateFromFileName('map1234567.ocd')).toBeNull()
  })

  it('checks dates', () => {
    expect(isDate('2026-05-21')).toBe(true)
    expect(isDate('2026-02-30')).toBe(false)
    expect(isDate('21.05.2026')).toBe(false)
  })

  it('makes an id of the date and name', () => {
    expect(raceId('2026-05-21', 'O-karusell 4')).toBe('2026-05-21-o-karusell-4')
    expect(raceId('2026-06-01', 'Kretsløp på Hornåsen')).toBe('2026-06-01-kretslop-pa-hornasen')
    expect(raceId('2026-06-01', 'Ærfuglløpet')).toBe('2026-06-01-aerfugllopet')
    expect(raceId('2026-06-01', '!!!')).toBe('2026-06-01')
  })

  it('lists the courses of a race', () => {
    const race = raceFrom(file, 'O-karusell 4', '2026-05-21', '2026-05-21-o-karusell-4.ocd')
    expect(race.id).toBe('2026-05-21-o-karusell-4')
    expect(race.setOn).toBe('Langvatnet-Hornåsen_260521_ocad2018.ocd')
    expect(race.courses.map(c => c.name)).toEqual(['Lett', 'Kort', 'Mellom', 'Lang'])
    expect(race.courses.find(c => c.name === 'Lang')).toEqual({ name: 'Lang', controls: 12, lengthM: 3965 })
  })

  it('keeps the index newest first, with one race per id', () => {
    const race = raceFrom(file, 'O-karusell 4', '2026-05-21', 'a.ocd')
    const older = { ...race, id: '2026-05-14-o-karusell-3', name: 'O-karusell 3', date: '2026-05-14' }
    let index: RaceIndex = { races: [] }
    index = withRace(index, older)
    index = withRace(index, race)
    expect(index.races.map(r => r.id)).toEqual(['2026-05-21-o-karusell-4', '2026-05-14-o-karusell-3'])
    index = withRace(index, { ...race, file: 'b.ocd' })
    expect(index.races).toHaveLength(2)
    expect(index.races[0]!.file).toBe('b.ocd')
  })
})
