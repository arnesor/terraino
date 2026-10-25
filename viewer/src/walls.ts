import * as THREE from 'three'
import { type Gfx, GROUND_TEX_GLSL, type QualitySettings, rockMaterial } from './gfx'
import type { HeightField } from './heightfield'
import type { Tracks } from './tracks'

// Stone walls, ruined walls and ruins (ISOM 2017 523, ISOM 2000 530): dry-stone walls along
// the map's lines, following the ground. A ruin's outline gets one or two door openings,
// the main one facing the nearest path or road. Near the player a wall is built of single
// stones; farther away it is one mesh with stone courses painted on, and the two dissolve
// into each other at QualitySettings.wallStones. No collision: orienteers step over walls
// this low.

export const WALL_KINDS: ReadonlySet<string> = new Set(['stone_wall', 'ruined_wall', 'ruin'])

/** A wall line from the world package: kind, height and the line (closed for a ruin). */
export interface WallLine {
  kind: string
  size: number
  points: [number, number][]
}

/** What the walls need from the tracks: where the nearest path or road is. */
export type TrackFinder = Pick<Tracks, 'nearestPoint'>

// Paths and roads a door may face (streams do not count).
const DOOR_TRACKS: ReadonlySet<string> = new Set(['paved', 'gravel', 'vehicle_track', 'path', 'small_path', 'faint_path'])
const DOOR_SEARCH_M = 300
export const DOOR_WIDTH = 1.1
// A door keeps this far from a corner; a ruin this long around gets a second door.
export const DOOR_CORNER = 0.8
const TWO_DOORS_PERIMETER = 30
// Corners are where the outline turns more than this.
const CORNER_TURN = (20 * Math.PI) / 180
const STEP = 0.4 // m between wall samples
const SINK = 0.15 // the foot goes this far into the ground
const STONE_WALL_WIDTH = 0.8
const RUIN_WIDTH = 0.7
// Width at the top, of the width at the foot.
const TOP_WIDTH = 0.6
// The stones near the player are picked from a grid of this cell size whenever the
// player has moved this far; they dissolve over this distance into the painted wall.
const STONE_CELL = 64
const STONE_REBUILD_DISTANCE = 10
const FADE_M = 6

function rand(x: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453
  return h - Math.floor(h)
}

/** Smooth 1D value noise in [0, 1). */
function noise(s: number, salt: number): number {
  const i = Math.floor(s)
  const f = s - i
  const t = f * f * (3 - 2 * f)
  return rand(i, salt, 1) * (1 - t) + rand(i + 1, salt, 1) * t
}

/** A point on a wall: where along it (s), its direction, and the ground and height there. */
export interface WallSample {
  s: number
  x: number
  z: number
  /** Unit direction along the wall. */
  tx: number
  tz: number
  /** Widening at a corner, so the faces keep their width (1 on a straight stretch). */
  miter: number
  /** Ground under the lower face. */
  foot: number
  height: number
}

/** A ruin outline's corners: the points where it turns. The ring is not closed. */
function corners(points: [number, number][]): [number, number][] {
  const ring = points.slice(0, -1)
  const out = ring.filter((b, i) => {
    const a = ring[(i - 1 + ring.length) % ring.length]!
    const c = ring[(i + 1) % ring.length]!
    let turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]))
    if (turn > Math.PI) turn = 2 * Math.PI - turn
    return turn > CORNER_TURN
  })
  return out.length >= 3 ? out : ring
}

/**
 * Door openings of a ruin with these corners, as [start, end] distances along the ring
 * from the first corner: the main door on the side facing the nearest path or road (or
 * else the longest side), at the point nearest it; around a larger ruin, a second door in
 * the opposite side.
 */
