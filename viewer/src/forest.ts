import * as THREE from 'three'
import { type Gfx, IMPOSTOR_HALF_W, MODEL_CROWN, type QualitySettings, THICKETS, VARIANTS } from './gfx'
import type { HeightField } from './heightfield'
import type { Tracks } from './tracks'
import type { TreeInfo, World } from './world'

// Trees nearer than `near` (quality setting) are full models with textured bark and
// foliage cards; farther ones are camera-facing impostors, up to FAR_DISTANCE. Beyond
// FAR_TALL_ONLY only trees taller than FAR_MIN_HEIGHT are drawn. The ground shader
// paints the canopy farther away.
export const FAR_DISTANCE = 1500
const FAR_TALL_ONLY = 650
const FAR_MIN_HEIGHT = 8
// Near models are re-sorted after moving this far; they reach this far past `near`.
const RESORT_DISTANCE = 10
const NEAR_MARGIN = 25
// Near trees within this distance cast shadows.
const SHADOW_DISTANCE = 84
const COLLISION_CELL = 16
const SPRUCE = 1
const PINE = 2

/** Deterministic random number in [0, 1) from a position and a salt. */
function posRandom(x: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453
  return h - Math.floor(h)
}

/** Trees of one chunk, decoded. Positions are scene coordinates. */
export class TreeChunk {
  readonly cx: number
  readonly cy: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly height: Float32Array
  /** Crown width scale (the model is scaled by (width, height, width)). */
  readonly width: Float32Array
  readonly variant: Uint8Array
  /** 1 for thickets, which the runner passes through. */
  readonly thicket: Uint8Array
  readonly rotation: Float32Array
  readonly tint: Float32Array
  readonly box: THREE.Box3
  impostors: THREE.InstancedMesh | null = null
  private grid: Map<number, number[]> | null = null

  constructor(
    cx: number,
    cy: number,
    buffer: ArrayBuffer,
    info: TreeInfo,
    chunkSize: number,
    heights: HeightField,
    tracks: Tracks | null,
  ) {
    this.cx = cx
    this.cy = cy
    const view = new DataView(buffer)
    const n = buffer.byteLength / info.recordBytes
    this.x = new Float32Array(n)
    this.y = new Float32Array(n)
    this.z = new Float32Array(n)
    this.height = new Float32Array(n)
    this.width = new Float32Array(n)
    this.variant = new Uint8Array(n)
    this.thicket = new Uint8Array(n)
    this.rotation = new Float32Array(n)
    this.tint = new Float32Array(n)
    const crown = new Float32Array(n)
    const species = new Uint8Array(n)
    const standGrown = new Uint8Array(n)
    const crownBase = new Uint8Array(n)
    const ox = cx * chunkSize
    const oz = cy * chunkSize
    for (let i = 0; i < n; i++) {
      const o = i * info.recordBytes
      const x = ox + view.getUint16(o, true) / info.posScale
      const z = oz + view.getUint16(o + 2, true) / info.posScale
      this.x[i] = x
      this.z[i] = z
      // Sink trees a little so trunks never float on slopes.
      this.y[i] = heights.heightAt(x, z) - 0.2
      this.height[i] = view.getUint16(o + 4, true) / info.heightScale
      crown[i] = view.getUint8(o + 6) / info.crownScale
      const kind = view.getUint8(o + 7)
      standGrown[i] = info.standGrownFlag && kind & info.standGrownFlag ? 1 : 0
      this.thicket[i] = info.thicketFlag && kind & info.thicketFlag ? 1 : 0
      crownBase[i] = info.crownBaseShift ? (kind >> info.crownBaseShift) & 3 : 0
      species[i] = kind & 15
      this.rotation[i] = posRandom(x, z, 1) * Math.PI * 2
      this.tint[i] = 0.85 + posRandom(x, z, 2) * 0.3
    }
    for (let i = 0; i < n; i++) {
      const x = this.x[i]!
      const z = this.z[i]!
      const h = this.height[i]!
      const r = posRandom(x, z, 3)
      let v: number
      if (this.thicket[i]) {
        // Pine thickets grow as spruce.
        v = species[i] === SPRUCE || species[i] === PINE ? THICKETS[0] : THICKETS[1]
        this.variant[i] = v
        this.width[i] = h * Math.min(Math.max(crown[i]! / Math.max(h, 0.5) / MODEL_CROWN[v]!, 0.8), 3.2)
        continue
      }
      if (species[i] === SPRUCE && crownBase[i]) {
        // Measured in the laser point cloud: 1 branches to the ground ... 3 half bare.
        v = crownBase[i]! - 1
        if (v === 0 && tracks?.near(x, z, Math.min(0.2 * h, 4))) v = 1
        if (standGrown[i]) v = Math.max(v, h < 9 ? 1 : 2)
      } else if (species[i] === SPRUCE) {
        // How far down the live branches go. Spruce in a stand shed their lower branches;
        // trees in the open, young trees and edge trees keep them.
        const neighbours = this.countNear(x, z, 4.5) - 1
        let low = neighbours <= 1 ? 0.9 : neighbours <= 3 ? 0.4 : 0.12
        if (h < 9) low = Math.max(low, 0.7)
        if (r < low) v = 0
        else v = (r - low) / (1 - low) < (neighbours >= 5 ? 0.4 : 0.7) ? 1 : 2
        // Along paths the low branches are broken off.
        if (v === 0 && tracks?.near(x, z, Math.min(0.2 * h, 4))) v = 1
        // Seed trees left after a cut grew up in a stand: long bare trunks.
        if (standGrown[i]) v = h < 9 ? 1 : 2
      } else if (species[i] === PINE) v = r < 0.5 ? 3 : 4
      else v = r < 0.5 ? 5 : 6
      this.variant[i] = v
      const k = crown[i]! / Math.max(h, 0.5) / MODEL_CROWN[v]!
      // Crowns measured in the laser data may vary more than the estimated ones.
      const [lo, hi] = crownBase[i] ? [0.6, 1.4] : [0.7, 1.25]
      this.width[i] = h * Math.min(Math.max(k, lo), hi)
    }
    this.box = new THREE.Box3(
      new THREE.Vector3(ox, heights.chunkMin(cx, cy), oz),
      new THREE.Vector3(ox + chunkSize, heights.chunkMax(cx, cy) + 40, oz + chunkSize),
    )
  }

