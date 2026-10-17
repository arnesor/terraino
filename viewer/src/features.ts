import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { type Gfx, rockMaterial } from './gfx'
import type { HeightField } from './heightfield'
import type { World } from './world'

interface FeatureFile {
  kinds: string[]
  /** [kind index, x, z, size, angle] */
  points: [number, number, number, number, number][]
  lines: { kind: string; size: number; points: [number, number][] }[]
  cliffs: { kind: string; top: [number, number, number][]; bottom: [number, number, number][] }[]
}

const ROCK = new THREE.Color(0x77756e)
const LICHEN = new THREE.Color(0x9a9c88)
const WOOD = new THREE.Color(0x7d6f5c)
const DARK_WOOD = new THREE.Color(0x4f4336)
const STONE_WALL = new THREE.Color(0x85827a)
const POLE = new THREE.Color(0x5a4a38)
const STEEL = new THREE.Color(0x8c9196)
const COLLISION_CELL = 16

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

/** Rocks, cliffs, walls, fences, power lines and small structures from the map. */
export class MapFeatures {
  readonly group = new THREE.Group()
  private readonly obstacles = new Map<number, [number, number, number][]>()

  private readonly gfx: Gfx

  private constructor(gfx: Gfx) {
    this.gfx = gfx
    this.group.name = 'features'
  }

  static async load(world: World, heights: HeightField, gfx: Gfx): Promise<MapFeatures | null> {
    const info = world.manifest.features
    if (!info) return null
    const response = await fetch(world.url(info.path))
    if (!response.ok) return null
    const data = (await response.json()) as FeatureFile
    const features = new MapFeatures(gfx)
    features.build(data, heights)
    return features
  }

  private addObstacle(x: number, z: number, radius: number) {
    const key = Math.floor(x / COLLISION_CELL) * 100003 + Math.floor(z / COLLISION_CELL)
    let list = this.obstacles.get(key)
    if (!list) this.obstacles.set(key, (list = []))
    list.push([x, z, radius])
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

  private build(data: FeatureFile, heights: HeightField) {
    const parts: THREE.BufferGeometry[] = []
    const ground = (x: number, z: number) => heights.heightAt(x, z)

    // Rocks are instanced: a few shapes, many sizes.
    const rockShapes = this.gfx.models.rocks
    const rocks = data.points.filter(p => data.kinds[p[0]] === 'boulder' || data.kinds[p[0]] === 'stone')
    const material = rockMaterial(this.gfx, true)
    const matrix = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    rockShapes.forEach((shape, s) => {
      const mine = rocks.filter((_, i) => i % rockShapes.length === s)
      const mesh = new THREE.InstancedMesh(shape, material, Math.max(mine.length, 1))
      mine.forEach(([, x, z, size, angle], i) => {
        const half = size / 2
        // The models are about 2 wide and 1 high, with a flat bottom a quarter below 0.
        pos.set(x, ground(x, z) + half * 0.1, z)
        quat.setFromAxisAngle(up, angle)
        scale.set(half * (1.0 + 0.3 * rand(x, z, 1)), half * 1.3, half * (0.85 + 0.3 * rand(x, z, 2)))
        mesh.setMatrixAt(i, matrix.compose(pos, quat, scale))
        const t = 0.85 + 0.3 * rand(x, z, 4)
        mesh.setColorAt(i, new THREE.Color(t, t, t))
        if (size > 0.6) this.addObstacle(x, z, half * 1.1)
      })
      mesh.count = mine.length
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      this.group.add(mesh)
    })

    for (const [k, x, z, size, angle] of data.points) {
      const kind = data.kinds[k]
      const y = ground(x, z)
      if (kind === 'tower') parts.push(...this.tower(x, y, z, size, angle))
      else if (kind === 'cairn') parts.push(...this.cairn(x, y, z, size))
      else if (kind === 'fodder_rack') parts.push(...this.fodderRack(x, y, z, size, angle))
      else if (kind === 'footbridge') parts.push(this.footbridge(x, z, size, angle, ground))
    }

    const wires: number[] = []
    for (const line of data.lines) {
      const pts = line.points.map(([x, z]) => new THREE.Vector3(x, ground(x, z), z))
      if (line.kind === 'stone_wall' || line.kind === 'ruined_wall' || line.kind === 'ruin') {
        parts.push(...this.wall(pts, line.size, line.kind !== 'stone_wall'))
      } else if (line.kind === 'fence' || line.kind === 'ruined_fence') {
        parts.push(...this.fence(pts, line.size, line.kind === 'ruined_fence'))
      } else if (line.kind === 'power_line' || line.kind === 'pylon_line') {
        parts.push(...this.powerLine(pts, line.size, line.kind === 'pylon_line', wires))
      }
    }

    for (const cliff of data.cliffs) parts.push(this.cliff(cliff.top, cliff.bottom))

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

  private wall(pts: THREE.Vector3[], height: number, ruined: boolean): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = []
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!.clone()
      const b = pts[i + 1]!.clone()
      if (ruined && rand(a.x, a.z, 9) < 0.35) continue
      const h = height * (0.75 + 0.4 * rand(a.x, a.z, 5))
      a.y -= 0.2
      b.y -= 0.2
      const shade = 0.85 + 0.25 * rand(a.x, a.z, 6)
      out.push(beam(a, b, 0.7, h + 0.2, STONE_WALL.clone().multiplyScalar(shade)))
    }
    return out
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

  private powerLine(pts: THREE.Vector3[], height: number, steel: boolean, wires: number[]): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = []
    // Poles every ~60 m (pylons ~250 m), always at both ends.
    const spacing = steel ? 250 : 60
    const poles = alongLine(pts, spacing)
    const last = pts[pts.length - 1]!
    if (poles.length === 0 || poles[poles.length - 1]!.distanceTo(last) > spacing * 0.3) poles.push(last)
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

  private cliff(top: [number, number, number][], bottom: [number, number, number][]): THREE.BufferGeometry {
    // A strip of quads from the top line down to the bottom line, with ragged middle rows.
    const rows = 4
    const positions: number[] = []
    const colors: number[] = []
    const grid: THREE.Vector3[][] = top.map((t, i) => {
      const b = bottom[i]!
      const column: THREE.Vector3[] = []
      for (let r = 0; r <= rows; r++) {
        const f = r / rows
        const p = new THREE.Vector3(t[0] + (b[0] - t[0]) * f, t[1] + (b[1] - t[1]) * f, t[2] + (b[2] - t[2]) * f)
        if (r > 0 && r < rows) {
          p.x += (rand(p.x, p.z, r) - 0.5) * 0.6
          p.z += (rand(p.z, p.x, r) - 0.5) * 0.6
          p.y += (rand(p.x, p.y, r) - 0.5) * 0.4
        }
        column.push(p)
      }
      return column
    })
    const c = new THREE.Color()
    for (let i = 0; i + 1 < grid.length; i++) {
      for (let r = 0; r < rows; r++) {
        const a = grid[i]![r]!
        const b = grid[i + 1]![r]!
        const d = grid[i]![r + 1]!
        const e = grid[i + 1]![r + 1]!
        for (const p of [a, d, b, b, d, e]) {
          positions.push(p.x, p.y, p.z)
          c.copy(ROCK).multiplyScalar(0.75 + 0.35 * rand(p.x, p.y, 7)).lerp(LICHEN, r === 0 ? 0.4 : 0.1)
          colors.push(c.r, c.g, c.b)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    g.computeVertexNormals()
    return g
  }
}
