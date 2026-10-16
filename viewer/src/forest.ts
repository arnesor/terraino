import * as THREE from 'three'
import type { HeightField } from './heightfield'
import { type LodLevel, SPECIES, treeGeometry } from './treeModels'
import type { TreeInfo, World } from './world'

// Trees nearer than LOD0_DISTANCE get detailed models, nearer than LOD1_DISTANCE simple
// ones; up to LOD2_DISTANCE only trees taller than FAR_MIN_HEIGHT are drawn, very simply.
// Beyond that the ground shader paints the canopy.
export const LOD0_DISTANCE = 120
export const LOD1_DISTANCE = 650
export const LOD2_DISTANCE = 1500
const FAR_MIN_HEIGHT = 8
// Re-sort near trees between detailed and simple models after moving this far.
const RESORT_DISTANCE = 12
const COLLISION_CELL = 16

/** Trees of one chunk, decoded. Positions are scene coordinates. */
class TreeChunk {
  readonly cx: number
  readonly cy: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly height: Float32Array
  readonly crown: Float32Array
  readonly species: Uint8Array
  readonly rotation: Float32Array
  readonly tint: Float32Array
  readonly box: THREE.Box3
  readonly group = new THREE.Group()
  /** meshes[lod][species index] */
  meshes: (THREE.InstancedMesh | null)[][] = [[], [], []]
  lod: LodLevel | 'hidden' = 'hidden'
  sortedAt: THREE.Vector3 | null = null
  private grid: Map<number, number[]> | null = null

  constructor(cx: number, cy: number, buffer: ArrayBuffer, info: TreeInfo, chunkSize: number, heights: HeightField) {
    this.cx = cx
    this.cy = cy
    const view = new DataView(buffer)
    const n = buffer.byteLength / info.recordBytes
    this.x = new Float32Array(n)
    this.y = new Float32Array(n)
    this.z = new Float32Array(n)
    this.height = new Float32Array(n)
    this.crown = new Float32Array(n)
    this.species = new Uint8Array(n)
    this.rotation = new Float32Array(n)
    this.tint = new Float32Array(n)
    const ox = cx * chunkSize
    const oz = cy * chunkSize
    for (let i = 0; i < n; i++) {
      const o = i * info.recordBytes
      const x = ox + view.getUint16(o, true) / info.posScale
      const z = oz + view.getUint16(o + 2, true) / info.posScale
      this.x[i] = x
      this.z[i] = z
      // Sink trees a little so trunks never float on slopes.
      this.y[i] = heights.heightAt(x, z) - 0.15
      this.height[i] = view.getUint16(o + 4, true) / info.heightScale
      this.crown[i] = view.getUint8(o + 6) / info.crownScale
      this.species[i] = view.getUint8(o + 7)
      // Deterministic per-tree variation from the position.
      const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
      const r = h - Math.floor(h)
      this.rotation[i] = r * Math.PI * 2
      this.tint[i] = 0.85 + ((r * 7.31) % 1) * 0.3
    }
    this.box = new THREE.Box3(
      new THREE.Vector3(ox, heights.chunkMin(cx, cy), oz),
      new THREE.Vector3(ox + chunkSize, heights.chunkMax(cx, cy) + 40, oz + chunkSize),
    )
  }

  get count() {
    return this.x.length
  }

  /** Trees within `radius` of (x, z), using a coarse grid built on first use. */
  near(x: number, z: number, radius: number, out: number[]) {
    if (!this.grid) {
      this.grid = new Map()
      for (let i = 0; i < this.count; i++) {
        const key = Math.floor(this.x[i]! / COLLISION_CELL) * 100003 + Math.floor(this.z[i]! / COLLISION_CELL)
        let list = this.grid.get(key)
        if (!list) this.grid.set(key, (list = []))
        list.push(i)
      }
    }
    const gx0 = Math.floor((x - radius) / COLLISION_CELL)
    const gx1 = Math.floor((x + radius) / COLLISION_CELL)
    const gz0 = Math.floor((z - radius) / COLLISION_CELL)
    const gz1 = Math.floor((z + radius) / COLLISION_CELL)
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = this.grid.get(gx * 100003 + gz)
        if (list) for (const i of list) out.push(i)
      }
    }
  }

  dispose() {
    for (const lod of this.meshes) for (const mesh of lod) mesh?.dispose()
    this.group.removeFromParent()
  }
}

const tmpMatrix = new THREE.Matrix4()
const tmpQuat = new THREE.Quaternion()
const tmpScale = new THREE.Vector3()
const tmpPos = new THREE.Vector3()
const tmpColor = new THREE.Color()
const UP = new THREE.Vector3(0, 1, 0)

