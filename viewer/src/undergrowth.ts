import * as THREE from 'three'
import type { HeightField } from './heightfield'
import { Ground, type LayerStore } from './layers'
import { bushGeometry, tuftGeometry } from './treeModels'

const BUSH_RADIUS = 60
const TUFT_RADIUS = 35
const REBUILD_DISTANCE = 8
const MAX_BUSHES = 12000
const MAX_TUFTS = 30000

// Chance of a bush per square metre on the forest floor, where the laser cannot see
// below the canopy. Elsewhere bushes stand only where the undergrowth layer has them:
// from the map's undergrowth symbols or low vegetation found in the laser data.
const BUSH_BASE: Partial<Record<number, number>> = {
  [Ground.forest]: 0.025,
}
// Grass tufts per square metre.
const TUFTS: Partial<Record<number, number>> = {
  [Ground.open]: 1.2,
  [Ground.rough]: 1.6,
  [Ground.marsh]: 1.4,
  [Ground.field]: 0.6,
  [Ground.lawn]: 0.3,
  [Ground.forest]: 0.08,
  [Ground.stony]: 0.3,
}
// Tuft colour per ground class (multiplies the model's green-to-straw gradient).
const TUFT_TINT: Partial<Record<number, THREE.Color>> = {
  [Ground.marsh]: new THREE.Color(1.15, 1.05, 0.75),
  [Ground.rough]: new THREE.Color(1.05, 0.95, 0.8),
  [Ground.field]: new THREE.Color(1.0, 1.1, 0.8),
}

/** Deterministic random number in [0, 1) for an integer cell and a salt. */
function cellRandom(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Bushes and grass around the player, generated from the ground layers. */
export class Undergrowth {
  readonly group = new THREE.Group()
  private readonly layers: LayerStore
  private readonly heights: HeightField
  private readonly bushes: THREE.InstancedMesh
  private readonly tufts: THREE.InstancedMesh
  private builtAt: THREE.Vector3 | null = null

  constructor(layers: LayerStore, heights: HeightField) {
    this.layers = layers
    this.heights = heights
    const material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.bushes = new THREE.InstancedMesh(bushGeometry(), material, MAX_BUSHES)
    const grass = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.tufts = new THREE.InstancedMesh(tuftGeometry(), grass, MAX_TUFTS)
    for (const mesh of [this.bushes, this.tufts]) {
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.receiveShadow = true
      this.group.add(mesh)
    }
    this.bushes.castShadow = true
    this.group.name = 'undergrowth'
  }

  update(eye: THREE.Vector3) {
    if (this.builtAt && this.builtAt.distanceTo(eye) < REBUILD_DISTANCE) return
    const n = this.heights.chunk
    const matrix = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const color = new THREE.Color()
    const up = new THREE.Vector3(0, 1, 0)
    let bushes = 0
    let tufts = 0
    let complete = true

    const x0 = Math.floor(eye.x - BUSH_RADIUS)
    const z0 = Math.floor(eye.z - BUSH_RADIUS)
    for (let z = z0; z <= eye.z + BUSH_RADIUS; z++) {
      for (let x = x0; x <= eye.x + BUSH_RADIUS; x++) {
        const dx = x - eye.x
        const dz = z - eye.z
        const d2 = dx * dx + dz * dz
        if (d2 > BUSH_RADIUS * BUSH_RADIUS) continue
        const cx = Math.floor(x / n)
        const cy = Math.floor(z / n)
        const layer = this.layers.get(cx, cy)
        if (!layer) {
          complete = false
          continue
        }
        const s = layer.sample(x - cx * n, z - cy * n)
        if (s.ground === Ground.path || s.ground === Ground.gravel || s.ground === Ground.paved) continue
        if (s.ground === Ground.water || s.ground === Ground.building) continue

        const bushChance = (BUSH_BASE[s.ground] ?? 0) + s.shrubs * 0.35
        if (bushes < MAX_BUSHES && cellRandom(x, z, 1) < bushChance) {
          const bx = x + cellRandom(x, z, 2)
          const bz = z + cellRandom(x, z, 3)
          const size = 0.45 + cellRandom(x, z, 4) * 0.9 + s.shrubs * 0.4
          pos.set(bx, this.heights.heightAt(bx, bz) - 0.05, bz)
          quat.setFromAxisAngle(up, cellRandom(x, z, 5) * Math.PI * 2)
          scale.set(size, size * (0.8 + cellRandom(x, z, 6) * 0.5), size)
          this.bushes.setMatrixAt(bushes, matrix.compose(pos, quat, scale))
          const t = 0.8 + cellRandom(x, z, 7) * 0.4
          this.bushes.setColorAt(bushes, color.setRGB(t, t, t * 0.9))
          bushes++
        }

        if (d2 > TUFT_RADIUS * TUFT_RADIUS) continue
        const density = TUFTS[s.ground] ?? 0
        const count = Math.floor(density) + (cellRandom(x, z, 8) < density % 1 ? 1 : 0)
        const tint = TUFT_TINT[s.ground]
        for (let k = 0; k < count && tufts < MAX_TUFTS; k++) {
          const tx = x + cellRandom(x, z, 10 + k)
          const tz = z + cellRandom(x, z, 20 + k)
          const h = 0.2 + cellRandom(x, z, 30 + k) * 0.45
          pos.set(tx, this.heights.heightAt(tx, tz) - 0.02, tz)
          quat.setFromAxisAngle(up, cellRandom(x, z, 40 + k) * Math.PI)
          scale.set(h * 1.2, h, h * 1.2)
          this.tufts.setMatrixAt(tufts, matrix.compose(pos, quat, scale))
          color.setRGB(1, 1, 1)
          if (tint) color.copy(tint)
          this.tufts.setColorAt(tufts, color.multiplyScalar(0.85 + cellRandom(x, z, 50 + k) * 0.3))
          tufts++
        }
      }
    }

    this.bushes.count = bushes
    this.tufts.count = tufts
    for (const mesh of [this.bushes, this.tufts]) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    // Rebuild again soon if some layers were still loading.
    this.builtAt = complete ? eye.clone() : null
  }
}