export function doorOpenings(ring: [number, number][], tracks: TrackFinder | null): [number, number][] {
  const n = ring.length
  const cx = ring.reduce((t, p) => t + p[0], 0) / n
  const cz = ring.reduce((t, p) => t + p[1], 0) / n
  let start = 0
  const sides = ring.map((a, i) => {
    const b = ring[(i + 1) % n]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    let nx = -(b[1] - a[1]) / length
    let nz = (b[0] - a[0]) / length
    // Outward: away from the middle.
    if (nx * ((a[0] + b[0]) / 2 - cx) + nz * ((a[1] + b[1]) / 2 - cz) < 0) {
      nx = -nx
      nz = -nz
    }
    const side = { a, b, length, nx, nz, start }
    start += length
    return side
  })
  const usable = sides.filter(side => side.length >= DOOR_WIDTH + 2 * DOOR_CORNER)
  if (!usable.length) return []
  const target = tracks?.nearestPoint(cx, cz, DOOR_SEARCH_M, DOOR_TRACKS) ?? null
  const towards = (side: (typeof sides)[number]) => {
    if (!target) return side.length
    const dx = target.x - cx
    const dz = target.z - cz
    return (side.nx * dx + side.nz * dz) / (Math.hypot(dx, dz) || 1)
  }
  const opening = (side: (typeof sides)[number], along: number): [number, number] => {
    const margin = DOOR_CORNER + DOOR_WIDTH / 2
    const centre = Math.min(Math.max(along, margin), side.length - margin)
    return [side.start + centre - DOOR_WIDTH / 2, side.start + centre + DOOR_WIDTH / 2]
  }
  const main = usable.reduce((best, side) => (towards(side) > towards(best) ? side : best))
  let along = main.length / 2
  if (target) {
    along = ((target.x - main.a[0]) * (main.b[0] - main.a[0]) + (target.z - main.a[1]) * (main.b[1] - main.a[1])) / main.length
  }
  const out = [opening(main, along)]
  if (start >= TWO_DOORS_PERIMETER) {
    const back = usable.reduce((best, side) => (towards(side) < towards(best) ? side : best))
    if (back !== main) out.push(opening(back, back.length * (0.35 + 0.3 * rand(cx, cz, 5))))
  }
  return out.sort((a, b) => a[0] - b[0])
}

/**
 * A wall as runs of samples: a ruin's ring broken at its doors, or a wall's line. The
 * height varies along the wall; ruined walls and ruins have low, fallen stretches, and a
 * ruin's door ends have tumbled down a little.
 */
export function wallRuns(line: WallLine, heights: HeightField, tracks: TrackFinder | null): WallSample[][] {
  const width = wallWidth(line)
  const ruin = line.kind === 'ruin'
  const ruined = ruin || line.kind === 'ruined_wall'
  const closed = ruin && line.points.length > 3
  const pts = closed ? corners(line.points) : line.points
  const openings = closed ? doorOpenings(pts, tracks) : []
  const path = closed ? [...pts, pts[0]!] : pts
  const seed = line.points[0]![0] + line.points[0]![1]

  // Samples every STEP along the line, at every corner and on the edges of the doors.
  const raw: { s: number; x: number; z: number }[] = []
  let total = 0
  for (let i = 0; i + 1 < path.length; i++) {
    const [x0, z0] = path[i]!
    const [x1, z1] = path[i + 1]!
    const length = Math.hypot(x1 - x0, z1 - z0)
    const n = Math.max(1, Math.round(length / STEP))
    const at = Array.from({ length: n }, (_, k) => (length * k) / n)
    for (const edge of openings.flat()) if (edge > total && edge < total + length) at.push(edge - total)
    at.sort((a, b) => a - b)
    let last = -Infinity
    for (const t of at) {
      if (t - last < 0.01) continue
      last = t
      raw.push({ s: total + t, x: x0 + ((x1 - x0) * t) / length, z: z0 + ((z1 - z0) * t) / length })
    }
    total += length
  }
  const last = path[path.length - 1]!
  raw.push({ s: total, x: last[0], z: last[1] })

  // The edge samples stay: they end the wall.
  const inDoor = (s: number) => openings.some(([a, b]) => s > a + 1e-6 && s < b - 1e-6)
  const toDoor = (s: number) => Math.min(Infinity, ...openings.map(([a, b]) => Math.min(Math.abs(s - a), Math.abs(s - b))))
  const samples = raw.map((r, i): WallSample | null => {
    if (inDoor(r.s)) return null
    // Direction: the mean of the segments meeting here.
    const prev = raw[i - 1] ?? (closed ? raw[raw.length - 2]! : r)
    const next = raw[i + 1] ?? (closed ? raw[1]! : r)
    const la = Math.hypot(r.x - prev.x, r.z - prev.z) || 1
    const lb = Math.hypot(next.x - r.x, next.z - r.z) || 1
    let tx = (r.x - prev.x) / la + (next.x - r.x) / lb
    let tz = (r.z - prev.z) / la + (next.z - r.z) / lb
    const lt = Math.hypot(tx, tz) || 1
    tx /= lt
    tz /= lt
    const miter = Math.min(1 / Math.max((tx * (next.x - r.x) + tz * (next.z - r.z)) / lb, 0.5), 2)
    const half = width / 2
    const foot = Math.min(heights.heightAt(r.x - tz * half, r.z + tx * half), heights.heightAt(r.x + tz * half, r.z - tx * half))
    let height = line.size * (0.8 + 0.45 * noise(r.s / 1.3, seed))
    if (ruined) {
      height *= 0.45 + 0.55 * THREE.MathUtils.smoothstep(noise(r.s / 3.5, seed + 1), 0.25, 0.45)
      height *= 0.6 + 0.4 * THREE.MathUtils.smoothstep(toDoor(r.s), 0, 0.7)
    }
    return { s: r.s, x: r.x, z: r.z, tx, tz, miter, foot, height: Math.max(height, 0.15) }
  })

  const runs: WallSample[][] = [[]]
  for (const sample of samples) {
    if (sample) runs[runs.length - 1]!.push(sample)
    else if (runs[runs.length - 1]!.length) runs.push([])
  }
  // Around a ring, the run across the first corner is one run.
  if (closed && runs.length > 1 && samples[0] && samples[samples.length - 1]) {
    const end = runs.pop()!
    runs[0] = [...end.slice(0, -1), ...runs[0]!.map(p => ({ ...p, s: p.s + total }))]
  }
  return runs.filter(run => run.length >= 2)
}

