import * as THREE from 'three'
import type { HeightField } from './heightfield'
import { type ChunkLayer, Ground, type LayerStore } from './layers'

// Standing grain: cards of stalks near the player (see undergrowth.ts), and farther out
// a surface at the height of the ears over the grain fields, with walls along their edges.
// Their materials are in grainMaterial.ts.

/** Height of the grain (m). */
export const GRAIN_HEIGHT = 0.9
// The surface follows the fields on a grid of this step (m); the verges hide the error.
const STEP = 2
// The walls reach this far below the ground, to close gaps on slopes.
const WALL_FOOT = 0.15

/** A point of the outline walk in a cell, in metres from the chunk's north-west sample. */
interface RingPoint {
  /** Position on the half-step grid, which names the point in the cells that share it. */
  key: number
  x: number
  z: number
  /** On a cell edge, where the outline crosses it (not a corner). */
  mid: boolean
}

/**
 * The grain surface of one chunk, or null if it has no grain: the outline of the grain
 * lifted to GRAIN_HEIGHT, with walls down to the ground along it. The outline is found by
 * marching squares on a STEP grid, where the share of grain samples around each point
 * crosses one half. Positions are relative to the chunk's north-west sample.
 */
export function grainSurface(layer: ChunkLayer, cx: number, cy: number, heights: HeightField): THREE.BufferGeometry | null {
  const n = heights.chunk
  const m = n / STEP
  const x0 = cx * n
  const z0 = cy * n
  const sample = { ground: 0, canopy: 0, shrubs: 0, speed: 0 }
  const grainAt = (col: number, row: number) => (layer.sample(col, row, sample).ground === Ground.grain ? 1 : 0)
  // On the chunk's edge only the samples along the edge count, which the neighbouring
  // chunk has too: both find the same outline there.
  const value = new Float32Array((m + 1) * (m + 1))
  let any = false
  for (let j = 0; j <= m; j++) {
    for (let i = 0; i <= m; i++) {
      const col = i * STEP
      const row = j * STEP
      const dc = col > 0 && col < n ? 1 : 0
      const dr = row > 0 && row < n ? 1 : 0
      let sum = 0
      for (let r = row - dr; r <= row + dr; r++) for (let c = col - dc; c <= col + dc; c++) sum += grainAt(c, r)
      const v = sum / ((2 * dc + 1) * (2 * dr + 1))
      value[j * (m + 1) + i] = v
      any ||= v > 0.5
    }
  }
  if (!any) return null

  const positions: number[] = []
  const normals: number[] = []
  const grain: number[] = []
  const indices: number[] = []
  // Top vertices are shared between the cells.
  const top = new Map<number, number>()
  const normal = new THREE.Vector3()
  const topVertex = (p: RingPoint): number => {
    let index = top.get(p.key)
    if (index === undefined) {
      const wx = x0 + p.x
      const wz = z0 + p.z
      normal
        .set(heights.heightAt(wx - 1, wz) - heights.heightAt(wx + 1, wz), 2, heights.heightAt(wx, wz - 1) - heights.heightAt(wx, wz + 1))
        .normalize()
      index = positions.length / 3
      positions.push(p.x, heights.heightAt(wx, wz) + GRAIN_HEIGHT, p.z)
      normals.push(normal.x, normal.y, normal.z)
      grain.push(0, 1)
      top.set(p.key, index)
    }
    return index
  }
  // A wall from a to b, facing away from the direction `inward`.
  const wall = (a: RingPoint, b: RingPoint, inward: [number, number]) => {
    // Its front faces (-dz, dx); swap the ends to turn it outwards.
    if (-(b.z - a.z) * inward[0] + (b.x - a.x) * inward[1] > 0) [a, b] = [b, a]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 1e-6) return
    const nx = -(b.z - a.z) / len
    const nz = (b.x - a.x) / len
    const base = positions.length / 3
    for (const { x, z } of [a, b]) {
      const ground = heights.heightAt(x0 + x, z0 + z)
      positions.push(x, ground + GRAIN_HEIGHT, z, x, ground - WALL_FOOT, z)
      normals.push(nx, 0, nz, nx, 0, nz)
      grain.push(1, 1, 1, 0)
    }
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
  }

  // Cell corners in order around the cell.
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const side = 2 * m + 1
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const v = corners.map(([di, dj]) => value[(j + dj) * (m + 1) + i + di]!)
      const at = v.map(x => x > 0.5)
      const count = at.filter(Boolean).length
      if (count === 0) continue
      // Walk around the cell: corners inside, and where the edges cross out of the field.
      const ring: RingPoint[] = []
      for (let k = 0; k < 4; k++) {
        const [ai, aj] = corners[k]!
        const [bi, bj] = corners[(k + 1) % 4]!
        if (at[k]) {
          const key = 2 * (j + aj) * side + 2 * (i + ai)
          ring.push({ key, x: (i + ai) * STEP, z: (j + aj) * STEP, mid: false })
        }
        if (at[k] !== at[(k + 1) % 4]) {
          const t = (0.5 - v[k]!) / (v[(k + 1) % 4]! - v[k]!)
          const key = (2 * j + aj + bj) * side + 2 * i + ai + bi
          const x = (i + ai + t * (bi - ai)) * STEP
          const z = (j + aj + t * (bj - aj)) * STEP
          ring.push({ key, x, z, mid: true })
        }
      }
      const ids = ring.map(topVertex)
      // A fan, wound to face up (counter-clockwise seen from above, with z south).
      for (let k = 1; k + 1 < ids.length; k++) indices.push(ids[0]!, ids[k + 1]!, ids[k]!)
      if (count === 4) continue
      // Walls where the outline runs between two edge crossings. The next point of the
      // walk is a corner inside the field.
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!
        const b = ring[(k + 1) % ring.length]!
        if (!a.mid || !b.mid) continue
        const c = ring[(k + 2) % ring.length]!
        wall(a, b, [2 * c.x - a.x - b.x, 2 * c.z - a.z - b.z])
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('aGrain', new THREE.Float32BufferAttribute(grain, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/** Grain surfaces of the chunks whose ground layers are loaded; built one per frame. */
export class GrainFields {
  readonly group = new THREE.Group()
  private readonly layers: LayerStore
  private readonly heights: HeightField
  private readonly material: THREE.Material
  // Per chunk: the layer it was built from and its mesh (null without grain).
  private readonly built = new Map<string, { layer: ChunkLayer; mesh: THREE.Mesh | null }>()

  constructor(layers: LayerStore, heights: HeightField, material: THREE.Material) {
    this.layers = layers
    this.heights = heights
    this.material = material
    this.group.name = 'grain'
  }

  /** Meshes built so far. */
  get meshes(): THREE.Mesh[] {
    return [...this.built.values()].flatMap(b => (b.mesh ? [b.mesh] : []))
  }

  /** Drop surfaces whose layer has gone and build at most `limit` missing ones. */
  update(limit = 1) {
    for (const [key, entry] of this.built) {
      const [cx, cy] = key.split('_').map(Number) as [number, number]
      if (this.layers.get(cx, cy) === entry.layer) continue
      this.remove(entry.mesh)
      this.built.delete(key)
    }
    let built = 0
    for (const [cx, cy, layer] of this.layers.entries()) {
      if (built >= limit) return
      const key = `${cx}_${cy}`
      if (this.built.has(key)) continue
      const geometry = grainSurface(layer, cx, cy, this.heights)
      let mesh: THREE.Mesh | null = null
      if (geometry) {
        mesh = new THREE.Mesh(geometry, this.material)
        const n = this.heights.chunk
        mesh.position.set(cx * n, 0, cy * n)
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
      this.built.set(key, { layer, mesh })
      built++
    }
  }

  /** Build every missing surface now, before the first frame. */
  fill() {
    this.update(Infinity)
  }

  private remove(mesh: THREE.Mesh | null) {
    if (!mesh) return
    this.group.remove(mesh)
    mesh.geometry.dispose()
  }
}
