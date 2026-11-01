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

  it('puts the flag at the bottom of a pit or small depression, or on its rim', () => {
    // A pit 2 m across at (0, 0) and a small depression 8 m across at (20, 0).
    const data = world({
      kinds: ['pit', 'small_depression'],
      points: [
        [0, 0.3, -0.2, 2, 0],
        [1, 20, 0, 8, 0],
      ],
    })
    // No column G, "east part" or "top": the bottom, whichever side the runner comes from.
    expect(placeFlag({ d: '1.014' }, [1, 1], data, [30, 30])).toEqual([0.3, -0.2])
    expect(placeFlag({ d: '1.013', g: '12.304' }, [21, 1], data)).toEqual([20, 0])
    expect(placeFlag({ d: '1.013', g: '12.010' }, [21, 1], data)).toEqual([20, 0])
    // "North side": on the rim, the radius north of the centre (scene north is -z).
    const [x, z] = placeFlag({ d: '1.014', g: '12.101' }, [1, 1], data)
    expect(x).toBeCloseTo(0.3)
    expect(z).toBeCloseTo(-1.2)
    const [wx, wz] = placeFlag({ d: '1.013', g: '12.122' }, [21, 1], data)
    expect(wx).toBeCloseTo(16)
    expect(wz).toBeCloseTo(0)
  })

  it('puts the flag on top of an earth wall, or at its foot on the named side', () => {
    // An earth wall running east from (0, 0) to (20, 0).
    const data = world({
      lines: [
        {
          kind: 'earth_wall',
          points: [
            [0, 0],
            [10, 0],
            [20, 0],
          ],
        },
      ],
    })
    // No column G: on top, nearest the circle centre, whichever side the runner comes from.
    expect(placeFlag({ d: '1.006' }, [8, 3], data, [8, 30])).toEqual([8, 0])
    // "North side" and "south foot": at the foot, 2 m out (scene north is -z).
    const [nx, nz] = placeFlag({ d: '1.006', g: '12.101' }, [8, 3], data)
    expect(nx).toBeCloseTo(8)
    expect(nz).toBeCloseTo(-2)
    const [sx, sz] = placeFlag({ d: '1.006', g: '12.123' }, [8, 3], data)
    expect(sx).toBeCloseTo(8)
    expect(sz).toBeCloseTo(2)
    // "East end": beyond the east end, at the foot of the rounded end.
    const [ex, ez] = placeFlag({ d: '1.006', g: '12.704' }, [8, 3], data)
    expect(ex).toBeCloseTo(22)
    expect(ez).toBeCloseTo(0)
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