/** All trees of the world, loaded and drawn around the camera. */
export class Forest {
  readonly group = new THREE.Group()
  private readonly world: World
  private readonly info: TreeInfo
  private readonly heights: HeightField
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true })
  private readonly chunks = new Map<string, TreeChunk>()
  private readonly loading = new Set<string>()

  constructor(world: World, info: TreeInfo, heights: HeightField) {
    this.world = world
    this.info = info
    this.heights = heights
    this.group.name = 'forest'
  }

  private key(cx: number, cy: number) {
    return `${cx}_${cy}`
  }

  private async load(cx: number, cy: number): Promise<void> {
    const key = this.key(cx, cy)
    this.loading.add(key)
    try {
      const response = await fetch(this.world.url(this.info.path, cx, cy))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const chunk = new TreeChunk(cx, cy, await response.arrayBuffer(), this.info, this.heights.chunk, this.heights)
      this.chunks.set(key, chunk)
      this.group.add(chunk.group)
    } catch (err) {
      console.warn(`Could not load trees of chunk ${key}`, err)
    } finally {
      this.loading.delete(key)
    }
  }

  private mesh(chunk: TreeChunk, lod: LodLevel, s: number, capacity: number): THREE.InstancedMesh {
    let mesh = chunk.meshes[lod]![s]
    if (!mesh) {
      mesh = new THREE.InstancedMesh(treeGeometry(SPECIES[s]!, lod), this.material, Math.max(capacity, 1))
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.castShadow = lod < 2
      mesh.receiveShadow = lod === 0
      chunk.meshes[lod]![s] = mesh
      chunk.group.add(mesh)
    }
    return mesh
  }

  private setInstance(mesh: THREE.InstancedMesh, slot: number, chunk: TreeChunk, i: number) {
    tmpPos.set(chunk.x[i]!, chunk.y[i]!, chunk.z[i]!)
    tmpQuat.setFromAxisAngle(UP, chunk.rotation[i]!)
    tmpScale.set(chunk.crown[i]!, chunk.height[i]!, chunk.crown[i]!)
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale)
    mesh.setMatrixAt(slot, tmpMatrix)
    const t = chunk.tint[i]!
    mesh.setColorAt(slot, tmpColor.setRGB(t, t * (0.97 + 0.06 * (t - 0.85)), t))
  }

  /** Fill the meshes of a chunk for the given level of detail around `eye`. */
  private fill(chunk: TreeChunk, lod: LodLevel, eye: THREE.Vector3) {
    const counts = SPECIES.map(() => [0, 0])
    const capacity = SPECIES.map((_, s) => {
      let n = 0
      for (let i = 0; i < chunk.count; i++) if (chunk.species[i] === SPECIES[s]) n++
      return n
    })
    for (let s = 0; s < SPECIES.length; s++) {
      for (const l of [0, 1, 2] as LodLevel[]) {
        const m = chunk.meshes[l]![s]
        if (m) m.count = 0
      }
    }
    const nearSq = LOD0_DISTANCE * LOD0_DISTANCE
    for (let i = 0; i < chunk.count; i++) {
      const s = chunk.species[i]! - 1
      if (s < 0 || s >= SPECIES.length) continue
      let level: LodLevel = lod
      if (lod === 2) {
        // Trees are sorted tallest first, so the rest of the chunk is shorter still.
        if (chunk.height[i]! < FAR_MIN_HEIGHT) continue
      } else {
        const dx = chunk.x[i]! - eye.x
        const dz = chunk.z[i]! - eye.z
        level = dx * dx + dz * dz < nearSq ? 0 : 1
      }
      const mesh = this.mesh(chunk, level, s, capacity[s]!)
      const slot = counts[s]![level === 0 ? 0 : 1]!++
      this.setInstance(mesh, slot, chunk, i)
    }
    for (let s = 0; s < SPECIES.length; s++) {
      if (lod === 2) {
        const m = chunk.meshes[2]![s]
        if (m) m.count = counts[s]![1]!
      } else {
        const m0 = chunk.meshes[0]![s]
        const m1 = chunk.meshes[1]![s]
        if (m0) m0.count = counts[s]![0]!
        if (m1) m1.count = counts[s]![1]!
      }
    }
    for (const lodMeshes of chunk.meshes) {
      for (const m of lodMeshes) {
        if (!m) continue
        m.instanceMatrix.needsUpdate = true
        if (m.instanceColor) m.instanceColor.needsUpdate = true
        if (m.count > 0) {
          m.computeBoundingSphere()
          m.frustumCulled = true
        }
      }
    }
    chunk.lod = lod
    chunk.sortedAt = eye.clone()
  }

  private chunkDistance(cx: number, cy: number, eye: THREE.Vector3): number {
    const n = this.heights.chunk
    const dx = Math.max(cx * n - eye.x, 0, eye.x - (cx + 1) * n)
    const dz = Math.max(cy * n - eye.z, 0, eye.z - (cy + 1) * n)
    return Math.hypot(dx, dz)
  }

  /** Load chunks around `eye` and update their levels of detail. */
  update(eye: THREE.Vector3, maxLoadsPerFrame = 2, maxFillsPerFrame = 2) {
    const n = this.heights.chunk
    const reach = Math.ceil(LOD2_DISTANCE / n) + 1
    const ecx = Math.floor(eye.x / n)
    const ecy = Math.floor(eye.z / n)
    const wanted: { cx: number; cy: number; d: number }[] = []
    for (let cy = ecy - reach; cy <= ecy + reach; cy++) {
      for (let cx = ecx - reach; cx <= ecx + reach; cx++) {
        if (cx < 0 || cy < 0 || cx >= this.heights.chunksX || cy >= this.heights.chunksY) continue
        if (this.info.counts[cy * this.heights.chunksX + cx] === 0) continue
        const d = this.chunkDistance(cx, cy, eye)
        if (d < LOD2_DISTANCE) wanted.push({ cx, cy, d })
      }
    }
    wanted.sort((a, b) => a.d - b.d)

    let loads = 0
    let fills = 0
    for (const { cx, cy, d } of wanted) {
      const key = this.key(cx, cy)
      const chunk = this.chunks.get(key)
      if (!chunk) {
        if (!this.loading.has(key) && loads < maxLoadsPerFrame) {
          loads++
          void this.load(cx, cy)
        }
        continue
      }
      const lod: LodLevel = d < LOD1_DISTANCE ? 0 : 2
      const moved = chunk.sortedAt ? chunk.sortedAt.distanceTo(eye) : Infinity
      const stale = lod === 0 && d < LOD1_DISTANCE && moved > RESORT_DISTANCE && d < LOD0_DISTANCE * 2
      if ((chunk.lod !== lod || stale) && fills < maxFillsPerFrame) {
        fills++
        this.fill(chunk, lod, eye)
      }
    }

    // Unload chunks that are well out of range.
    for (const [key, chunk] of this.chunks) {
      if (this.chunkDistance(chunk.cx, chunk.cy, eye) > LOD2_DISTANCE + n) {
        chunk.dispose()
        this.chunks.delete(key)
      }
    }
  }

  /** Load and fill everything around `eye` before the first frame. */
  async prepare(eye: THREE.Vector3): Promise<void> {
    for (let pass = 0; pass < 200; pass++) {
      this.update(eye, 8, 50)
      if (this.loading.size === 0) {
        this.update(eye, 0, 1000)
        const n = this.heights.chunk
        const reach = Math.ceil(LOD2_DISTANCE / n) + 1
        let missing = 0
        for (let cy = Math.floor(eye.z / n) - reach; cy <= Math.floor(eye.z / n) + reach; cy++) {
          for (let cx = Math.floor(eye.x / n) - reach; cx <= Math.floor(eye.x / n) + reach; cx++) {
            if (cx < 0 || cy < 0 || cx >= this.heights.chunksX || cy >= this.heights.chunksY) continue
            if (this.info.counts[cy * this.heights.chunksX + cx] === 0) continue
            if (this.chunkDistance(cx, cy, eye) < LOD2_DISTANCE && !this.chunks.has(this.key(cx, cy))) missing++
          }
        }
        if (missing === 0) return
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  /** Push (x, z) out of tree trunks; returns the corrected position. */
  collide(x: number, z: number, radius: number): [number, number] {
    const n = this.heights.chunk
    const chunk = this.chunks.get(this.key(Math.floor(x / n), Math.floor(z / n)))
    if (!chunk) return [x, z]
    const candidates: number[] = []
    chunk.near(x, z, 2, candidates)
    for (const i of candidates) {
      const trunk = Math.min(Math.max(0.012 * chunk.height[i]! + 0.04, 0.06), 0.35)
      const dx = x - chunk.x[i]!
      const dz = z - chunk.z[i]!
      const d = Math.hypot(dx, dz)
      const min = trunk + radius
      if (d < min && d > 1e-6) {
        x = chunk.x[i]! + (dx / d) * min
        z = chunk.z[i]! + (dz / d) * min
      }
    }
    return [x, z]
  }

  /** Number of trees currently drawn, for the HUD. */
  get drawn(): number {
    let n = 0
    for (const chunk of this.chunks.values()) {
      for (const lod of chunk.meshes) for (const m of lod) if (m) n += m.count
    }
    return n
  }
}
