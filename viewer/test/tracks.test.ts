import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findCrossings, type TrackRecord } from '../src/tracks'

/** The search as it was: every path segment against every stream segment. */
function allPairs(paths: TrackRecord[], water: TrackRecord[]) {
  const found: { path: TrackRecord; i: number; water: TrackRecord; j: number; t: number }[] = []
  for (const p of paths) {
    for (let i = 0; i + 1 < p.points.length; i++) {
      const [ax, az] = p.points[i]!
      const [bx, bz] = p.points[i + 1]!
      for (const w of water) {
        for (let j = 0; j + 1 < w.points.length; j++) {
          const [cx, cz] = w.points[j]!
          const [dx, dz] = w.points[j + 1]!
          const rx = bx - ax
          const rz = bz - az
          const sx = dx - cx
          const sz = dz - cz
          const den = rx * sz - rz * sx
          if (Math.abs(den) < 1e-9) continue
          const t = ((cx - ax) * sz - (cz - az) * sx) / den
          const u = ((cx - ax) * rz - (cz - az) * rx) / den
          if (t < 0 || t > 1 || u < 0 || u > 1) continue
          found.push({ path: p, i, water: w, j, t })
        }
      }
    }
  }
  return found
}

/** A wandering line of `n` points, with steps up to `step` metres. */
function wander(seed: number, n: number, step: number, kind: string): TrackRecord {
  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  let x = rnd() * 400
  let z = rnd() * 400
  const points: [number, number][] = []
  for (let k = 0; k < n; k++) {
    points.push([x, z])
    x += (rnd() - 0.5) * step
    z += (rnd() - 0.5) * step
  }
  return { kind, width: 1, points }
}

describe('where paths cross streams', () => {
  it('finds the same crossings, in the same order, as testing every pair', () => {
    const paths = Array.from({ length: 30 }, (_, k) => wander(k + 1, 60, 40, 'path'))
    const water = Array.from({ length: 20 }, (_, k) => wander(k + 101, 60, 60, 'stream'))
    const expected = allPairs(paths, water)
    expect(expected.length).toBeGreaterThan(50)
    expect(findCrossings(paths, water)).toEqual(expected)
  })

  it('finds crossings of long segments spanning many cells', () => {
    const path: TrackRecord = { kind: 'path', width: 1, points: [[-500, 0], [500, 1]] }
    const stream: TrackRecord = { kind: 'stream', width: 2, points: [[3, -400], [4, 400]] }
    expect(findCrossings([path], [stream])).toEqual(allPairs([path], [stream]))
    expect(findCrossings([path], [stream])).toHaveLength(1)
  })

  // Langvatnet's own tracks, when the world is built here. Testing every pair took 28 s in the
  // viewer (and agreed with this search when compared once); this must take well under a second.
  const real = new URL('../../worlds/langvatnet/tracks.json', import.meta.url)
  it.runIf(fs.existsSync(real))('is quick on a whole map', () => {
    const records = JSON.parse(fs.readFileSync(real, 'utf8')) as TrackRecord[]
    const paths = records.filter(r => ['path', 'small_path', 'faint_path'].includes(r.kind))
    const water = records.filter(r => ['stream', 'small_stream', 'water_channel'].includes(r.kind))
    const start = performance.now()
    const crossings = findCrossings(paths, water)
    const took = performance.now() - start
    expect(crossings.length).toBeGreaterThan(0)
    expect(took).toBeLessThan(1000)
  })
})
