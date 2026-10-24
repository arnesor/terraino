import * as THREE from 'three'
import type { Gfx } from './gfx'
import type { World } from './world'

/** One roof over a rectangle: a wing of the building (heights above the base). */
export interface RoofPartRecord {
  type: 'gable' | 'shed' | 'flat'
  centre: [number, number]
  /** Ridge direction (scene x, z); for a shed roof its high edge, the roof rising to its right. */
  axis: [number, number]
  /** Half the rectangle's size along and across the ridge. */
  half: [number, number]
  eave: number
  ridge: number
  /** Hipped start and end of the ridge. */
  hips: [boolean, boolean]
}

export interface BuildingRecord {
  outline: [number, number][]
  base: number
  wall: number
  roof: number
  roofType: 'gable' | 'hip' | 'shed' | 'flat'
  /** Ridge direction (scene x, z); for a shed roof its high edge, the roof rising to the right of it. */
  ridge: [number, number]
  wallColor: string
  roofColor: string
  kind: string
  /** Building type in Matrikkelen (NS 3457), if registered. */
  type?: number | null
  /** Floors; windows are drawn floor by floor up the wall. */
  floors?: number
  /** Wings measured in a laser point cloud; when present they replace roofType, roof and ridge. */
  parts?: RoofPartRecord[]
}

const OVERHANG = 0.4
// Walls continue this far below the lowest ground point, for buildings on slopes.
const FOUNDATION = 1.0
// Texture scale: a wall module (with one window) and a floor, and a roof tile repeat.
const MODULE_M = 3.2
// Floor height when a building does not say how many floors it has.
const FLOOR_M = 2.7
const ROOF_TILE_M = 2.0

const e1 = new THREE.Vector3()
const e2 = new THREE.Vector3()

/** Collects textured triangles with per-vertex colours; normals are computed per face. */
class MeshBuilder {
  readonly positions: number[] = []
  readonly colors: number[] = []
  readonly uvs: number[] = []

  /** Add a triangle, wound so that its front faces along `facing`. */
  triangle(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    color: THREE.Color,
    facing: THREE.Vector3,
    uv: [THREE.Vector2, THREE.Vector2, THREE.Vector2] = [ZERO2, ZERO2, ZERO2],
  ) {
    let [ua, ub, uc] = uv
    const normal = e1.subVectors(b, a).cross(e2.subVectors(c, a))
    if (normal.dot(facing) < 0) {
      ;[b, c] = [c, b]
      ;[ub, uc] = [uc, ub]
    }
    this.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    this.uvs.push(ua.x, ua.y, ub.x, ub.y, uc.x, uc.y)
    for (let i = 0; i < 3; i++) this.colors.push(color.r, color.g, color.b)
  }

  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    color: THREE.Color,
    facing: THREE.Vector3,
    uv?: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2],
  ) {
    this.triangle(a, b, c, color, facing, uv && [uv[0], uv[1], uv[2]])
    this.triangle(a, c, d, color, facing, uv && [uv[0], uv[2], uv[3]])
  }

  get empty(): boolean {
    return this.positions.length === 0
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    return geometry
  }
}

const ZERO2 = new THREE.Vector2()
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const uv = (x: number, y: number) => new THREE.Vector2(x, y)
const UP = v(0, 1, 0)
const DOWN = v(0, -1, 0)

/** Outline in counter-clockwise order as seen from above (+y). */
function counterClockwise(outline: [number, number][]): [number, number][] {
  // Scene z points south, so a ring that is counter-clockwise in (x, -z) is what we want.
  let area = 0
  for (let i = 0; i < outline.length; i++) {
    const [x0, z0] = outline[i]!
    const [x1, z1] = outline[(i + 1) % outline.length]!
    area += x0 * -z1 - x1 * -z0
  }
  return area >= 0 ? outline : [...outline].reverse()
}

/** Whole wall modules over a length, so windows are never cut. */
const modules = (length: number) => Math.max(1, Math.round(length / MODULE_M))

