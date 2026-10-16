import type { World } from './world'

const PARALLEL_REQUESTS = 12

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
        chunks[index] = heights
        onProgress(++done, total)
      }
    }
    await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker))
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
