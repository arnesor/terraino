import * as THREE from 'three'
import type { Gfx, QualitySettings } from './gfx'
import type { HeightField } from './heightfield'
import { type ChunkLayer, Ground, type LayerSample, type LayerStore } from './layers'
import type { Tracks } from './tracks'
import type { CoverKind } from './vendor/textures.js'

const REBUILD_DISTANCE = 8
const MAX_BUSHES = 12000
const MAX_COVER = 16000
const MAX_LOGS = 600
const MAX_TWIGS = 6000
const MAX_STUMPS = 4000
const STUMP_CELL = 32

// Chance of a bush per square metre on the forest floor, where the height models cannot
// see below the canopy. Elsewhere bushes stand only where the undergrowth layer has
// them: from the map's undergrowth symbols or low vegetation found in the laser data.
// With a laser point cloud the undergrowth layer covers the forest too, and only a few
// random bushes are added.
const BUSH_BASE: Partial<Record<number, number>> = {
  [Ground.forest]: 0.025,
}
const BUSH_BASE_LIDAR: Partial<Record<number, number>> = {
  [Ground.forest]: 0.004,
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

/** A cut stump of height and diameter 1, its top a pale cut surface. */
function stumpGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.47, 0.55, 1, 9, 1)
  g.translate(0, 0.5, 0)
  const pos = g.getAttribute('position')
  const normal = g.getAttribute('normal')
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const top = normal.getY(i) > 0.9
    const c = top ? [2.6, 2.2, 1.6] : pos.getY(i) < 0.5 ? [0.7, 0.7, 0.7] : [1, 1, 1]
    colors.set(c, i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
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
  private readonly stumpMesh: THREE.InstancedMesh
  private readonly stumpGrid = new Map<number, number[]>()
  private builtAt: THREE.Vector3 | null = null
  // Layer version at the last fill if some layers were missing then, else null.
  private waitingFor: number | null = null
  private quality: QualitySettings
  private readonly bushBase: Partial<Record<number, number>>

  /** Roads, paths and streams: nothing grows on them. */
  tracks: Tracks | null = null

  constructor(layers: LayerStore, heights: HeightField, gfx: Gfx, quality: QualitySettings, lidar = false) {
    this.layers = layers
    this.heights = heights
    this.quality = quality
    this.bushBase = lidar ? BUSH_BASE_LIDAR : BUSH_BASE
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
    this.stumpMesh = add(stumpGeometry(), gfx.logBark, MAX_STUMPS, true)
    this.group.name = 'undergrowth'
  }

  setQuality(quality: QualitySettings) {
    this.quality = quality
    this.builtAt = null
  }

  /** Stumps of felled trees (x, z, diameter, ...), with slash around them. */
  setStumps(stumps: number[]) {
    this.stumpGrid.clear()
    for (let i = 0; i < stumps.length; i += 3) {
      const key = Math.floor(stumps[i]! / STUMP_CELL) * 100003 + Math.floor(stumps[i + 1]! / STUMP_CELL)
      let list = this.stumpGrid.get(key)
      if (!list) this.stumpGrid.set(key, (list = []))
      list.push(stumps[i]!, stumps[i + 1]!, stumps[i + 2]!)
    }
    this.builtAt = null
  }

  private onTrack(x: number, z: number, margin: number): boolean {
    return this.tracks?.near(x, z, margin) ?? false
  }

  update(eye: THREE.Vector3) {
    const moved = !this.builtAt || this.builtAt.distanceTo(eye) >= REBUILD_DISTANCE
    const arrived = this.waitingFor !== null && this.waitingFor !== this.layers.version
    if (!moved && !arrived) return
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
    // The layer of the last cell's chunk, and one sample object reused for every cell.
    let layer: ChunkLayer | undefined
    let layerCx = NaN
    let layerCy = NaN
    const sample: LayerSample = { ground: 0, canopy: 0, shrubs: 0, speed: 0 }
    const bushRadius = this.quality.near - 8
    const coverRadius = this.quality.cover
    const perCell = this.quality.coverDensity
    const samples = Math.ceil(perCell)

    // Only cells inside the world: there are no layers beyond its edge.
    const x0 = Math.max(Math.floor(eye.x - bushRadius), 0)
    const z0 = Math.max(Math.floor(eye.z - bushRadius), 0)
    const x1 = Math.min(eye.x + bushRadius, this.heights.chunksX * n - 1)
    const z1 = Math.min(eye.z + bushRadius, this.heights.chunksY * n - 1)
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - eye.x
        const dz = z - eye.z
        const d2 = dx * dx + dz * dz
        if (d2 > bushRadius * bushRadius) continue
        const cx = Math.floor(x / n)
        const cy = Math.floor(z / n)
        if (cx !== layerCx || cy !== layerCy) {
          layer = this.layers.get(cx, cy)
          layerCx = cx
          layerCy = cy
        }
        if (!layer) {
          complete = false
          continue
        }
        const s = layer.sample(x - cx * n, z - cy * n, sample)
        if (s.ground === Ground.path || s.ground === Ground.gravel || s.ground === Ground.paved) continue
        if (s.ground === Ground.water || s.ground === Ground.building) continue
        const forest = s.ground === Ground.forest

        const bushChance = (this.bushBase[s.ground] ?? 0) + s.shrubs * 0.35
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

    // Stumps where trees were felled, with branches (slash) and the odd top left lying.
    const g0 = Math.floor((eye.x - bushRadius) / STUMP_CELL)
    const g1 = Math.floor((eye.x + bushRadius) / STUMP_CELL)
    const h0 = Math.floor((eye.z - bushRadius) / STUMP_CELL)
    const h1 = Math.floor((eye.z + bushRadius) / STUMP_CELL)
    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = h0; gz <= h1; gz++) {
        const list = this.stumpGrid.get(gx * 100003 + gz)
        if (!list) continue
        for (let i = 0; i < list.length; i += 3) {
          const sx = list[i]!
          const sz = list[i + 1]!
          const d = list[i + 2]!
          if ((sx - eye.x) ** 2 + (sz - eye.z) ** 2 > bushRadius * bushRadius) continue
          if (this.onTrack(sx, sz, 0.3)) continue
          const k = Math.round(sx * 10) * 7919 + Math.round(sz * 10)
          const r = (salt: number) => cellRandom(k, 17, salt)
          pos.set(sx, this.heights.heightAt(sx, sz) - 0.06, sz)
          quat.setFromAxisAngle(up, r(1) * Math.PI * 2)
          scale.set(d, 0.22 + 0.25 * r(2), d)
          const t = 0.85 + 0.3 * r(3)
          color.setRGB(t, t * 0.96, t * 0.9)
          put(this.stumpMesh, MAX_STUMPS)
          // Slash: dry branches lying around the stump.
          const n = 2 + Math.floor(r(4) * 3)
          for (let j = 0; j < n; j++) {
            const a = r(10 + j) * Math.PI * 2
            const dist = 0.6 + 2.2 * r(20 + j)
            const bx = sx + Math.cos(a) * dist
            const bz = sz + Math.sin(a) * dist
            if (this.onTrack(bx, bz, 0.5)) continue
            const sc = 1.6 + 1.6 * r(30 + j)
            quat.setFromEuler(euler.set((r(40 + j) - 0.5) * 0.25, r(50 + j) * Math.PI * 2, (r(60 + j) - 0.5) * 0.2))
            scale.set(sc, sc, sc)
            pos.set(bx, this.heights.heightAt(bx, bz) - 0.02, bz)
            const v = 0.6 + 0.35 * r(70 + j)
            color.setRGB(v, v * 0.95, v * 0.88)
            put(this.twigs[j % this.twigs.length]!, MAX_TWIGS)
          }
          // Now and then the felled top, left lying.
          if (r(80) < 0.12) {
            const a = r(81) * Math.PI * 2
            const length = 2 + 3 * r(82)
            const lx = sx + Math.cos(a) * (length / 2 + 1)
            const lz = sz + Math.sin(a) * (length / 2 + 1)
            if (!this.onTrack(lx, lz, length / 2 + 0.5)) {
              const radius = 0.05 + 0.05 * r(83)
              quat.setFromEuler(euler.set(0, -a, 0, 'YZX'))
              scale.set(length, radius, radius)
              pos.set(lx, this.heights.heightAt(lx, lz) + radius * 0.6, lz)
              color.setRGB(0.8, 0.76, 0.7)
              put(this.logs, MAX_LOGS)
            }
          }
        }
      }
    }

    for (const mesh of [this.bushes, this.logs, this.stumpMesh, ...this.twigs, ...this.cover.values()]) {
      mesh.count = counts.get(mesh) ?? 0
      // Upload only the instances in use; without a range three uploads the whole capacity.
      for (const attribute of [mesh.instanceMatrix, mesh.instanceColor]) {
        if (!attribute) continue
        attribute.clearUpdateRanges()
        attribute.addUpdateRange(0, mesh.count * attribute.itemSize)
        attribute.needsUpdate = true
      }
    }
    // Fill again when more layers have arrived, if some were missing (loading or failed).
    this.builtAt = eye.clone()
    this.waitingFor = complete ? null : this.layers.version
  }
}