/** A vertical wall quad from (x0, z0) to (x1, z1) between two heights, textured from the base. */
function wallQuad(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, bottom: number, top: number, base: number, floor: number, color: THREE.Color, out: THREE.Vector3) {
  const m = modules(Math.hypot(x1 - x0, z1 - z0))
  const vb = (bottom - base) / floor
  const vt = (top - base) / floor
  mb.quad(v(x0, bottom, z0), v(x1, bottom, z1), v(x1, top, z1), v(x0, top, z0), color, out, [uv(0, vb), uv(m, vb), uv(m, vt), uv(0, vt)])
}

function addWalls(mb: MeshBuilder, outline: [number, number][], bottom: number, top: number, base: number, floor: number, color: THREE.Color) {
  for (let i = 0; i < outline.length; i++) {
    const [x0, z0] = outline[i]!
    const [x1, z1] = outline[(i + 1) % outline.length]!
    // Counter-clockwise outline: the outside is to the right when walking along it.
    wallQuad(mb, x0, z0, x1, z1, bottom, top, base, floor, color, v(-(z1 - z0), 0, x1 - x0))
  }
}

function addFlatCap(mb: MeshBuilder, outline: [number, number][], top: number, color: THREE.Color) {
  const contour = outline.map(([x, z]) => new THREE.Vector2(x, -z))
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, []) as [number, number, number][]) {
    const pa = outline[a]!
    const pb = outline[b]!
    const pc = outline[c]!
    mb.triangle(v(pa[0], top, pa[1]), v(pb[0], top, pb[1]), v(pc[0], top, pc[1]), color, UP, [
      uv(pa[0] / ROOF_TILE_M, pa[1] / ROOF_TILE_M),
      uv(pb[0] / ROOF_TILE_M, pb[1] / ROOF_TILE_M),
      uv(pc[0] / ROOF_TILE_M, pc[1] / ROOF_TILE_M),
    ])
  }
}

/** A roof part's frame: s along the axis, t across it (to its right). */
function frame(p: RoofPartRecord) {
  const [ux, uz] = p.axis
  const wx = -uz
  const wz = ux
  const [cx, cz] = p.centre
  const point = (s: number, t: number, y: number) => v(cx + s * ux + t * wx, y, cz + s * uz + t * wz)
  return { ux, uz, wx, wz, point }
}