  get count() {
    return this.x.length
  }

  private countNear(x: number, z: number, radius: number): number {
    const found: number[] = []
    this.near(x, z, radius, found)
    let n = 0
    for (const j of found) if (Math.hypot(this.x[j]! - x, this.z[j]! - z) <= radius) n++
    return n
  }

  /** Trees within `radius` of (x, z) (and some a little farther), using a coarse grid. */
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

  /** Instance transform of tree i; `flip` mirrors it (impostors). */
  compose(i: number, matrix: THREE.Matrix4, rotate: boolean, flip = 1) {
    tmpPos.set(this.x[i]!, this.y[i]!, this.z[i]!)
    tmpQuat.setFromAxisAngle(UP, rotate ? this.rotation[i]! : 0)
    tmpScale.set(this.width[i]! * flip, this.height[i]!, this.width[i]!)
    return matrix.compose(tmpPos, tmpQuat, tmpScale)
  }

  color(i: number, out: THREE.Color): THREE.Color {
    const t = this.tint[i]!
    return out.setRGB(t, t * (0.97 + 0.06 * (t - 0.85)), t * 0.95)
  }

  /** All trees of the chunk as impostors, in one draw call. */
  buildImpostors(material: THREE.Material): THREE.InstancedMesh {
    const geometry = new THREE.PlaneGeometry(1, 1)
    geometry.translate(0, 0.5, 0)
    const slots = new Float32Array(Math.max(this.count, 1))
    for (let i = 0; i < this.count; i++) slots[i] = this.variant[i]!
    geometry.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slots, 1))
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(this.count, 1))
    for (let i = 0; i < this.count; i++) {
      mesh.setMatrixAt(i, this.compose(i, tmpMatrix, false, posRandom(this.x[i]!, this.z[i]!, 4) < 0.5 ? -1 : 1))
      mesh.setColorAt(i, this.color(i, tmpColor))
    }
    mesh.count = this.count
    // The quads turn to the camera in the shader; bound the whole chunk instead.
    mesh.boundingSphere = this.box.getBoundingSphere(new THREE.Sphere())
    mesh.boundingSphere.radius += IMPOSTOR_HALF_W * 40
    this.impostors = mesh
    return mesh
  }

  dispose() {
    if (this.impostors) {
      this.impostors.geometry.dispose()
      this.impostors.dispose()
      this.impostors.removeFromParent()
    }
  }
}

const tmpMatrix = new THREE.Matrix4()
const tmpQuat = new THREE.Quaternion()
const tmpScale = new THREE.Vector3()
const tmpPos = new THREE.Vector3()
const tmpColor = new THREE.Color()
const UP = new THREE.Vector3(0, 1, 0)

