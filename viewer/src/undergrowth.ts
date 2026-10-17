import * as THREE from 'three'
import type { Gfx, QualitySettings } from './gfx'
import type { HeightField } from './heightfield'
import { Ground, type LayerSample, type LayerStore } from './layers'
import type { Tracks } from './tracks'
import type { CoverKind } from './vendor/textures.js'

const REBUILD_DISTANCE = 8
const MAX_BUSHES = 12000
const MAX_COVER = 16000
const MAX_LOGS = 600
const MAX_TWIGS = 3000

// Chance of a bush per square metre on the forest floor, where the laser cannot see
// below the canopy. Elsewhere bushes stand only where the undergrowth layer has them:
// from the map's undergrowth symbols or low vegetation found in the laser data.
const BUSH_BASE: Partial<Record<number, number>> = {
  [Ground.forest]: 0.025,
}
// Fallen logs and dry branches per square metre of forest.
const LOGS = 0.0012
const TWIGS = 0.08

const COVER_KINDS: CoverKind[] = ['blueberry', 'fern', 'grass', 'heather', 'sedge', 'dry']
// Card width and height in metres.
const COVER_SIZE: Record<CoverKind, [number, number]> = {
  blueberry: [0.62, 0.36],
  fern: [1.15, 0.85],
  grass: [0.7, 0.45],
  heather: [0.7, 0.36],
  sedge: [0.75, 0.7],
  dry: [0.7, 0.55],
}

/** Deterministic random number in [0, 1) for an integer cell and a salt. */
function cellRandom(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1). */
function valueNoise(x: number, z: number, salt: number): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const fx = x - xi
  const fz = z - zi
  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)
  const a = cellRandom(xi, zi, salt)
  const b = cellRandom(xi + 1, zi, salt)
  const c = cellRandom(xi, zi + 1, salt)
  const d = cellRandom(xi + 1, zi + 1, salt)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/**
 * Which plant (if any) grows at a spot: `r` is a random number in [0, 1), `dry` how dry
 * the spot is (0 lush to 1 dry heath), `water` true beside streams.
 */
function coverAt(s: LayerSample, r: number, dry: number, water: boolean): CoverKind | null {
  const forest = s.ground === Ground.forest || s.ground === Ground.unknown
  if (water) {
    if (r < 0.55) return r < 0.3 ? 'sedge' : 'grass'
    return r < 0.7 && forest ? 'fern' : null
  }
  switch (s.ground) {
    case Ground.forest:
    case Ground.unknown: {
      // Dense canopy shades the floor: fewer plants below it.
      const shade = s.canopy > 14 ? 0.7 : 1
      const fern = s.shrubs > 0.2 ? 0.3 : 0.05
      if (r < fern) return 'fern'
      if (r < (fern + 0.52) * shade) return dry > 0.72 || s.canopy < 3 ? 'heather' : 'blueberry'
      if (r < (fern + 0.6) * shade) return 'grass'
      return null
    }
    case Ground.open:
      return r < 0.55 ? 'grass' : r < 0.75 ? 'dry' : null
    case Ground.rough:
      return r < 0.5 ? 'grass' : r < 0.85 ? 'heather' : null
    case Ground.marsh:
      return r < 0.75 ? 'sedge' : r < 0.85 ? 'heather' : null
    case Ground.field:
      return r < 0.35 ? 'grass' : null
    case Ground.lawn:
      return r < 0.15 ? 'grass' : null
    case Ground.stony:
      return r < 0.1 ? 'grass' : r < 0.2 ? 'heather' : null
    case Ground.rock:
    case Ground.sand:
      return r < 0.04 ? 'grass' : null
    default:
      return null
  }
}

const WATER_KINDS = new Set(['stream', 'small_stream', 'water_channel'])