/** Roof planes, gable ends and the wall above the main walls, for one part. */
function addPart(walls: MeshBuilder, roofs: MeshBuilder, p: RoofPartRecord, base: number, floor: number, wallTop: number, wallColor: THREE.Color, roofColor: THREE.Color) {
  const { ux, uz, wx, wz, point } = frame(p)
  const [hl, hw] = p.half
  const eaveY = base + p.eave
  const ridgeY = base + p.ridge
  const under = roofColor.clone().multiplyScalar(0.5)
  const along = v(ux, 0, uz)
  const back = v(-ux, 0, -uz)
  const right = v(wx, 0, wz)
  const left = v(-wx, 0, -wz)

  // The wing's own walls between the main walls and its eaves.
  if (eaveY > wallTop + 0.1) {
    const corners: [number, number][] = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]]
    const outs = [left, along, right, back]
    corners.forEach(([s0, t0], i) => {
      const [s1, t1] = corners[(i + 1) % 4]!
      const a = point(s0, t0, 0)
      const b = point(s1, t1, 0)
      wallQuad(walls, a.x, a.z, b.x, b.z, wallTop, eaveY, base, floor, wallColor, outs[i]!)
    })
  }

  if (p.type === 'flat') {
    const o = 0.15
    const c = [point(-hl - o, -hw - o, eaveY), point(hl + o, -hw - o, eaveY), point(hl + o, hw + o, eaveY), point(-hl - o, hw + o, eaveY)]
    const tex = c.map(q => uv(q.x / ROOF_TILE_M, q.z / ROOF_TILE_M)) as [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2]
    roofs.quad(c[0]!, c[1]!, c[2]!, c[3]!, roofColor, UP, tex)
    return
  }

  if (p.type === 'shed') {
    const slope = (ridgeY - eaveY) / Math.max(2 * hw, 0.1)
    const lowY = eaveY - OVERHANG * slope
    const highY = ridgeY + OVERHANG * slope
    const length = 2 * (hl + OVERHANG)
    const run = Math.hypot(2 * (hw + OVERHANG), highY - lowY)
    roofs.quad(
      point(-hl - OVERHANG, -hw - OVERHANG, lowY),
      point(hl + OVERHANG, -hw - OVERHANG, lowY),
      point(hl + OVERHANG, hw + OVERHANG, highY),
      point(-hl - OVERHANG, hw + OVERHANG, highY),
      roofColor,
      UP,
      [uv(0, 0), uv(length / ROOF_TILE_M, 0), uv(length / ROOF_TILE_M, run / ROOF_TILE_M), uv(0, run / ROOF_TILE_M)],
    )
    roofs.quad(point(-hl - OVERHANG, -hw - OVERHANG, lowY), point(hl + OVERHANG, -hw - OVERHANG, lowY), point(hl + OVERHANG, hw + OVERHANG, highY), point(-hl - OVERHANG, hw + OVERHANG, highY), under, DOWN)
    // The high wall goes up to the roof; the end walls get a triangle each.
    const hA = point(-hl, hw, 0)
    const hB = point(hl, hw, 0)
    wallQuad(walls, hA.x, hA.z, hB.x, hB.z, eaveY, ridgeY, base, floor, wallColor, right)
    for (const [s, out] of [[-hl, back], [hl, along]] as [number, THREE.Vector3][]) {
      const m = modules(2 * hw)
      const vl = (eaveY - base) / floor
      const vh = (ridgeY - base) / floor
      walls.triangle(point(s, -hw, eaveY), point(s, hw, eaveY), point(s, hw, ridgeY), wallColor, out, [uv(0, vl), uv(m, vl), uv(m, vh)])
    }
    return
  }

  // Gable, with hipped ends where measured: the ridge stops half a width short there.
  const slope = (ridgeY - eaveY) / Math.max(hw, 0.1)
  const lowY = eaveY - OVERHANG * slope
  const [hip0, hip1] = p.hips
  const inset = Math.max(Math.min(hw, hl), 0)
  const r0 = point(hip0 ? -hl + inset : -hl - OVERHANG, 0, ridgeY)
  const r1 = point(hip1 ? hl - inset : hl + OVERHANG, 0, ridgeY)
  const e00 = point(-hl - OVERHANG, -hw - OVERHANG, lowY)
  const e10 = point(hl + OVERHANG, -hw - OVERHANG, lowY)
  const e01 = point(-hl - OVERHANG, hw + OVERHANG, lowY)
  const e11 = point(hl + OVERHANG, hw + OVERHANG, lowY)
  const run = Math.hypot(hw + OVERHANG, ridgeY - lowY) / ROOF_TILE_M
  const len = (2 * (hl + OVERHANG)) / ROOF_TILE_M
  const sOf = (q: THREE.Vector3) => ((q.x - e00.x) * ux + (q.z - e00.z) * uz) / ROOF_TILE_M
  const sides: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [e00, e10, v(-wx, 1, -wz)],
    [e11, e01, v(wx, 1, wz)],
  ]
  for (const [a, b, facing] of sides) {
    const ra = a === e00 ? r0 : r1
    const rb = a === e00 ? r1 : r0
    const tex: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2] = a === e00
      ? [uv(0, 0), uv(len, 0), uv(sOf(rb), run), uv(sOf(ra), run)]
      : [uv(len, 0), uv(0, 0), uv(sOf(rb), run), uv(sOf(ra), run)]
    roofs.quad(a, b, rb, ra, roofColor, facing, tex)
    roofs.quad(a, b, rb, ra, under, DOWN)
  }
  const ends: [boolean, THREE.Vector3, THREE.Vector3, THREE.Vector3, number, THREE.Vector3][] = [
    [hip0, e01, e00, r0, -hl, back],
    [hip1, e10, e11, r1, hl, along],
  ]
  for (const [hipped, a, b, r, s, out] of ends) {
    if (hipped) {
      const width = (2 * (hw + OVERHANG)) / ROOF_TILE_M
      roofs.triangle(a, b, r, roofColor, v(out.x, 1, out.z), [uv(0, 0), uv(width, 0), uv(width / 2, run)])
      roofs.triangle(a, b, r, under, DOWN)
    } else {
      // Gable triangle in the end wall.
      const m = modules(2 * hw)
      const vl = (eaveY - base) / floor
      const vh = (ridgeY - base) / floor
      walls.triangle(point(s, -hw, eaveY), point(s, hw, eaveY), point(s, 0, ridgeY), wallColor, out, [uv(0, vl), uv(m, vl), uv(m / 2, vh)])
    }
  }
}

