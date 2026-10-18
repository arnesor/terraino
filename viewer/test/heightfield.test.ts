import { describe, expect, it } from 'vitest'
import { stitchEdges, upsample } from '../src/heightfield'

/** A full chunk of n + 1 by n + 1 samples from a height function of (col, row). */
function full(n: number, f: (col: number, row: number) => number): Float32Array {
  const out = new Float32Array((n + 1) * (n + 1))
  for (let row = 0; row <= n; row++) for (let col = 0; col <= n; col++) out[row * (n + 1) + col] = f(col, row)
  return out
}

/** Every `step`-th sample of a full chunk, as the export writes coarse chunks. */
function coarsen(chunk: Float32Array, n: number, step: number): Float32Array {
  const m = n / step
  const out = new Float32Array((m + 1) * (m + 1))
  for (let r = 0; r <= m; r++) for (let c = 0; c <= m; c++) out[r * (m + 1) + c] = chunk[r * step * (n + 1) + c * step]!
  return out
}

describe('coarse height chunks', () => {
  const n = 16
  const step = 4

  it('keeps the coarse samples and interpolates between them', () => {
    // A plane is reproduced exactly by bilinear interpolation.
    const plane = full(n, (col, row) => 100 + col * 0.3 - row * 0.2)
    const up = upsample(coarsen(plane, n, step), n / step, step)
    expect(up).toHaveLength((n + 1) ** 2)
    for (let i = 0; i < up.length; i++) expect(up[i]).toBeCloseTo(plane[i]!, 4)
  })

  it('takes the shared edges from detailed neighbours', () => {
    // Chunks 0 (detailed) and 1 (coarse) side by side; the ground is bumpy.
    const bumpy = (col: number, row: number) => 100 + Math.sin(col * 1.3) * 2 + Math.cos(row * 0.7)
    const west = full(n, bumpy)
    const east = upsample(coarsen(full(n, (c, r) => bumpy(c + n, r)), n, step), n / step, step)
    stitchEdges([west, east], new Set([1]), 2, 1, n)
    for (let row = 0; row <= n; row++) expect(east[row * (n + 1)]).toBe(west[row * (n + 1) + n])
  })

  it('leaves edges between coarse chunks alone', () => {
    const a = upsample(coarsen(full(n, (c, r) => c + r), n, step), n / step, step)
    const b = upsample(coarsen(full(n, (c, r) => c + n + r), n, step), n / step, step)
    const before = b.slice()
    stitchEdges([a, b], new Set([0, 1]), 2, 1, n)
    expect(b).toEqual(before)
  })
})
