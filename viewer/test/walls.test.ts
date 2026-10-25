import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Gfx, QUALITY } from '../src/gfx'
import { DOOR_CORNER, DOOR_WIDTH, type TrackFinder, type WallLine, type WallSample, Walls, wallRuns } from '../src/walls'
import { syntheticWorld } from './synthetic'

/** A ruin outline: a closed rectangle from (x0, z0) to (x1, z1). */
function ruin(x0: number, z0: number, x1: number, z1: number): WallLine {
  return {
    kind: 'ruin',
    size: 0.6,
    points: [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
      [x0, z0],
    ],
  }
}

/** Tracks with one path point at (x, z). */
const pathAt = (x: number, z: number): TrackFinder => ({ nearestPoint: () => ({ x, z }) })

/** The openings between the runs around a ruin: their middle points and widths. */
function doors(runs: WallSample[][]) {
  return runs.map((run, i) => {
    const a = run[run.length - 1]!
    const b = runs[(i + 1) % runs.length]![0]!
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, width: Math.hypot(b.x - a.x, b.z - a.z), a, b }
  })
}

describe('ruins', () => {
  it('open the main door towards the nearest path, and a back door on a larger ruin', async () => {
    const { heights } = await syntheticWorld(1, 1)
    // 8 by 10 m, 36 m around: two doors. The path is east.
    const runs = wallRuns(ruin(100, 100, 108, 110), heights, pathAt(150, 104))
    expect(runs).toHaveLength(2)
    const found = doors(runs).sort((p, q) => q.x - p.x)
    expect(found[0]!.x).toBeCloseTo(108, 0) // east side, on the point nearest the path
    expect(found[0]!.z).toBeCloseTo(104, 0)
    expect(found[1]!.x).toBeCloseTo(100, 0) // west side
    for (const door of found) {
      expect(door.width).toBeCloseTo(DOOR_WIDTH, 6)
    }
  })

  it('keep their doors clear of the corners', async () => {
    const { heights } = await syntheticWorld(1, 1)
    // The path lies beyond the north-east corner, so the nearest point is the corner.
    const runs = wallRuns(ruin(100, 100, 108, 110), heights, pathAt(130, 80))
    const corners = [
      [100, 100],
      [108, 100],
      [108, 110],
      [100, 110],
    ]
    for (const { a, b } of doors(runs)) {
      for (const end of [a, b]) {
        const nearest = Math.min(...corners.map(([x, z]) => Math.hypot(end.x - x!, end.z - z!)))
        expect(nearest).toBeGreaterThan(DOOR_CORNER - 1e-6)
      }
    }
  })

  it('get one door when small, in the longest side without a path', async () => {
    const { heights } = await syntheticWorld(1, 1)
    // 4 by 6 m, 20 m around; the 6 m sides run north-south.
    const runs = wallRuns(ruin(100, 100, 104, 106), heights, null)
    expect(runs).toHaveLength(1)
    const [door] = doors(runs)
    expect([100, 104]).toContainEqual(Math.round(door!.x))
    expect(door!.z).toBeCloseTo(103, 0)
  })

  it('get a door even when very small and turned (a 3 by 3 m point ruin)', async () => {
    const { heights } = await syntheticWorld(1, 1)
    // A 3 m square turned 36°, as the pipeline makes for ISOM 2000 530.2.
    const a = (36 * Math.PI) / 180
    const corner = (u: number, v: number): [number, number] => [
      100 + u * Math.cos(a) - v * Math.sin(a),
      100 + u * Math.sin(a) + v * Math.cos(a),
    ]
    const square = [corner(-1.5, -1.5), corner(1.5, -1.5), corner(1.5, 1.5), corner(-1.5, 1.5)]
    const runs = wallRuns({ kind: 'ruin', size: 0.5, points: [...square, square[0]!] }, heights, pathAt(120, 100))
    expect(runs).toHaveLength(1)
    const [door] = doors(runs)
    expect(door!.width).toBeCloseTo(DOOR_WIDTH, 6)
    // On the side towards the path, east of the middle.
    expect(door!.x).toBeGreaterThan(100.5)
  })

  it('follow the ground, standing on the lower side', async () => {
    // Rising 0.3 m per metre east.
    const { heights } = await syntheticWorld(1, 1, col => 100 + 0.3 * col)
    for (const run of wallRuns(ruin(100, 100, 108, 110), heights, null)) {
      for (const p of run) {
        const ground = heights.heightAt(p.x, p.z)
        expect(p.foot).toBeLessThanOrEqual(ground + 1e-6)
        expect(p.foot).toBeGreaterThan(ground - 0.3) // at most half the width downhill
        expect(p.foot + p.height).toBeGreaterThan(ground)
      }
    }
  })
})

describe('stone walls', () => {
  it('have no doors and keep most of their height', async () => {
    const { heights } = await syntheticWorld(1, 1)
    const wall: WallLine = {
      kind: 'stone_wall',
      size: 0.9,
      points: [
        [50, 50],
        [80, 50],
        [80, 70],
      ],
    }
    const runs = wallRuns(wall, heights, pathAt(65, 60))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.at(-1)!.s).toBeCloseTo(50, 6)
    for (const p of runs[0]!) expect(p.height).toBeGreaterThanOrEqual(0.9 * 0.8 - 1e-6)
  })
})

describe('single stones', () => {
  it('are drawn only near the player, farther on a higher quality', async () => {
    const { heights } = await syntheticWorld(1, 1)
    const gfx = { groundArray: new THREE.DataArrayTexture() } as unknown as Gfx
    const walls = new Walls([ruin(100, 100, 108, 110)], heights, gfx, QUALITY.low, null)
    expect(walls.drawn).toBe(0)
    walls.update(new THREE.Vector3(104, 100, 105))
    expect(walls.drawn).toBeGreaterThan(100)
    // 60 m away: beyond low's 30 m (+10 m), within high's 70 m.
    const away = new THREE.Vector3(164, 100, 105)
    walls.update(away)
    expect(walls.drawn).toBe(0)
    walls.setQuality(QUALITY.high)
    walls.update(away)
    expect(walls.drawn).toBeGreaterThan(100)
  })
})