/** Roof parts for a building without measured wings: one over its outline's box. */
function partsFromRoofType(b: BuildingRecord, outline: [number, number][]): RoofPartRecord[] {
  const [ux, uz] = b.ridge
  const wx = -uz
  const wz = ux
  let umin = Infinity
  let umax = -Infinity
  let wmin = Infinity
  let wmax = -Infinity
  for (const [x, z] of outline) {
    const u = x * ux + z * uz
    const w = x * wx + z * wz
    umin = Math.min(umin, u)
    umax = Math.max(umax, u)
    wmin = Math.min(wmin, w)
    wmax = Math.max(wmax, w)
  }
  const um = (umin + umax) / 2
  const wm = (wmin + wmax) / 2
  const part: RoofPartRecord = {
    type: b.roofType === 'hip' ? 'gable' : b.roofType,
    centre: [um * ux + wm * wx, um * uz + wm * wz],
    axis: [ux, uz],
    half: [(umax - umin) / 2, (wmax - wmin) / 2],
    eave: b.wall,
    ridge: b.wall + b.roof,
    hips: b.roofType === 'hip' ? [true, true] : [false, false],
  }
  return b.roofType === 'flat' ? [] : [part]
}

// Wall texture by kind of building.
type WallKind = 'wall' | 'boards' | 'logs' | 'cladding'
const WALL_KIND: Record<string, WallKind> = {
  house: 'wall',
  farmhouse: 'wall',
  church: 'wall',
  industry: 'cladding',
  other: 'wall',
  cabin: 'logs',
  summer_farm: 'logs',
  boathouse: 'boards',
  barn: 'boards',
  farm_auxiliary: 'boards',
  garage: 'boards',
  shed: 'boards',
}

/** The buildings as one group of meshes, and their outlines (scene x, z) for placing control flags. */
export async function loadBuildings(
  world: World,
  gfx: Gfx,
): Promise<{ group: THREE.Group; outlines: [number, number][][] } | null> {
  const info = world.manifest.buildings
  if (!info) return null
  const response = await fetch(world.url(info.path))
  if (!response.ok) return null
  const records = (await response.json()) as BuildingRecord[]

  const walls: Record<WallKind, MeshBuilder> = {
    wall: new MeshBuilder(),
    boards: new MeshBuilder(),
    logs: new MeshBuilder(),
    cladding: new MeshBuilder(),
  }
  const roofs = new MeshBuilder()
  for (const b of records) {
    const outline = counterClockwise(b.outline)
    const wallColor = new THREE.Color(b.wallColor)
    const roofColor = new THREE.Color(b.roofColor)
    const wallTop = b.base + b.wall
    const mb = walls[WALL_KIND[b.kind] ?? 'wall']
    // Window rows: one per floor, evenly up the wall.
    const floor = b.floors ? Math.max(b.wall / b.floors, 2.2) : FLOOR_M
    addWalls(mb, outline, b.base - FOUNDATION, wallTop, b.base, floor, wallColor)
    // A flat roof over the whole outline closes whatever the parts do not cover.
    addFlatCap(roofs, outline, wallTop, roofColor)
    const parts = b.parts?.length ? b.parts : partsFromRoofType(b, outline)
    for (const p of parts) addPart(mb, roofs, p, b.base, floor, wallTop, wallColor, roofColor)
  }

  const group = new THREE.Group()
  group.name = 'buildings'
  const t = gfx.textures
  const maps: [MeshBuilder, THREE.Texture][] = [
    [walls.wall, t.wall],
    [walls.boards, t.boards],
    [walls.logs, t.logs],
    [walls.cladding, t.cladding],
    [roofs, t.roof],
  ]
  for (const [builder, map] of maps) {
    if (builder.empty) continue
    const mesh = new THREE.Mesh(builder.build(), new THREE.MeshLambertMaterial({ map, vertexColors: true }))
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return { group, outlines: records.map(b => b.outline) }
}
