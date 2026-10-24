import type { World } from './world'

const PARALLEL_REQUESTS = 12

/**
 * A chunk stored with every `step`-th sample ((m + 1)^2 values) brought back to the
 * full grid ((m * step + 1)^2 values) by bilinear interpolation.
 */
export function upsample(coarse: Float32Array, m: number, step: number): Float32Array {
  const n = m * step
  const out = new Float32Array((n + 1) * (n + 1))
  for (let row = 0; row <= n; row++) {
    const r = Math.min(Math.floor(row / step), m - 1)
    const fr = row / step - r
    for (let col = 0; col <= n; col++) {
      const c = Math.min(Math.floor(col / step), m - 1)
      const fc = col / step - c
      const i = r * (m + 1) + c
      const top = coarse[i]! * (1 - fc) + coarse[i + 1]! * fc
      const bottom = coarse[i + m + 1]! * (1 - fc) + coarse[i + m + 2]! * fc
      out[row * (n + 1) + col] = top * (1 - fr) + bottom * fr
    }
  }
  return out
}

/**
 * Give each coarse chunk the exact edge samples of its detailed neighbours: chunks share
 * their edges, and the terrain must not open a seam where detail ends.
 */
export function stitchEdges(chunks: Float32Array[], coarse: Set<number>, chunksX: number, chunksY: number, n: number) {
  const w = n + 1
  for (const index of coarse) {
    const cx = index % chunksX
    const cy = Math.floor(index / chunksX)
    const chunk = chunks[index]!
    const detailed = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < chunksX && y < chunksY && !coarse.has(y * chunksX + x) ? chunks[y * chunksX + x]! : null
    const west = detailed(cx - 1, cy)
    const east = detailed(cx + 1, cy)
    const north = detailed(cx, cy - 1)
    const south = detailed(cx, cy + 1)
    for (let k = 0; k <= n; k++) {
      if (west) chunk[k * w] = west[k * w + n]!
      if (east) chunk[k * w + n] = east[k * w]!
      if (north) chunk[k] = north[n * w + k]!
      if (south) chunk[n * w + k] = south[k]!
    }
  }
}

/** All terrain heights of a world, decoded from the chunk files. */
export class HeightField {
  readonly chunk: number
  readonly chunksX: number
  readonly chunksY: number
  readonly step: number
  private readonly chunks: Float32Array[]
  private readonly mins: Float32Array
  private readonly maxs: Float32Array

  private constructor(world: World, chunks: Float32Array[]) {
    const h = world.manifest.height
    this.chunk = h.chunk
    this.chunksX = h.chunksX
    this.chunksY = h.chunksY
    this.step = h.step
    this.chunks = chunks
    this.mins = new Float32Array(chunks.map(c => c.reduce((a, b) => Math.min(a, b), Infinity)))
    this.maxs = new Float32Array(chunks.map(c => c.reduce((a, b) => Math.max(a, b), -Infinity)))
  }

  chunkMin(cx: number, cy: number): number {
    return this.mins[cy * this.chunksX + cx]!
  }

  chunkMax(cx: number, cy: number): number {
    return this.maxs[cy * this.chunksX + cx]!
  }

  static async load(world: World, onProgress: (done: number, total: number) => void) {
    const h = world.manifest.height
    const total = h.chunksX * h.chunksY
    const chunks = new Array<Float32Array>(total)
    const coarse = new Set(h.coarse?.chunks ?? [])
    const coarseStep = h.coarse?.step ?? 1
    let next = 0
    let done = 0

    const worker = async () => {
      while (next < total) {
        const index = next++
        const cx = index % h.chunksX
        const cy = Math.floor(index / h.chunksX)
        const response = await fetch(world.url(h.path, cx, cy))
        if (!response.ok) throw new Error(`Missing height chunk ${cx}_${cy}`)
        const raw = new Uint16Array(await response.arrayBuffer())
        const heights = new Float32Array(raw.length)
        for (let i = 0; i < raw.length; i++) heights[i] = h.offset + raw[i]! * h.scale
        chunks[index] = coarse.has(index) ? upsample(heights, h.chunk / coarseStep, coarseStep) : heights
        onProgress(++done, total)
      }
    }
    await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker))
    if (coarse.size) stitchEdges(chunks, coarse, h.chunksX, h.chunksY, h.chunk)
    return new HeightField(world, chunks)
  }

  /** Heights of one chunk: (chunk + 1)^2 samples, row by row from the north-west. */
  chunkHeights(cx: number, cy: number): Float32Array {
    return this.chunks[cy * this.chunksX + cx]!
  }

  /** Height of grid sample (col, row), clamped to the grid. */
  sample(col: number, row: number): number {
    const n = this.chunk
    const maxCol = this.chunksX * n
    const maxRow = this.chunksY * n
    col = Math.min(Math.max(col, 0), maxCol)
    row = Math.min(Math.max(row, 0), maxRow)
    const cx = Math.min(Math.floor(col / n), this.chunksX - 1)
    const cy = Math.min(Math.floor(row / n), this.chunksY - 1)
    return this.chunkHeights(cx, cy)[(row - cy * n) * (n + 1) + (col - cx * n)]!
  }

  /** Bilinearly interpolated ground height at scene x/z. */
  heightAt(x: number, z: number): number {
    const gx = x / this.step
    const gz = z / this.step
    const c = Math.floor(gx)
    const r = Math.floor(gz)
    const fx = gx - c
    const fz = gz - r
    const h00 = this.sample(c, r)
    const h10 = this.sample(c + 1, r)
    const h01 = this.sample(c, r + 1)
    const h11 = this.sample(c + 1, r + 1)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
  }

  /** Terrain slope (rise over run) at scene x/z in the direction (dx, dz). */
  slopeAlong(x: number, z: number, dx: number, dz: number): number {
    const len = Math.hypot(dx, dz)
    if (len === 0) return 0
    const d = 1.0
    const ux = (dx / len) * d
    const uz = (dz / len) * d
    return (this.heightAt(x + ux, z + uz) - this.heightAt(x - ux, z - uz)) / (2 * d)
  }
}
