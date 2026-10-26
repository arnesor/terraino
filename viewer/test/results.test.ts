import { describe, expect, it } from 'vitest'
import { courseKey, type Result, resultsTable } from '../src/results'

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
