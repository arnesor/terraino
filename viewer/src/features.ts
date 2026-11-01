import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { type Gfx, type QualitySettings, rockMaterial } from './gfx'
import type { HeightField } from './heightfield'
import { ANT_HILL_RADIUS, PICNIC_TABLE_RADIUS } from './placement'
import { type TrackFinder, WALL_KINDS, Walls } from './walls'
import type { World } from './world'

export interface FeatureFile {
  kinds: string[]
  /** [kind index, x, z, size, angle] */
  points: [number, number, number, number, number][]
  /** poles: where a power line's poles stand, when known (else they are spaced evenly) */
  lines: { kind: string; size: number; points: [number, number][]; poles?: [number, number][] }[]
  cliffs: { kind: string; top: [number, number, number][]; bottom: [number, number, number][] }[]
}

const ROCK = new THREE.Color(0x77756e)
const WOOD = new THREE.Color(0x7d6f5c)
const DARK_WOOD = new THREE.Color(0x4f4336)
const POLE = new THREE.Color(0x5a4a38)
// Boulders sink this far below the lowest ground around them.
const BOULDER_SINK_M = 0.25
const STEEL = new THREE.Color(0x8c9196)
// Ant hills: reddish-brown conifer needles, the foot sunk this far into the ground.
const NEEDLES = new THREE.Color(0x7a5435)
const ANT_HILL_SINK_M = 0.1
// Picnic tables: pressure-treated pine, honey-coloured when new, grey when weathered.
const NEW_PINE = new THREE.Color(0xb48a52)
const GREY_PINE = new THREE.Color(0x8b8478)
const COLLISION_CELL = 16
// Rocks are drawn near the player only (see QualitySettings.boulders), picked from a grid
// of this cell size whenever the player has moved this far.
// Lamp posts: the pole's radius at the foot, and the length of the arm with the lamp.
const LAMP_POST_RADIUS = 0.12
const LAMP_ARM_M = 0.8
const ROCK_CELL = 64
const ROCK_REBUILD_DISTANCE = 10

/** A boulder or stone: its shape, its instance matrix and shade, and where it stands. */
interface Rock {
  shape: number
  matrix: THREE.Matrix4
  shade: number
  x: number
  z: number
  stone: boolean
}

function rand(x: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453
  return h - Math.floor(h)
}

function withColor(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  const count = g.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

/** A box from `a` to `b` (centre line at its bottom), `width` wide and `height` high. */
function beam(a: THREE.Vector3, b: THREE.Vector3, width: number, height: number, color: THREE.Color) {
  const length = a.distanceTo(b)
  const g = new THREE.BoxGeometry(length, height, width)
  g.translate(length / 2, height / 2, 0)
  const dir = new THREE.Vector3().subVectors(b, a)
  const yaw = Math.atan2(-dir.z, dir.x)
  const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z))
  g.rotateZ(pitch)
  g.rotateY(yaw)
  g.translate(a.x, a.y, a.z)
  return withColor(g, color)
}

function post(x: number, y: number, z: number, radius: number, height: number, color: THREE.Color, lean = 0, angle = 0) {
  const g = new THREE.CylinderGeometry(radius * 0.8, radius, height, 5)
  g.translate(0, height / 2, 0)
  if (lean) {
    g.rotateZ(lean)
    g.rotateY(angle)
  }
  g.translate(x, y, z)
  return withColor(g, color)
}

/** Points every `spacing` metres along a polyline, starting at its first point. */
function alongLine(pts: THREE.Vector3[], spacing: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  let travelled = 0
  let next = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const length = a.distanceTo(b)
    while (next <= travelled + length && length > 0) {
      out.push(a.clone().lerp(b, (next - travelled) / length))
      next += spacing
    }
    travelled += length
  }
  return out
}

