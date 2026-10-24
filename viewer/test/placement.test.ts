import { describe, expect, it } from 'vitest'
import { type PlacementData, placeFlag } from '../src/placement'

function world(parts: Partial<PlacementData> = {}): PlacementData {
  return { kinds: ['boulder', 'stone'], points: [], lines: [], cliffs: [], buildings: [], ...parts }
}

// Scene z points south: north is -z.
describe('control flag placement', () => {
  it('puts the flag on the named side of a boulder, clear of the rock', () => {
    const data = world({ points: [[0, 1, 2, 1.5, 0]] })
    const [x, z] = placeFlag({ d: '2.004', g: '12.101' }, [0, 0], data)
    expect(x).toBeCloseTo(1)
    expect(z).toBeLessThan(2 - 1.5 * 0.8)
    const [nx, nz] = placeFlag({ d: '2.004', g: '12.105' }, [0, 0], data)
    expect(nx).toBeLessThan(1)
    expect(nz).toBeLessThan(2)
  })

  it('puts the flag at the named corner of a building, outside it', () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const data = world({ buildings: [square] })
    // North-west corner: west (small x) and north (small z).
    const [x, z] = placeFlag({ d: '5.011', g: '12.505' }, [5, 5], data)
    expect(x).toBeLessThan(0)
    expect(z).toBeLessThan(0)
    // North side: above the middle of the north wall.
    const [sx, sz] = placeFlag({ d: '5.011', g: '12.101' }, [5, 5], data)
    expect(sx).toBeCloseTo(5)
    expect(sz).toBeCloseTo(-0.6)
  })

  it('puts the flag at the foot of a cliff by default', () => {
    const data = world({
      cliffs: [
        {
          top: [
            [0, 10, 0],
            [10, 10, 0],
          ],
          bottom: [
            [0, 7, 1],
            [10, 7, 1],
          ],
        },
      ],
    })
    const [x, z] = placeFlag({ d: '2.001' }, [5, 0.5], data)
    expect(x).toBeCloseTo(5)
    expect(z).toBeGreaterThan(1)
  })

  it('finds the foot of a hill in the terrain', () => {
    // A cone 5 m high and 20 m across on flat ground.
    const heightAt = (x: number, z: number) => Math.max(0, 5 - Math.hypot(x, z) / 2)
    const [x, z] = placeFlag({ d: '1.009', g: '12.122' }, [0, 0], world({ heightAt }))
    expect(x).toBeLessThan(-9)
    expect(x).toBeGreaterThan(-13)
    expect(Math.abs(z)).toBeLessThan(1)
  })

  it('leaves the flag at the centre when the feature is unknown', () => {
    expect(placeFlag({ d: '4.004' }, [3, 4], world())).toEqual([3, 4])
  })
})