function wallWidth(line: WallLine): number {
  return line.kind === 'stone_wall' ? STONE_WALL_WIDTH : RUIN_WIDTH
}

// ------------------------------------------------------------------ the painted wall

// Cross-section: (across, of the height), from the outer foot over the top to the inner.
const PROFILE: [number, number][] = [
  [-0.5, -1],
  [-0.48, 0.2],
  [-0.38, 0.8],
  [-0.22, 1],
  [0.22, 1],
  [0.38, 0.8],
  [0.48, 0.2],
  [0.5, -1],
]

/** One mesh for all walls; `aWall` is (distance along the wall, height above its foot). */
function paintedWalls(walls: { runs: WallSample[][]; width: number }[]): THREE.BufferGeometry {
  const positions: number[] = []
  const wall: number[] = []
  const indices: number[] = []
  const k = PROFILE.length
  for (const { runs, width } of walls) {
    for (const run of runs) {
      const base = positions.length / 3
      for (const p of run) {
        for (const [across, up] of PROFILE) {
          const y = up < 0 ? -SINK : up * p.height
          const w = width * (1 - (1 - TOP_WIDTH) * Math.max(up, 0)) * (Math.abs(across) / 0.5)
          // The faces bulge a little, stone by stone.
          const bulge = up > 0 && up < 1 ? (rand(p.s * 3.1, y * 7, 11) - 0.5) * 0.05 : 0
          const off = Math.sign(across) * (w / 2 + bulge) * p.miter
          positions.push(p.x + p.tz * off, p.foot + y, p.z - p.tx * off)
          wall.push(p.s, Math.max(y, 0))
        }
      }
      for (let i = 0; i + 1 < run.length; i++) {
        for (let j = 0; j + 1 < k; j++) {
          const a = base + i * k + j
          indices.push(a, a + k, a + 1, a + 1, a + k, a + k + 1)
        }
      }
      // End caps: fans over the profile.
      const first = base
      const end = base + (run.length - 1) * k
      for (let j = 1; j + 1 < k; j++) indices.push(first, first + j + 1, first + j, end, end + j, end + j + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Dry-stone courses painted on the wall mesh: rows of stones of varying length that
 * wander up and down, dark joints, moss on top. Hidden nearer than `fade` (dissolving
 * between its x and y), where the single stones stand.
 */
function paintedMaterial(gfx: Gfx, fade: { value: THREE.Vector2 }): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial()
  material.onBeforeCompile = shader => {
    shader.uniforms['groundTex'] = { value: gfx.groundArray }
    shader.uniforms['uFade'] = fade
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aWall;\nvarying vec2 vWall;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWall = aWall;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vWall;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        uniform vec2 uFade;
        float vegDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
        ${GROUND_TEX_GLSL}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (smoothstep(uFade.x, uFade.y, distance(vWPos.xz, cameraPosition.xz)) < vegDither(gl_FragCoord.xy)) discard;`,
      )
      .replace(
        '#include <map_fragment>',
        `float rowH = 0.17;
        // Courses wander up and down, and each stone sits a little higher or lower.
        float wave = (gtNoise(vec2(vWall.x * 1.7, 3.0)) - 0.5) * 0.9 + (gtNoise(vec2(vWall.x * 0.5, 9.0)) - 0.5) * 1.2;
        float rowF = vWall.y / rowH + wave;
        float row = floor(rowF);
        float len = 0.22 + 0.4 * gtHash(vec2(row, 3.0));
        float u = vWall.x / len + gtHash(vec2(row, 7.0)) * 3.0 + (gtNoise(vec2(vWall.y * 6.0, row)) - 0.5) * 0.3;
        vec2 id = vec2(floor(u), row);
        float fx = fract(u);
        float fy = clamp(fract(rowF) + (gtHash(id + 0.7) - 0.5) * 0.3, 0.0, 1.0);
        // Rounded stones: the joints widen towards their corners.
        float jx = min(fx, 1.0 - fx) * len;
        float jy = min(fy, 1.0 - fy) * rowH * (0.6 + 0.8 * gtHash(id + 1.3));
        float d = min(jx, jy) - 0.012 * (1.0 - smoothstep(0.0, 0.05, max(jx, jy)));
        bool onTop = vWNormal.y > 0.7;
        if (onTop) d = 1.0;
        vec3 sc = texture(groundTex, vec3(onTop ? vWPos.xz * 0.5 : vWall * 0.5 + id * 0.37, GT_ROCK)).rgb;
        // Mute the texture's lichen spots, which would repeat on every stone.
        sc = mix(sc, textureLod(groundTex, vec3(0.5, 0.5, GT_ROCK), 9.0).rgb, 0.55);
        sc *= vec3(0.86, 0.9, 0.82) * (0.6 + 0.65 * gtHash(id));
        sc *= 0.5 + 0.5 * smoothstep(0.0, 0.05, d);
        vec3 c = mix(sc, vec3(0.012, 0.012, 0.01), 1.0 - smoothstep(0.004, 0.018, d));
        float m = smoothstep(0.45, 0.85, vWNormal.y + (gtNoise(vWPos.xz * 1.3) - 0.5) * 0.6);
        m = max(m, 0.7 * smoothstep(0.62, 0.8, gtNoise(vWall * 1.9 + 5.0)) * smoothstep(0.004, 0.03, d));
        c = mix(c, pow(vec3(0.36, 0.42, 0.2), vec3(2.2)) * (0.75 + 0.5 * gtNoise(vWPos.xz * 4.0)), m * 0.75);
        diffuseColor.rgb *= c;`,
      )
  }
  material.customProgramCacheKey = () => 'terraino-painted-wall'
  return material
}

// ------------------------------------------------------------------ single stones

/** A few irregular, flat-faced stone shapes in a unit box, darker underneath. */
function stoneShapes(): THREE.BufferGeometry[] {
  return [1, 2, 3].map(seed => {
    const g = new THREE.IcosahedronGeometry(0.5, 1)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      // Pulled towards a box, for flatter faces to stack.
      const box = Math.min(0.5 / Math.max(Math.abs(x), Math.abs(y), Math.abs(z), 1e-3), 1.6)
      const f = (0.85 + 0.3 * rand(x * 3 + seed, y * 5 + z * 7, seed)) * (0.55 + 0.45 * box)
      p.setXYZ(i, x * f, y * f, z * f)
    }
    g.deleteAttribute('uv')
    g.computeBoundingBox()
    const size = g.boundingBox!.getSize(new THREE.Vector3())
    const centre = g.boundingBox!.getCenter(new THREE.Vector3())
    g.translate(-centre.x, -centre.y, -centre.z)
    g.scale(1 / size.x, 1 / size.y, 1 / size.z)
    g.computeVertexNormals()
    const colors = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) colors.fill(0.65 + 0.35 * (p.getY(i) + 0.5), i * 3, i * 3 + 3)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return g
  })
}

/** One stone: its shape, its instance matrix and shade, and where it stands. */
interface Stone {
  shape: number
  matrix: THREE.Matrix4
  shade: number
  x: number
  z: number
}

/** Stones course by course along the runs, two across where the wall is wide. */
function wallStones(runs: WallSample[][], width: number, shapes: number): Stone[] {
  const out: Stone[] = []
  const euler = new THREE.Euler()
  const quat = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scale = new THREE.Vector3()
  for (const run of runs) {
    const s0 = run[0]!.s
    const s1 = run[run.length - 1]!.s
    let i = 1
    const at = (s: number): WallSample => {
      while (i < run.length - 1 && run[i]!.s < s) i++
      while (i > 1 && run[i - 1]!.s > s) i--
      const a = run[i - 1]!
      const b = run[i]!
      const t = THREE.MathUtils.clamp((s - a.s) / (b.s - a.s || 1), 0, 1)
      const l = (u: number, v: number) => u + (v - u) * t
      return { ...a, x: l(a.x, b.x), z: l(a.z, b.z), foot: l(a.foot, b.foot), height: l(a.height, b.height) }
    }
    let y = -SINK
    for (let row = 0; row < 12; row++) {
      const rh = 0.15 + 0.1 * rand(s0, row, 21)
      const yc = y + rh / 2
      y += rh
      let s = s0 - rand(s0, row, 22) * 0.4
      i = 1
      while (s < s1) {
        const length = 0.28 + 0.32 * rand(s, row, 23)
        const sc = THREE.MathUtils.clamp(s + length / 2, s0, s1)
        s += length
        const p = at(sc)
        // Above the wall's height here: this stone has fallen.
        if (yc > p.height) continue
        const w = width * (1 - (1 - TOP_WIDTH) * (yc / p.height))
        const yaw = Math.atan2(-p.tz, p.tx)
        const across = w < 0.5 ? [0] : [-w / 4, w / 4]
        for (const off of across) {
          const depth = (across.length === 1 ? w : w / 2) * (1 + 0.15 * rand(sc, off, 24))
          euler.set((rand(sc, off, 25) - 0.5) * 0.15, yaw + (rand(sc, off, 26) - 0.5) * 0.2, (rand(sc, off, 27) - 0.5) * 0.15)
          pos.set(p.x + p.tz * off, p.foot + yc, p.z - p.tx * off)
          scale.set(length * 1.08, rh * 1.15, depth)
          out.push({
            shape: out.length % shapes,
            matrix: new THREE.Matrix4().compose(pos, quat.setFromEuler(euler), scale),
            shade: 0.75 + 0.45 * rand(sc, off + row, 28),
            x: pos.x,
            z: pos.z,
          })
        }
      }
    }
  }
  return out
}

/** Fallen stones beside a ruined wall: at the door ends and along the low stretches. */
function fallenStones(runs: WallSample[][], width: number, size: number, heights: HeightField, shapes: number): Stone[] {
  const out: Stone[] = []
  const euler = new THREE.Euler()
  const quat = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scale = new THREE.Vector3()
  for (const run of runs) {
    run.forEach((p, i) => {
      const end = i === 0 || i === run.length - 1
      if (rand(p.s, p.x, 31) > (end ? 0.9 : 0.12) + (p.height < size * 0.6 ? 0.3 : 0)) return
      const side = rand(p.s, p.z, 32) < 0.5 ? -1 : 1
      const away = width / 2 + 0.15 + rand(p.s, p.x, 33)
      const x = p.x + p.tz * side * away + (rand(p.s, 1, 34) - 0.5) * 0.4
      const z = p.z - p.tx * side * away + (rand(p.s, 2, 34) - 0.5) * 0.4
      const l = 0.25 + 0.25 * rand(p.s, 3, 35)
      const h = l * (0.45 + 0.2 * rand(p.s, 4, 35))
      euler.set((rand(p.s, 5, 36) - 0.5) * 0.6, rand(p.s, 6, 36) * 6.3, (rand(p.s, 7, 36) - 0.5) * 0.6)
      pos.set(x, heights.heightAt(x, z) + h * 0.15, z)
      scale.set(l, h, l * (0.6 + 0.3 * rand(p.s, 8, 37)))
      out.push({
        shape: out.length % shapes,
        matrix: new THREE.Matrix4().compose(pos, quat.setFromEuler(euler), scale),
        shade: 0.7 + 0.4 * rand(p.s, 9, 38),
        x,
        z,
      })
    })
  }
  return out
}

/** Stone walls, ruined walls and ruins: single stones near the player, painted beyond. */
export class Walls {
  readonly group = new THREE.Group()
  /** Stones by STONE_CELL grid cell, and one instanced mesh per stone shape. */
  private readonly stones = new Map<number, Stone[]>()
  private readonly stoneMeshes: THREE.InstancedMesh[] = []
  private readonly fade = { value: new THREE.Vector2() }
  private builtAt: THREE.Vector3 | null = null
  private reach = 0

  constructor(lines: WallLine[], heights: HeightField, gfx: Gfx, quality: QualitySettings, tracks: TrackFinder | null) {
    this.group.name = 'walls'
    const shapes = stoneShapes()
    const built = lines
      .filter(line => WALL_KINDS.has(line.kind) && line.points.length >= 2)
      .map(line => ({ line, width: wallWidth(line), runs: wallRuns(line, heights, tracks) }))
    const stones: Stone[] = []
    for (const { line, width, runs } of built) {
      stones.push(...wallStones(runs, width, shapes.length))
      if (line.kind !== 'stone_wall') stones.push(...fallenStones(runs, width, line.size, heights, shapes.length))
    }
    for (const stone of stones) {
      const key = Math.floor(stone.x / STONE_CELL) * 100003 + Math.floor(stone.z / STONE_CELL)
      let cell = this.stones.get(key)
      if (!cell) this.stones.set(key, (cell = []))
      cell.push(stone)
    }

    const painted = new THREE.Mesh(paintedWalls(built), paintedMaterial(gfx, this.fade))
    painted.castShadow = painted.receiveShadow = true
    this.group.add(painted)
    const material = rockMaterial(gfx, true, this.fade)
    shapes.forEach((shape, k) => {
      const capacity = Math.max(stones.filter(s => s.shape === k).length, 1)
      const mesh = new THREE.InstancedMesh(shape, material, capacity)
      mesh.count = 0
      // The stones drawn change as the player moves; they are all near.
      mesh.frustumCulled = false
      mesh.castShadow = mesh.receiveShadow = true
      // Colours are set per instance; make the attribute now so the shader is built with it.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1))
      this.stoneMeshes.push(mesh)
      this.group.add(mesh)
    })
    this.setQuality(quality)
  }

  /** How many single stones are drawn now. */
  get drawn(): number {
    return this.stoneMeshes.reduce((n, mesh) => n + mesh.count, 0)
  }

  setQuality(quality: QualitySettings) {
    this.reach = quality.wallStones
    this.fade.value.set(Math.max(this.reach - FADE_M, 0), this.reach)
    this.builtAt = null
  }

  /** Pick the stones within reach of `eye`, after moving STONE_REBUILD_DISTANCE. */
  update(eye: THREE.Vector3) {
    if (this.builtAt && this.builtAt.distanceTo(eye) < STONE_REBUILD_DISTANCE) return
    this.builtAt = eye.clone()
    // Reach a little farther, so the stones are there when the player has moved on.
    const far = this.reach + STONE_REBUILD_DISTANCE
    const counts = this.stoneMeshes.map(() => 0)
    const color = new THREE.Color()
    for (let c = Math.floor((eye.x - far) / STONE_CELL); c <= Math.floor((eye.x + far) / STONE_CELL); c++) {
      for (let r = Math.floor((eye.z - far) / STONE_CELL); r <= Math.floor((eye.z + far) / STONE_CELL); r++) {
        for (const stone of this.stones.get(c * 100003 + r) ?? []) {
          if ((stone.x - eye.x) ** 2 + (stone.z - eye.z) ** 2 > far * far) continue
          const mesh = this.stoneMeshes[stone.shape]!
          const i = counts[stone.shape]!++
          mesh.setMatrixAt(i, stone.matrix)
          mesh.setColorAt(i, color.setScalar(stone.shade))
        }
      }
    }
    this.stoneMeshes.forEach((mesh, k) => {
      mesh.count = counts[k]!
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })
  }
}