/** Instanced meshes of one tree variant near the player: trunk and foliage. */
interface NearMeshes {
  trunk: THREE.InstancedMesh
  foliage: THREE.InstancedMesh
}

/** All trees of the world, loaded and drawn around the camera. */
export class Forest {
  readonly group = new THREE.Group()
  private readonly world: World
  private readonly info: TreeInfo
  private readonly heights: HeightField
  private readonly impostorMaterial: THREE.ShaderMaterial
  private readonly chunks = new Map<string, TreeChunk>()
  private readonly loading = new Set<string>()
  /** [variant][0 = casts shadows, 1 = does not] */
  private readonly nearMeshes: NearMeshes[][] = []
  private nearAt: THREE.Vector3 | null = null
  private nearDirty = true
  private nearDrawn = 0
  private nearDistance: number
  shadows = true

  /** Roads and paths: spruce beside them have lost their lowest branches. */
  tracks: Tracks | null = null

  constructor(world: World, info: TreeInfo, heights: HeightField, gfx: Gfx, quality: QualitySettings) {
    this.world = world
    this.info = info
    this.heights = heights
    this.nearDistance = quality.near
    this.impostorMaterial = gfx.impostorMaterial()
    this.impostorMaterial.uniforms['uTallOnly']!.value.set(FAR_TALL_ONLY, FAR_MIN_HEIGHT)
    this.group.name = 'forest'
    VARIANTS.forEach((v, i) => {
      const model = gfx.treeModel(i)
      const mats = gfx.species[v.species]
      this.nearMeshes.push(
        [true, false].map(cast => {
          const trunk = this.instanced(model.trunk, mats.bark, cast, 64)
          const foliage = this.instanced(model.foliage, mats.leaf, cast, 64)
          foliage.customDepthMaterial = mats.depth
          return { trunk, foliage }
        }),
      )
    })
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, cast: boolean, capacity: number) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.castShadow = cast
    mesh.receiveShadow = true
    this.group.add(mesh)
    return mesh
  }

  setQuality(quality: QualitySettings) {
    this.nearDistance = quality.near
    this.nearDirty = true
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
      const buffer = await response.arrayBuffer()
      const chunk = new TreeChunk(cx, cy, buffer, this.info, this.heights.chunk, this.heights, this.tracks)
      this.chunks.set(key, chunk)
      this.group.add(chunk.buildImpostors(this.impostorMaterial))
      this.nearDirty = true
    } catch (err) {
      console.warn(`Could not load trees of chunk ${key}`, err)
    } finally {
      this.loading.delete(key)
    }
  }

  private chunkDistance(cx: number, cy: number, eye: THREE.Vector3): number {
    const n = this.heights.chunk
    const dx = Math.max(cx * n - eye.x, 0, eye.x - (cx + 1) * n)
    const dz = Math.max(cy * n - eye.z, 0, eye.z - (cy + 1) * n)
    return Math.hypot(dx, dz)
  }

  /** Put the trees around `eye` into the near meshes. */
  private rebuildNear(eye: THREE.Vector3) {
    const reach = this.nearDistance + NEAR_MARGIN
    const shadowSq = this.shadows ? SHADOW_DISTANCE * SHADOW_DISTANCE : -1
    const picked: { chunk: TreeChunk; i: number; cast: number }[][] = VARIANTS.map(() => [])
    const candidates: number[] = []
    for (const chunk of this.chunks.values()) {
      if (this.chunkDistance(chunk.cx, chunk.cy, eye) > reach) continue
      candidates.length = 0
      chunk.near(eye.x, eye.z, reach, candidates)
      for (const i of candidates) {
        const dx = chunk.x[i]! - eye.x
        const dz = chunk.z[i]! - eye.z
        const d2 = dx * dx + dz * dz
        if (d2 > reach * reach) continue
        picked[chunk.variant[i]!]!.push({ chunk, i, cast: d2 < shadowSq ? 0 : 1 })
      }
    }
    let drawn = 0
    picked.forEach((trees, v) => {
      const sets = this.nearMeshes[v]!
      for (const cast of [0, 1]) {
        const mine = trees.filter(t => t.cast === cast)
        let set = sets[cast]!
        if (mine.length > set.trunk.instanceMatrix.count) {
          // Grow the meshes.
          const capacity = Math.ceil(mine.length * 1.5)
          for (const m of [set.trunk, set.foliage]) {
            m.removeFromParent()
            m.dispose()
          }
          const trunk = this.instanced(set.trunk.geometry, set.trunk.material as THREE.Material, cast === 0, capacity)
          const foliage = this.instanced(set.foliage.geometry, set.foliage.material as THREE.Material, cast === 0, capacity)
          foliage.customDepthMaterial = set.foliage.customDepthMaterial
          set = sets[cast] = { trunk, foliage }
        }
        mine.forEach(({ chunk, i }, slot) => {
          chunk.compose(i, tmpMatrix, true)
          set.trunk.setMatrixAt(slot, tmpMatrix)
          set.foliage.setMatrixAt(slot, tmpMatrix)
          chunk.color(i, tmpColor)
          set.trunk.setColorAt(slot, tmpColor)
          set.foliage.setColorAt(slot, tmpColor)
        })
        for (const m of [set.trunk, set.foliage]) {
          m.count = mine.length
          m.instanceMatrix.needsUpdate = true
          if (m.instanceColor) m.instanceColor.needsUpdate = true
        }
        drawn += mine.length
      }
    })
    this.nearDrawn = drawn
    this.nearAt = eye.clone()
    this.nearDirty = false
  }

  /** Load chunks around `eye` and update the near trees. */
  update(eye: THREE.Vector3, maxLoadsPerFrame = 2) {
    const n = this.heights.chunk
    const reach = Math.ceil(FAR_DISTANCE / n) + 1
    const ecx = Math.floor(eye.x / n)
    const ecy = Math.floor(eye.z / n)
    const wanted: { cx: number; cy: number; d: number }[] = []
    for (let cy = ecy - reach; cy <= ecy + reach; cy++) {
      for (let cx = ecx - reach; cx <= ecx + reach; cx++) {
        if (cx < 0 || cy < 0 || cx >= this.heights.chunksX || cy >= this.heights.chunksY) continue
        if (this.info.counts[cy * this.heights.chunksX + cx] === 0) continue
        const d = this.chunkDistance(cx, cy, eye)
        if (d < FAR_DISTANCE) wanted.push({ cx, cy, d })
      }
    }
    wanted.sort((a, b) => a.d - b.d)

    let loads = 0
    for (const { cx, cy } of wanted) {
      const key = this.key(cx, cy)
      if (!this.chunks.has(key) && !this.loading.has(key) && loads < maxLoadsPerFrame) {
        loads++
        void this.load(cx, cy)
      }
    }

    // Unload chunks that are well out of range.
    for (const [key, chunk] of this.chunks) {
      const d = this.chunkDistance(chunk.cx, chunk.cy, eye)
      if (d > FAR_DISTANCE + n) {
        chunk.dispose()
        this.chunks.delete(key)
      } else if (chunk.impostors) {
        chunk.impostors.visible = d < FAR_DISTANCE
      }
    }

    if (this.nearDirty || !this.nearAt || this.nearAt.distanceTo(eye) > RESORT_DISTANCE) this.rebuildNear(eye)
  }

  /** Load everything around `eye` before the first frame. */
  async prepare(eye: THREE.Vector3): Promise<void> {
    for (let pass = 0; pass < 200; pass++) {
      this.update(eye, 8)
      if (this.loading.size === 0) {
        const n = this.heights.chunk
        const reach = Math.ceil(FAR_DISTANCE / n) + 1
        let missing = 0
        for (let cy = Math.floor(eye.z / n) - reach; cy <= Math.floor(eye.z / n) + reach; cy++) {
          for (let cx = Math.floor(eye.x / n) - reach; cx <= Math.floor(eye.x / n) + reach; cx++) {
            if (cx < 0 || cy < 0 || cx >= this.heights.chunksX || cy >= this.heights.chunksY) continue
            if (this.info.counts[cy * this.heights.chunksX + cx] === 0) continue
            if (this.chunkDistance(cx, cy, eye) < FAR_DISTANCE && !this.chunks.has(this.key(cx, cy))) missing++
          }
        }
        if (missing === 0) {
          this.rebuildNear(eye)
          return
        }
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
      if (chunk.thicket[i]) continue
      const trunk = Math.min(Math.max(0.016 * chunk.width[i]! + 0.03, 0.06), 0.35)
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

  /** Number of trees drawn as models, and in all loaded chunks, for the HUD. */
  get drawn(): { near: number; total: number } {
    let total = 0
    for (const chunk of this.chunks.values()) if (chunk.impostors?.visible) total += chunk.count
    return { near: this.nearDrawn, total }
  }
}