/** Still, dark forest water that reflects the sky, more so at grazing angles. */
function waterMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(0x0c0d08) })
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 viewDir = normalize(cameraPosition - vWaterPos);
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(viewDir.y, 0.0), 5.0);
        vec3 sky = mix(vec3(0.38, 0.5, 0.62), vec3(0.16, 0.27, 0.48), clamp(viewDir.y * 3.0, 0.0, 1.0));
        totalEmissiveRadiance += sky * (0.03 + 0.97 * fresnel);`,
      )
  }
  material.customProgramCacheKey = () => 'terraino-waterhole'
  return material
}

/** Rocks, cliffs, walls, fences, power lines and small structures from the map. */
export class MapFeatures {
  readonly group = new THREE.Group()
  /** Stumps of felled trees, as x, z, diameter; drawn near the player by Undergrowth. */
  readonly stumps: number[] = []
  /** Circles kept free of undergrowth, as x, z, radius: the ant hills. */
  readonly clearings: number[] = []
  /** The features as read from features.json, for placing control flags. */
  data: FeatureFile = { kinds: [], points: [], lines: [], cliffs: [] }
  private readonly obstacles = new Map<number, [number, number, number][]>()
  /** Rocks by ROCK_CELL grid cell, and one instanced mesh per rock shape. */
  private readonly rocks = new Map<number, Rock[]>()
  private readonly rockMeshes: THREE.InstancedMesh[] = []
  private rocksAt: THREE.Vector3 | null = null
  private quality: QualitySettings
  private walls: Walls | null = null

  private readonly gfx: Gfx

  private constructor(gfx: Gfx, quality: QualitySettings) {
    this.gfx = gfx
    this.quality = quality
    this.group.name = 'features'
  }

  /** `tracks` turn the ruins' doors towards the nearest path or road. */
  static async load(
    world: World,
    heights: HeightField,
    gfx: Gfx,
    quality: QualitySettings,
    tracks: TrackFinder | null = null,
  ): Promise<MapFeatures | null> {
    const info = world.manifest.features
    if (!info) return null
    const response = await fetch(world.url(info.path))
    if (!response.ok) return null
    const data = (await response.json()) as FeatureFile
    const features = new MapFeatures(gfx, quality)
    features.data = data
    features.build(data, heights, tracks)
    return features
  }

  private addObstacle(x: number, z: number, radius: number) {
    const key = Math.floor(x / COLLISION_CELL) * 100003 + Math.floor(z / COLLISION_CELL)
    let list = this.obstacles.get(key)
    if (!list) this.obstacles.set(key, (list = []))
    list.push([x, z, radius])
  }

  setQuality(quality: QualitySettings) {
    this.quality = quality
    this.rocksAt = null
    this.walls?.setQuality(quality)
  }

  /**
   * Draw the rocks near `eye` (boulders within `boulders`, stones within `cover`), and
   * the walls' single stones.
   */
  update(eye: THREE.Vector3) {
    this.walls?.update(eye)
    if (this.rocksAt && this.rocksAt.distanceTo(eye) < ROCK_REBUILD_DISTANCE) return
    this.rocksAt = eye.clone()
    // Reach a little farther, so rocks are already there when the player has moved on.
    const far = this.quality.boulders + ROCK_REBUILD_DISTANCE
    const near = this.quality.cover + ROCK_REBUILD_DISTANCE
    const counts = this.rockMeshes.map(() => 0)
    const color = new THREE.Color()
    const c0 = Math.floor((eye.x - far) / ROCK_CELL)
    const c1 = Math.floor((eye.x + far) / ROCK_CELL)
    const r0 = Math.floor((eye.z - far) / ROCK_CELL)
    const r1 = Math.floor((eye.z + far) / ROCK_CELL)
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        for (const rock of this.rocks.get(c * 100003 + r) ?? []) {
          const reach = rock.stone ? near : far
          if ((rock.x - eye.x) ** 2 + (rock.z - eye.z) ** 2 > reach * reach) continue
          const mesh = this.rockMeshes[rock.shape]!
          const i = counts[rock.shape]!++
          mesh.setMatrixAt(i, rock.matrix)
          mesh.setColorAt(i, color.setScalar(rock.shade))
        }
      }
    }
    this.rockMeshes.forEach((mesh, s) => {
      mesh.count = counts[s]!
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })
  }

  /** Push (x, z) out of rocks and other solid objects. */
  collide(x: number, z: number, radius: number): [number, number] {
    const gx = Math.floor(x / COLLISION_CELL)
    const gz = Math.floor(z / COLLISION_CELL)
    for (let i = gx - 1; i <= gx + 1; i++) {
      for (let j = gz - 1; j <= gz + 1; j++) {
        for (const [ox, oz, r] of this.obstacles.get(i * 100003 + j) ?? []) {
          const dx = x - ox
          const dz = z - oz
          const d = Math.hypot(dx, dz)
          const min = r + radius
          if (d < min && d > 1e-6) {
            x = ox + (dx / d) * min
            z = oz + (dz / d) * min
          }
        }
      }
    }
    return [x, z]
  }

  private build(data: FeatureFile, heights: HeightField, tracks: TrackFinder | null) {
    const parts: THREE.BufferGeometry[] = []
    const ground = (x: number, z: number) => heights.heightAt(x, z)

    // Rocks are instanced: a few shapes, many sizes. `update` picks the ones near the player.
    const rockShapes = this.gfx.models.rocks
    const rocks = data.points.filter(p => data.kinds[p[0]] === 'boulder' || data.kinds[p[0]] === 'stone')
    const material = rockMaterial(this.gfx, true)
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    rockShapes.forEach((shape, s) => {
      const mine = rocks.filter((_, i) => i % rockShapes.length === s)
      const mesh = new THREE.InstancedMesh(shape, material, Math.max(mine.length, 1))
      mesh.count = 0
      // The rocks drawn change as the player moves; they are all near.
      mesh.frustumCulled = false
      shape.computeBoundingBox()
      const bb = shape.boundingBox!
      const size3 = bb.getSize(new THREE.Vector3())
      for (const [k, x, z, size, angle] of mine) {
        quat.setFromAxisAngle(up, angle)
        if (data.kinds[k] === 'boulder') {
          // `size` is the boulder's least height above the ground around it: the top
          // stands that high above the highest ground under it, and the bottom sinks
          // below the lowest.
          const width = size * (1.3 + 0.4 * rand(x, z, 1))
          const depth = size * (1.1 + 0.4 * rand(x, z, 2))
          let lo = Infinity
          let hi = -Infinity
          for (let a = 0; a < 8; a++) {
            for (const f of [0, 0.5, 1]) {
              const r = (f * Math.max(width, depth)) / 2
              const h = ground(x + Math.cos((a * Math.PI) / 4) * r, z + Math.sin((a * Math.PI) / 4) * r)
              lo = Math.min(lo, h)
              hi = Math.max(hi, h)
            }
          }
          const bottom = lo - BOULDER_SINK_M
          const sy = (hi + size - bottom) / size3.y
          pos.set(x, bottom - bb.min.y * sy, z)
          scale.set(width / size3.x, sy, depth / size3.z)
          this.addObstacle(x, z, Math.max(width, depth) * 0.45)
        } else {
          // Small stones: `size` is their size; half buried.
          const half = size / 2
          pos.set(x, ground(x, z) + half * 0.1, z)
          scale.set(half * (1.0 + 0.3 * rand(x, z, 1)), half * 1.3, half * (0.85 + 0.3 * rand(x, z, 2)))
        }
        const key = Math.floor(x / ROCK_CELL) * 100003 + Math.floor(z / ROCK_CELL)
        let cell = this.rocks.get(key)
        if (!cell) this.rocks.set(key, (cell = []))
        const matrix = new THREE.Matrix4().compose(pos, quat, scale)
        cell.push({ shape: s, matrix, shade: 0.85 + 0.3 * rand(x, z, 4), x, z, stone: data.kinds[k] === 'stone' })
      }
      // Colours are set per instance; make the attribute now so the shader is built with it.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1))
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.rockMeshes.push(mesh)
      this.group.add(mesh)
    })

    const ponds = data.points.filter(p => data.kinds[p[0]] === 'waterhole')
    if (ponds.length) this.group.add(this.waterholes(ponds, ground))

    for (const [k, x, z, size, angle] of data.points) {
      const kind = data.kinds[k]
      const y = ground(x, z)
      if (kind === 'tower') parts.push(...this.tower(x, y, z, size, angle))
      else if (kind === 'cairn') parts.push(...this.cairn(x, y, z, size))
      else if (kind === 'lamp_post') parts.push(...this.lampPost(x, y, z, size, angle))
      else if (kind === 'fodder_rack') parts.push(...this.fodderRack(x, y, z, size, angle))
      else if (kind === 'footbridge') parts.push(this.footbridge(x, z, size, angle, ground))
      else if (kind === 'ant_hill') parts.push(this.antHill(x, z, size, angle, ground))
      else if (kind === 'picnic_table') parts.push(this.picnicTable(x, z, size, angle, ground))
      else if (kind === 'stump') this.stumps.push(x, z, size)
    }

    const walls = data.lines.filter(line => WALL_KINDS.has(line.kind))
    if (walls.length) {
      this.walls = new Walls(walls, heights, this.gfx, this.quality, tracks)
      this.group.add(this.walls.group)
    }

    const wires: number[] = []
    for (const line of data.lines) {
      const pts = line.points.map(([x, z]) => new THREE.Vector3(x, ground(x, z), z))
      if (line.kind === 'fence' || line.kind === 'ruined_fence') {
        parts.push(...this.fence(pts, line.size, line.kind === 'ruined_fence'))
      } else if (line.kind === 'power_line' || line.kind === 'pylon_line') {
        const poles = line.poles?.length ? line.poles.map(([x, z]) => new THREE.Vector3(x, ground(x, z), z)) : null
        parts.push(...this.powerLine(pts, line.size, line.kind === 'pylon_line', wires, poles))
      }
    }

    const cliffs = data.cliffs.filter(c => c.top.length >= 2).map(c => this.cliff(c.top, c.bottom))
    if (cliffs.length) {
      const merged = mergeGeometries(cliffs)
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, rockMaterial(this.gfx, true))
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = 'cliffs'
      this.group.add(mesh)
    }

    if (parts.length) {
      const merged = mergeGeometries(parts)
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.group.add(mesh)
    }
    if (wires.length) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3))
      this.group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x2a2a2a })))
    }
  }

  private fence(pts: THREE.Vector3[], height: number, ruined: boolean): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = []
    for (const p of alongLine(pts, 2.5)) {
      if (ruined && rand(p.x, p.z, 1) < 0.4) continue
      const lean = ruined ? (rand(p.x, p.z, 2) - 0.5) * 0.6 : 0
      out.push(post(p.x, p.y - 0.2, p.z, 0.06, height + 0.2, DARK_WOOD, lean, rand(p.x, p.z, 3) * 6))
    }
    if (!ruined) {
      for (let i = 0; i + 1 < pts.length; i++) {
        for (const h of [height * 0.45, height * 0.9]) {
          const lift = new THREE.Vector3(0, h, 0)
          out.push(beam(pts[i]!.clone().add(lift), pts[i + 1]!.clone().add(lift), 0.05, 0.1, WOOD))
        }
      }
    }
    return out
  }

  private powerLine(pts: THREE.Vector3[], height: number, steel: boolean, wires: number[], known: THREE.Vector3[] | null): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = []
    // The registered poles, or else poles every ~60 m (pylons ~250 m), always at both ends.
    const spacing = steel ? 250 : 60
    const poles = known ?? alongLine(pts, spacing)
    const last = pts[pts.length - 1]!
    if (!known && (poles.length === 0 || poles[poles.length - 1]!.distanceTo(last) > spacing * 0.3)) poles.push(last)
    const arm = steel ? 6 : 1.6
    const tops: THREE.Vector3[][] = []
    poles.forEach((p, i) => {
      const next = poles[Math.min(i + 1, poles.length - 1)]!
      const prev = poles[Math.max(i - 1, 0)]!
      const along = new THREE.Vector3().subVectors(next, prev).setY(0).normalize()
      const across = new THREE.Vector3(-along.z, 0, along.x)
      if (steel) {
        for (const s of [-1, 1]) {
          const foot = p.clone().addScaledVector(across, s * 2)
          out.push(beam(foot, p.clone().setY(p.y + height), 0.4, 0.4, STEEL))
        }
      } else {
        out.push(post(p.x, p.y - 0.5, p.z, 0.13, height + 0.5, POLE))
        this.addObstacle(p.x, p.z, 0.2)
      }
      const top = p.clone().setY(p.y + height)
      out.push(beam(top.clone().addScaledVector(across, -arm), top.clone().addScaledVector(across, arm), 0.15, 0.15, steel ? STEEL : POLE))
      tops.push([-arm * 0.9, 0, arm * 0.9].map(o => top.clone().addScaledVector(across, o).setY(top.y + 0.1)))
    })
    // Wires sag between poles.
    for (let i = 0; i + 1 < tops.length; i++) {
      for (let w = 0; w < 3; w++) {
        const a = tops[i]![w]!
        const b = tops[i + 1]![w]!
        const sag = a.distanceTo(b) * 0.025
        const segments = 8
        for (let s = 0; s < segments; s++) {
          for (const t of [s / segments, (s + 1) / segments]) {
            const p = a.clone().lerp(b, t)
            p.y -= sag * 4 * t * (1 - t)
            wires.push(p.x, p.y, p.z)
          }
        }
      }
    }
    return out
  }

  private tower(x: number, y: number, z: number, height: number, angle: number): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = []
    const half = Math.max(height * 0.12, 0.6)
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => {
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      return [a! * half * c - b! * half * s, a! * half * s + b! * half * c] as const
    })
    for (const [dx, dz] of corners) {
      const foot = new THREE.Vector3(x + dx * 1.4, y - 0.3, z + dz * 1.4)
      out.push(beam(foot, new THREE.Vector3(x + dx, y + height, z + dz), 0.12, 0.12, WOOD))
    }
    const deck = new THREE.BoxGeometry(half * 2.4, 0.15, half * 2.4)
    deck.rotateY(-angle)
    deck.translate(x, y + height, z)
    out.push(withColor(deck, DARK_WOOD))
    const cabin = new THREE.BoxGeometry(half * 2.2, 1.1, half * 2.2)
    cabin.rotateY(-angle)
    cabin.translate(x, y + height + 0.6, z)
    out.push(withColor(cabin, WOOD))
    const roof = new THREE.ConeGeometry(half * 1.9, 0.8, 4)
    roof.rotateY(Math.PI / 4 - angle)
    roof.translate(x, y + height + 1.55, z)
    out.push(withColor(roof, new THREE.Color(0x2c2c2e)))
    this.addObstacle(x, z, half * 1.4)
    return out
  }

  /**
   * A wooden lamp post of a lit trail, `height` tall, its lamp on a short arm toward
   * `angle` (counter-clockwise from east): the trail it lights.
   */
  private lampPost(x: number, y: number, z: number, height: number, angle: number): THREE.BufferGeometry[] {
    const dx = Math.cos(angle)
    const dz = -Math.sin(angle)
    const top = y + height
    const arm = new THREE.Vector3(x + dx * LAMP_ARM_M, top - 0.25, z + dz * LAMP_ARM_M)
    const lamp = new THREE.BoxGeometry(0.4, 0.14, 0.25)
    lamp.rotateY(Math.atan2(-dz, dx))
    lamp.translate(arm.x, arm.y - 0.12, arm.z)
    this.addObstacle(x, z, LAMP_POST_RADIUS)
    return [
      post(x, y - 0.3, z, LAMP_POST_RADIUS, height + 0.3, POLE),
      beam(new THREE.Vector3(x, top - 0.3, z), arm, 0.08, 0.08, POLE),
      withColor(lamp, STEEL),
    ]
  }

  private cairn(x: number, y: number, z: number, size: number): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = []
    for (let i = 0; i < 4; i++) {
      const r = size * (0.5 - i * 0.1)
      const g = new THREE.IcosahedronGeometry(r, 0)
      g.translate(x, y + r * 0.6 + i * size * 0.28, z)
      out.push(withColor(g, ROCK.clone().multiplyScalar(0.9 + 0.2 * rand(x, z, i))))
    }
    this.addObstacle(x, z, size * 0.5)
    return out
  }

  /**
   * An ant hill `height` high: a cone of needles with a rounded top, 2.5 times as wide as
   * it is high, its foot uneven and sunk into the ground, leaning a little toward `angle`.
   * The shape and the shading come from its position, the same in every build.
   */
  private antHill(x: number, z: number, height: number, angle: number, ground: (x: number, z: number) => number) {
    const radius = height * ANT_HILL_RADIUS
    const lean = height * (0.05 + 0.1 * rand(x, z, 1))
    const phase = [rand(x, z, 2), rand(x, z, 3), rand(x, z, 4)].map(r => r * Math.PI * 2)
    const sides = 72
    const rings = 24
    const positions: number[] = []
    const colors: number[] = []
    for (let i = 0; i <= rings; i++) {
      // t: 0 at the top, 1 at the foot. The profile is rounded at the top, steep on the sides.
      const t = i / rings
      const rise = height * (1 - t ** 1.5) - ANT_HILL_SINK_M * t
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2
        const wobble =
          1 + 0.07 * Math.sin(2 * a + phase[0]!) + 0.05 * Math.sin(3 * a + phase[1]!) + 0.03 * Math.sin(5 * a + phase[2]!)
        // Lumps of needles and twigs, a few centimetres either way.
        const lump = 1 + 0.06 * (rand(x + i, z + j, 7) - 0.5)
        const r = radius * t * wobble * lump
        const top = (1 - t) * lean
        const px = x + Math.cos(a) * r + Math.cos(angle) * top
        const pz = z - Math.sin(a) * r - Math.sin(angle) * top
        positions.push(px, ground(px, pz) + rise + 0.03 * height * (rand(px, pz, 8) - 0.5) * (1 - t), pz)
        // Darker and damper at the foot, drier at the top.
        const shade = 1.12 - 0.3 * t
        colors.push(NEEDLES.r * shade, NEEDLES.g * shade, NEEDLES.b * shade)
      }
    }
    const index: number[] = []
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < sides; j++) {
        const a = i * sides + j
        const b = i * sides + ((j + 1) % sides)
        index.push(a, a + sides, b, b, a + sides, b + sides)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    g.setIndex(index)
    g.computeVertexNormals()
    // Speckled: each small triangle a lighter or darker clump of needles.
    const out = g.toNonIndexed()
    const color = out.getAttribute('color')
    for (let f = 0; f < color.count; f += 3) {
      const speck = 0.65 + 0.6 * rand(x + f, z, 5) ** 1.5
      for (let v = f; v < f + 3; v++) color.setXYZ(v, color.getX(v) * speck, color.getY(v) * speck, color.getZ(v) * speck)
    }
    // Runners brush past the foot, where it is low.
    this.addObstacle(x, z, radius * 0.8)
    this.clearings.push(x, z, radius * 1.05)
    return out
  }

  /**
   * A picnic table `length` long: a top of five planks, a two-plank bench along each side,
   * and an A-shaped pair of legs at each end, carrying the top and a crossbar under the
   * benches. It stands level, turned toward `angle`; each leg reaches down to the ground.
   * New tables are honey-coloured, old ones grey.
   */
  private picnicTable(x: number, z: number, length: number, angle: number, ground: (x: number, z: number) => number) {
    const s = length / 1.8
    const plank = 0.135 * s
    const gap = 0.012 * s
    const thick = 0.036 * s
    const topY = 0.76 * s
    const seatY = 0.45 * s
    const frameX = length / 2 - 0.3 * s
    const legFootZ = 0.68 * s
    const legTopZ = 0.2 * s
    const benchZ = 0.62 * s
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // Local x runs along the table, z across it; the world turns x toward `angle`.
    const toWorld = (lx: number, lz: number): [number, number] => [x + lx * cos + lz * sin, z - lx * sin + lz * cos]
    // Level at the mean ground under the feet.
    const feet = [-1, 1].flatMap(i => [-1, 1].map(j => toWorld(i * frameX, j * legFootZ)))
    const base = feet.reduce((sum, [fx, fz]) => sum + ground(fx, fz), 0) / feet.length
    const age = rand(x, z, 9)
    const wood = NEW_PINE.clone().lerp(GREY_PINE, age)
    const shade = (i: number) => wood.clone().multiplyScalar(0.85 + 0.25 * rand(x + i, z, 10))
    const parts: THREE.BufferGeometry[] = []
    let i = 0
    const board = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number) => {
      const g = new THREE.BoxGeometry(sx, sy, sz)
      g.translate(lx, ly, lz)
      parts.push(withColor(g, shade(i++)))
    }
    // The top, and a bench on either side.
    for (let k = -2; k <= 2; k++) board(0, topY - thick / 2, k * (plank + gap), length, thick, plank)
    for (const side of [-1, 1]) {
      for (const k of [-0.5, 0.5]) board(0, seatY - thick / 2, side * benchZ + k * (plank + gap), length, thick, plank)
    }
    for (const end of [-1, 1]) {
      const fx = end * frameX
      // Cleat under the top, and the crossbar that carries the benches, bolted to the
      // outside of the legs.
      const outside = fx + end * 0.045 * s
      board(outside, topY - thick - 0.04 * s, 0, 0.045 * s, 0.08 * s, 0.72 * s)
      board(outside, seatY - thick - 0.05 * s, 0, 0.045 * s, 0.1 * s, 2 * benchZ + plank * 1.2)
      for (const side of [-1, 1]) {
        const [wx, wz] = toWorld(fx, side * legFootZ)
        const foot = new THREE.Vector3(fx, ground(wx, wz) - base - 0.08, side * legFootZ)
        const top = new THREE.Vector3(fx, topY - thick, side * legTopZ)
        parts.push(beam(foot, top, 0.045 * s, 0.11 * s, shade(i++)))
      }
      // A brace from the crossbar up to the middle of the top.
      const brace = beam(
        new THREE.Vector3(fx, seatY - thick - 0.1 * s, 0),
        new THREE.Vector3(end * 0.15 * s, topY - thick, 0),
        0.045 * s,
        0.08 * s,
        shade(i++),
      )
      parts.push(brace)
    }
    const g = mergeGeometries(parts)
    g.rotateY(angle)
    g.translate(x, base, z)
    this.addObstacle(x, z, PICNIC_TABLE_RADIUS * s * 0.75)
    this.clearings.push(x, z, PICNIC_TABLE_RADIUS * s * 1.1)
    return g
  }

  private fodderRack(x: number, y: number, z: number, size: number, angle: number): THREE.BufferGeometry[] {
    const box = new THREE.BoxGeometry(size, size * 0.6, size * 0.7)
    box.rotateY(-angle)
    box.translate(x, y + size * 0.5, z)
    const roof = new THREE.BoxGeometry(size * 1.1, 0.08, size * 0.9)
    roof.rotateY(-angle)
    roof.translate(x, y + size * 0.85, z)
    this.addObstacle(x, z, size * 0.5)
    return [withColor(box, WOOD), withColor(roof, DARK_WOOD)]
  }

  private footbridge(x: number, z: number, length: number, angle: number, ground: (x: number, z: number) => number) {
    const dx = (Math.cos(angle) * length) / 2
    const dz = (-Math.sin(angle) * length) / 2
    const a = new THREE.Vector3(x - dx, ground(x - dx, z - dz) + 0.1, z - dz)
    const b = new THREE.Vector3(x + dx, ground(x + dx, z + dz) + 0.1, z + dz)
    return beam(a, b, 1.0, 0.12, WOOD)
  }

  /**
   * A rock face from the map's cliff line (top) down to the foot (bottom, about 1 m out
   * on the lower side; the pipeline carves the terrain into a step to match). Each
   * column is a profile: a rounded rock edge from the line out to the face, then a
   * near-vertical, uneven drop that ends below the ground. The ends are closed.
   */
  /** Water surfaces in the waterholes' pits, just below the lowest point of the rim. */
  private waterholes(ponds: FeatureFile['points'], ground: (x: number, z: number) => number): THREE.Mesh {
    const positions: number[] = []
    const indices: number[] = []
    const sides = 20
    for (const [, x, z, size] of ponds) {
      const radius = size / 2
      let rim = Infinity
      for (let a = 0; a < 12; a++) {
        const t = (a / 12) * Math.PI * 2
        rim = Math.min(rim, ground(x + Math.cos(t) * (radius + 0.4), z + Math.sin(t) * (radius + 0.4)))
      }
      const level = rim - 0.06
      const centre = positions.length / 3
      positions.push(x, level, z)
      for (let a = 0; a < sides; a++) {
        const t = (a / sides) * Math.PI * 2
        // An uneven shore; the ground hides what lies under the banks.
        const r = radius * (0.9 + 0.25 * rand(x + a, z, 31))
        positions.push(x + Math.cos(t) * r, level, z + Math.sin(t) * r)
      }
      for (let a = 0; a < sides; a++) indices.push(centre, centre + 1 + ((a + 1) % sides), centre + 1 + a)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    const mesh = new THREE.Mesh(geometry, waterMaterial())
    mesh.receiveShadow = true
    mesh.name = 'waterholes'
    return mesh
  }

  private cliff(top: [number, number, number][], bottom: [number, number, number][]): THREE.BufferGeometry {
    const maxDrop = Math.max(...top.map((t, i) => t[1] - bottom[i]![1]), 0.5)
    // Profile rows: `out` along the face direction (in face widths) and either `lift`
    // (metres above the top) or `share` (of the drop below the top).
    const profile: { out: number; lift?: number; share?: number }[] = [
      { out: -0.2, lift: -0.06 }, // starts in the ground behind the line
      { out: 0.35, lift: 0.08 }, // the rounded rock edge
      { out: 0.8, lift: 0.05 },
      { out: 1.0, lift: -0.1 },
    ]
    const steps = Math.max(2, Math.ceil(maxDrop / 1.2))
    for (let k = 1; k <= steps; k++) profile.push({ out: 1.0, share: k / steps })
    profile.push({ out: 1.08, lift: -Infinity }) // below the foot
    const rows = profile.length
    const positions: number[] = []
    const colors: number[] = []
    const indices: number[] = []
    const columns = top.map((t, i) => {
      const b = bottom[i]!
      const ox = b[0] - t[0]
      const oz = b[2] - t[2]
      const width = Math.hypot(ox, oz) || 1
      const nx = ox / width
      const nz = oz / width
      const drop = t[1] - b[1]
      return profile.map((row, r) => {
        let o = row.out * width
        let y: number
        if (r === rows - 1) y = b[1] - 0.4
        else if (row.share !== undefined) y = t[1] - 0.1 - row.share * (drop - 0.1)
        else y = t[1] + row.lift!
        // Uneven rock: in and out of the face, up and down; less on the edge. Blocks
        // stand out over several columns (slow noise), with smaller bumps on top.
        const face = row.share !== undefined && row.share < 1
        if (r > 0 && r < rows - 1) {
          const block = Math.sin(t[0] * 0.37 + t[2] * 0.29 + r * 0.9) * Math.sin(t[0] * 0.11 - t[2] * 0.17 + r * 1.3)
          o += face ? block * 0.3 + (rand(t[0] + r * 3.1, t[2], 11) - 0.5) * 0.35 : (rand(t[0] + r * 3.1, t[2], 11) - 0.5) * 0.1
          y += (rand(t[2], t[0] + r * 1.7, 12) - 0.5) * (face ? 0.25 : 0.04)
        }
        return new THREE.Vector3(t[0] + nx * o, y, t[2] + nz * o)
      })
    })
    const c = new THREE.Color()
    for (const column of columns) {
      column.forEach((p, r) => {
        positions.push(p.x, p.y, p.z)
        // Darker in the cracks and towards the foot.
        const shade = r < 3 ? 1 : 0.62 + 0.38 * (1 - r / rows)
        c.setScalar(shade * (0.85 + 0.25 * rand(p.x, p.z, 7)))
        colors.push(c.r, c.g, c.b)
      })
    }
    // Cliffs fall to either side of their line; wind each triangle to face `out`.
    const pa = new THREE.Vector3()
    const pb = new THREE.Vector3()
    const pc = new THREE.Vector3()
    const triangle = (a: number, b: number, d: number, out: THREE.Vector3) => {
      pa.fromArray(positions, a * 3)
      pb.fromArray(positions, b * 3).sub(pa)
      pc.fromArray(positions, d * 3).sub(pa)
      if (pb.cross(pc).dot(out) >= 0) indices.push(a, b, d)
      else indices.push(a, d, b)
    }
    const out = new THREE.Vector3()
    for (let i = 0; i + 1 < columns.length; i++) {
      // Out of the rock: up from the edge, and towards the lower side.
      out.set(bottom[i]![0] - top[i]![0], 1, bottom[i]![2] - top[i]![2])
      for (let r = 0; r + 1 < rows; r++) {
        const a = i * rows + r
        const b = (i + 1) * rows + r
        triangle(a, a + 1, b, out)
        triangle(b, a + 1, b + 1, out)
      }
    }
    // Close the ends: a fan from each end profile to a point a little beyond it.
    for (const end of [0, columns.length - 1]) {
      const column = columns[end]!
      const other = columns[end === 0 ? 1 : end - 1]!
      const mid = column[Math.floor(rows / 2)]!.clone().lerp(column[1]!, 0.5)
      const away = mid.clone().sub(other[Math.floor(rows / 2)]!.clone().lerp(other[1]!, 0.5)).setY(0)
      if (away.lengthSq() > 0) away.normalize().multiplyScalar(0.5)
      const tip = mid.add(away)
      const tipIndex = positions.length / 3
      positions.push(tip.x, tip.y, tip.z)
      colors.push(0.8, 0.8, 0.8)
      for (let r = 0; r + 1 < rows; r++) triangle(tipIndex, end * rows + r, end * rows + r + 1, away)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    return g
  }
}
