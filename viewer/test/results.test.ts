import { describe, expect, it } from 'vitest'
import { courseKey, legLengths, type Result, resultsTable, weightedMedian } from '../src/results'

/** A result with these split times (seconds) on a three-leg course. */
function result(name: string, splits: number[], date = '2026-10-25T12:00:00Z'): Result {
  return { id: `${name}-${date}`.replace(/[^\w-]/g, '_'), name, date, splits, route: [] }
}

describe('results table', () => {
  const ola = result('Ola', [60, 200, 300])
  const kari = result('Kari', [70, 180, 290])
  const per = result('Per', [65, 190, 300])

  it('is sorted by run time, with places per leg and split', () => {
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
    // Ola's last leg (100) is the best; Ola has the fastest first leg too.
    expect(rows[1]!.legPlaces).toEqual([1, 3, 1])
  })

  it('sorts by a leg time or a split time', () => {
    expect(resultsTable([ola, kari, per], { sort: { by: 'leg', index: 1 } }).map(r => r.label)).toEqual(['Kari', 'Per', 'Ola'])
    expect(resultsTable([ola, kari, per], { sort: { by: 'split', index: 0 } }).map(r => r.label)).toEqual(['Ola', 'Per', 'Kari'])
  })

  it('counts split times in whole seconds, as punched, so equal leg times share a place', () => {
    // Both legs to the finish show as 1:08; unrounded they are 68.6 and 68.2 s.
    const a = result('A', [60.3, 128.9])
    const b = result('B', [61.7, 129.9])
    const rows = resultsTable([a, b])
    expect(rows.map(r => r.result.splits)).toEqual([
      [60, 128],
      [61, 129],
    ])
    expect(rows.map(r => r.legs)).toEqual([
      [60, 68],
      [61, 68],
    ])
    expect(rows.map(r => r.legPlaces[1])).toEqual([1, 1])
    expect(rows.map(r => r.behind)).toEqual([0, 1])
  })

  it('sorts by name', () => {
    expect(resultsTable([ola, kari, per], { sort: { by: 'name' } }).map(r => r.label)).toEqual(['Kari', 'Ola', 'Per'])
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
    expect(rows[0]!.behind).toBe(-40)
  })
})

describe('mistakes', () => {
  // Eight runners on four legs of equal length. The fastest quarter is two runners, so the
  // reference times are the means of the two fastest leg times: 100, 200, 300, 400.
  const legs = [
    [100, 200, 300, 400],
    [100, 200, 300, 400],
    [110, 220, 330, 440],
    [120, 240, 360, 480],
    [130, 260, 390, 520],
    [140, 280, 420, 560],
    [150, 300, 450, 600],
    [160, 320, 480, 640],
  ]
  const splits = (times: number[]) => times.map((_, i) => times.slice(0, i + 1).reduce((a, b) => a + b))
  const field = legs.map((times, i) => result(`R${i}`, splits(times)))

  it('finds none for runners who run every leg at their normal performance', () => {
    for (const row of resultsTable(field)) expect(row.mistakes).toEqual([null, null, null, null])
  })

  it('marks a leg whose time loss is above both 30 s and 20 % of the normal leg time', () => {
    // Normally 1.2 times the reference: 120, 240, 360, 480. Leg 2 takes 120 s more (50 %).
    const bom = result('Bom', splits([120, 360, 360, 480]))
    const row = resultsTable([...field, bom]).find(r => r.label === 'Bom')!
    expect(row.mistakes.map(m => m && { loss: Math.round(m.loss), share: m.share.toFixed(2) })).toEqual([
      null,
      { loss: 120, share: '0.50' },
      null,
      null,
    ])
  })

  it('needs both thresholds', () => {
    // 50 s lost on a 400 s leg is 12.5 %; 25 s lost on a 100 s leg is 25 %.
    const row = (times: number[]) => resultsTable([...field, result('X', splits(times))]).find(r => r.label === 'X')!
    expect(row([100, 200, 300, 450]).mistakes).toEqual([null, null, null, null])
    expect(row([125, 200, 300, 400]).mistakes).toEqual([null, null, null, null])
  })

  it('measures the unsaved run against the list, without counting it', () => {
    const fast = result('Me', splits([50, 100, 150, 400]))
    const rows = resultsTable(field, { extra: fast })
    const me = rows.find(r => r.place === null)!
    // Normal performance: 2 (half the reference); the last leg loses 200 s.
    expect(me.mistakes[3]?.loss).toBeCloseTo(200)
    // The reference times did not change: the others still run without mistakes.
    for (const row of rows.filter(r => r.place !== null)) expect(row.mistakes.every(m => m === null)).toBe(true)
  })

  it('weights the median by leg length', () => {
    // The long last leg decides the normal performance: 1.0, so the short legs are mistakes.
    const row = resultsTable([...field, result('Long', splits([200, 400, 600, 400]))], { legLengths: [1, 1, 1, 10] }).find(
      r => r.label === 'Long',
    )!
    expect(row.mistakes.map(m => m !== null)).toEqual([true, true, true, false])
  })

  it('takes the weighted median between the two middle values when they split the weight evenly', () => {
    expect(weightedMedian([1, 2, 3, 4], [1, 1, 1, 1])).toBe(2.5)
    expect(weightedMedian([1, 2, 3], [1, 1, 1])).toBe(2)
    expect(weightedMedian([1, 2, 3], [1, 1, 5])).toBe(3)
    expect(weightedMedian([1, 2], [0, 0])).toBe(1.5)
  })

  it('gives leg lengths as straight lines between the controls', () => {
    expect(legLengths([[0, 0], [3, 4], [3, 10]])).toEqual([5, 6])
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