/** Bushes, ground cover, logs and twigs around the player, generated from the ground layers. */
export class Undergrowth {
  readonly group = new THREE.Group()
  private readonly layers: LayerStore
  private readonly heights: HeightField
  private readonly bushes: THREE.InstancedMesh
  private readonly cover = new Map<CoverKind, THREE.InstancedMesh>()
  private readonly logs: THREE.InstancedMesh
  private readonly twigs: THREE.InstancedMesh[]
  private builtAt: THREE.Vector3 | null = null
  private quality: QualitySettings

  /** Roads, paths and streams: nothing grows on them. */
  tracks: Tracks | null = null

  constructor(layers: LayerStore, heights: HeightField, gfx: Gfx, quality: QualitySettings) {
    this.layers = layers
    this.heights = heights
    this.quality = quality
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, cast: boolean) => {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.receiveShadow = true
      mesh.castShadow = cast
      this.group.add(mesh)
      return mesh
    }
    this.bushes = add(gfx.models.bush[0]!.foliage, gfx.bush, MAX_BUSHES, true)
    this.bushes.customDepthMaterial = gfx.bushDepth
    for (const kind of COVER_KINDS) {
      this.cover.set(kind, add(gfx.models.card, gfx.coverMaterial(gfx.textures.cover[kind]), MAX_COVER, false))
    }
    this.logs = add(gfx.models.log, gfx.logBark, MAX_LOGS, true)
    this.twigs = gfx.models.twig.map(g => add(g, gfx.logBark, MAX_TWIGS, false))
    this.group.name = 'undergrowth'
  }

  setQuality(quality: QualitySettings) {
    this.quality = quality
    this.builtAt = null
  }

  private onTrack(x: number, z: number, margin: number): boolean {
    return this.tracks?.near(x, z, margin) ?? false
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
    const euler = new THREE.Euler()
    const counts = new Map<THREE.InstancedMesh, number>()
    const put = (mesh: THREE.InstancedMesh, capacity: number) => {
      const i = counts.get(mesh) ?? 0
      if (i >= capacity) return false
      mesh.setMatrixAt(i, matrix.compose(pos, quat, scale))
      mesh.setColorAt(i, color)
      counts.set(mesh, i + 1)
      return true
    }
    let complete = true
    const bushRadius = this.quality.near - 8
    const coverRadius = this.quality.cover
    const perCell = this.quality.coverDensity
    const samples = Math.ceil(perCell)

    const x0 = Math.floor(eye.x - bushRadius)
    const z0 = Math.floor(eye.z - bushRadius)
    for (let z = z0; z <= eye.z + bushRadius; z++) {
      for (let x = x0; x <= eye.x + bushRadius; x++) {
        const dx = x - eye.x
        const dz = z - eye.z
        const d2 = dx * dx + dz * dz
        if (d2 > bushRadius * bushRadius) continue
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
        const forest = s.ground === Ground.forest

        const bushChance = (BUSH_BASE[s.ground] ?? 0) + s.shrubs * 0.35
        if (cellRandom(x, z, 1) < bushChance) {
          const bx = x + cellRandom(x, z, 2)
          const bz = z + cellRandom(x, z, 3)
          const size = 0.6 + cellRandom(x, z, 4) * 1.1 + s.shrubs * 0.5
          if (!this.onTrack(bx, bz, size * 0.55 + 0.3)) {
            pos.set(bx, this.heights.heightAt(bx, bz) - 0.1, bz)
            quat.setFromAxisAngle(up, cellRandom(x, z, 5) * Math.PI * 2)
            scale.set(size, size * (0.75 + cellRandom(x, z, 6) * 0.4), size)
            const t = 0.8 + cellRandom(x, z, 7) * 0.35
            color.setRGB(t, t, t * 0.9)
            put(this.bushes, MAX_BUSHES)
          }
        }

        if (forest && cellRandom(x, z, 60) < LOGS) {
          const lx = x + cellRandom(x, z, 61)
          const lz = z + cellRandom(x, z, 62)
          const length = 3 + 5 * cellRandom(x, z, 63)
          if (!this.onTrack(lx, lz, length / 2 + 1.5)) {
            const a = cellRandom(x, z, 64) * Math.PI * 2
            const r = 0.12 + 0.12 * cellRandom(x, z, 65)
            const h0 = this.heights.heightAt(lx - (Math.cos(a) * length) / 2, lz - (Math.sin(a) * length) / 2)
            const h1 = this.heights.heightAt(lx + (Math.cos(a) * length) / 2, lz + (Math.sin(a) * length) / 2)
            quat.setFromEuler(euler.set(0, -a, Math.atan2(h1 - h0, length), 'YZX'))
            scale.set(length, r, r)
            pos.set(lx, (h0 + h1) / 2 + r * 0.55, lz)
            const t = 0.9 + 0.3 * cellRandom(x, z, 66)
            color.setRGB(t, t * 0.95, t * 0.85)
            put(this.logs, MAX_LOGS)
          }
        }

        if (d2 > coverRadius * coverRadius) continue
        const dry = valueNoise(x / 14, z / 14, 5)
        for (let k = 0; k < samples; k++) {
          if (k + 1 > perCell && cellRandom(x, z, 9 + k) > perCell % 1) continue
          const tx = x + cellRandom(x, z, 10 + k)
          const tz = z + cellRandom(x, z, 20 + k)
          const edge = this.tracks?.edgeDistance(tx, tz)
          if (edge && edge.distance < 0.05 && !WATER_KINDS.has(edge.kind)) continue
          if (edge && edge.distance < 0.7 && !WATER_KINDS.has(edge.kind) && cellRandom(x, z, 70 + k) < 0.6) continue
          if (edge && WATER_KINDS.has(edge.kind) && edge.distance < 0.15) continue
          const water = !!edge && WATER_KINDS.has(edge.kind) && edge.distance < 1.4
          const kind = coverAt(s, cellRandom(x, z, 30 + k), dry, water)
          if (!kind) continue
          const mesh = this.cover.get(kind)!
          const [w, h] = COVER_SIZE[kind]
          const f = 0.7 + 0.6 * cellRandom(x, z, 40 + k)
          pos.set(tx, this.heights.heightAt(tx, tz) - 0.04, tz)
          quat.setFromAxisAngle(up, cellRandom(x, z, 50 + k) * Math.PI * 2)
          scale.set(w * f, h * f * (0.8 + 0.4 * cellRandom(x, z, 80 + k)), w * f)
          const t = 0.72 + 0.4 * cellRandom(x, z, 90 + k)
          color.setRGB(t, t, t * 0.95)
          put(mesh, MAX_COVER)
        }

        if (forest && cellRandom(x, z, 100) < TWIGS) {
          const tx = x + cellRandom(x, z, 101)
          const tz = z + cellRandom(x, z, 102)
          if (!this.onTrack(tx, tz, 0.5)) {
            const sc = 0.7 + 0.7 * cellRandom(x, z, 103)
            quat.setFromEuler(euler.set((cellRandom(x, z, 104) - 0.5) * 0.12, cellRandom(x, z, 105) * Math.PI * 2, 0))
            scale.set(sc, sc, sc)
            pos.set(tx, this.heights.heightAt(tx, tz) - 0.01, tz)
            const t = 0.7 + 0.4 * cellRandom(x, z, 106)
            color.setRGB(t, t * 0.97, t * 0.93)
            put(this.twigs[cellRandom(x, z, 107) < 0.5 ? 0 : this.twigs.length - 1]!, MAX_TWIGS)
          }
        }
      }
    }

    for (const mesh of [this.bushes, this.logs, ...this.twigs, ...this.cover.values()]) {
      mesh.count = counts.get(mesh) ?? 0
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    // Rebuild again soon if some layers were still loading.
    this.builtAt = complete ? eye.clone() : null
  }
}
