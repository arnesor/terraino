import * as THREE from 'three'
import type { World } from './world'

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
}

const OVERHANG = 0.4
// Walls continue this far below the lowest ground point, for buildings on slopes.
const FOUNDATION = 1.0

const e1 = new THREE.Vector3()
const e2 = new THREE.Vector3()

/** Collects triangles with per-vertex colours; normals are computed per face. */
class MeshBuilder {
  readonly positions: number[] = []
  readonly colors: number[] = []

  /** Add a triangle, wound so that its front faces along `facing`. */
  triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, facing: THREE.Vector3) {
    const normal = e1.subVectors(b, a).cross(e2.subVectors(c, a))
    if (normal.dot(facing) < 0) [b, c] = [c, b]
    this.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    for (let i = 0; i < 3; i++) this.colors.push(color.r, color.g, color.b)
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, facing: THREE.Vector3) {
    this.triangle(a, b, c, color, facing)
    this.triangle(a, c, d, color, facing)
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    return geometry
  }
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
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

function addWalls(mb: MeshBuilder, outline: [number, number][], bottom: number, top: number, color: THREE.Color) {
  for (let i = 0; i < outline.length; i++) {
    const [x0, z0] = outline[i]!
    const [x1, z1] = outline[(i + 1) % outline.length]!
    // Counter-clockwise outline: the outside is to the right when walking along it.
    const out = v(-(z1 - z0), 0, x1 - x0)
    mb.quad(v(x0, bottom, z0), v(x1, bottom, z1), v(x1, top, z1), v(x0, top, z0), color, out)
  }
}

function addFlatRoof(mb: MeshBuilder, outline: [number, number][], top: number, color: THREE.Color) {
  const contour = outline.map(([x, z]) => new THREE.Vector2(x, -z))
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, []) as [number, number, number][]) {
    const pa = outline[a]!
    const pb = outline[b]!
    const pc = outline[c]!
    mb.triangle(v(pa[0], top, pa[1]), v(pb[0], top, pb[1]), v(pc[0], top, pc[1]), color, UP)
  }
}

function addGableRoof(mb: MeshBuilder, b: BuildingRecord, outline: [number, number][], wallTop: number, roofColor: THREE.Color, wallColor: THREE.Color) {
  // Axes: u along the ridge, w across it.
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
  const wmid = (wmin + wmax) / 2
  const point = (u: number, w: number, y: number) => v(u * ux + w * wx, y, u * uz + w * wz)
  const ridgeY = wallTop + b.roof
  // Overhang: the roof plane continues past the walls, dropping with the same slope.
  const slope = b.roof / Math.max((wmax - wmin) / 2, 0.1)
  const eaveY = wallTop - OVERHANG * slope
  const u0 = umin - OVERHANG
  const u1 = umax + OVERHANG
  const w0 = wmin - OVERHANG
  const w1 = wmax + OVERHANG

  const r0 = point(u0, wmid, ridgeY)
  const r1 = point(u1, wmid, ridgeY)
  const e00 = point(u0, w0, eaveY)
  const e10 = point(u1, w0, eaveY)
  const e01 = point(u0, w1, eaveY)
  const e11 = point(u1, w1, eaveY)
  // Two roof planes facing up and out, plus darker undersides for the overhang.
  const outW0 = v(-wx, 1, -wz)
  const outW1 = v(wx, 1, wz)
  mb.quad(e00, e10, r1, r0, roofColor, outW0)
  mb.quad(e11, e01, r0, r1, roofColor, outW1)
  const under = roofColor.clone().multiplyScalar(0.5)
  mb.quad(r0, r1, e10, e00, under, DOWN)
  mb.quad(r1, r0, e01, e11, under, DOWN)

  // Gable triangles at both ends, in the wall plane.
  const g00 = point(umin, wmin, wallTop)
  const g01 = point(umin, wmax, wallTop)
  const gr0 = point(umin, wmid, ridgeY)
  const g10 = point(umax, wmin, wallTop)
  const g11 = point(umax, wmax, wallTop)
  const gr1 = point(umax, wmid, ridgeY)
  const alongU = v(ux, 0, uz)
  const againstU = v(-ux, 0, -uz)
  mb.triangle(g00, g01, gr0, wallColor, againstU)
  mb.triangle(g10, g11, gr1, wallColor, alongU)
}

/** The building's bounding box in roof axes: u along the ridge, w across it (to its right). */
function roofFrame(b: BuildingRecord, outline: [number, number][]) {
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
  const point = (u: number, w: number, y: number) => v(u * ux + w * wx, y, u * uz + w * wz)
  return { ux, uz, wx, wz, umin, umax, wmin, wmax, point }
}

/** Hipped roof: four planes of the same pitch, up to a shorter ridge (or a point). */
function addHipRoof(mb: MeshBuilder, b: BuildingRecord, outline: [number, number][], wallTop: number, roofColor: THREE.Color) {
  const { ux, uz, wx, wz, umin, umax, wmin, wmax, point } = roofFrame(b, outline)
  const umid = (umin + umax) / 2
  const wmid = (wmin + wmax) / 2
  const hw = Math.max((wmax - wmin) / 2, 0.1)
  const half = Math.max((umax - umin) / 2 - hw, 0) // half the ridge length
  const ridgeY = wallTop + b.roof
  const slope = b.roof / hw
  const eaveY = wallTop - OVERHANG * slope
  const e00 = point(umin - OVERHANG, wmin - OVERHANG, eaveY)
  const e10 = point(umax + OVERHANG, wmin - OVERHANG, eaveY)
  const e01 = point(umin - OVERHANG, wmax + OVERHANG, eaveY)
  const e11 = point(umax + OVERHANG, wmax + OVERHANG, eaveY)
  const r0 = point(umid - half, wmid, ridgeY)
  const r1 = point(umid + half, wmid, ridgeY)
  const under = roofColor.clone().multiplyScalar(0.5)
  const faces: [THREE.Vector3[], THREE.Vector3][] = [
    [[e00, e10, r1, r0], v(-wx, 1, -wz)],
    [[e11, e01, r0, r1], v(wx, 1, wz)],
    [[e01, e00, r0], v(-ux, 1, -uz)],
    [[e10, e11, r1], v(ux, 1, uz)],
  ]
  for (const [p, facing] of faces) {
    if (p.length === 4 && half > 0.01) {
      mb.quad(p[0]!, p[1]!, p[2]!, p[3]!, roofColor, facing)
      mb.quad(p[0]!, p[1]!, p[2]!, p[3]!, under, DOWN)
    } else {
      mb.triangle(p[0]!, p[1]!, p[2]!, roofColor, facing)
      mb.triangle(p[0]!, p[1]!, p[2]!, under, DOWN)
    }
  }
}

/** Shed (pent) roof: one plane rising across the building; the walls below it close up. */
function addShedRoof(mb: MeshBuilder, b: BuildingRecord, outline: [number, number][], wallTop: number, roofColor: THREE.Color, wallColor: THREE.Color) {
  const { ux, uz, wx, wz, umin, umax, wmin, wmax, point } = roofFrame(b, outline)
  const highY = wallTop + b.roof
  const slope = b.roof / Math.max(wmax - wmin, 0.1)
  const p00 = point(umin - OVERHANG, wmin - OVERHANG, wallTop - OVERHANG * slope)
  const p10 = point(umax + OVERHANG, wmin - OVERHANG, wallTop - OVERHANG * slope)
  const p11 = point(umax + OVERHANG, wmax + OVERHANG, highY + OVERHANG * slope)
  const p01 = point(umin - OVERHANG, wmax + OVERHANG, highY + OVERHANG * slope)
  mb.quad(p00, p10, p11, p01, roofColor, UP)
  mb.quad(p00, p10, p11, p01, roofColor.clone().multiplyScalar(0.5), DOWN)
  // The high wall goes up to the roof, and the end walls get a triangle each.
  const lowA = point(umin, wmin, wallTop)
  const lowB = point(umax, wmin, wallTop)
  const highA = point(umin, wmax, wallTop)
  const highB = point(umax, wmax, wallTop)
  const topA = point(umin, wmax, highY)
  const topB = point(umax, wmax, highY)
  mb.quad(highA, highB, topB, topA, wallColor, v(wx, 0, wz))
  mb.triangle(lowA, highA, topA, wallColor, v(-ux, 0, -uz))
  mb.triangle(lowB, highB, topB, wallColor, v(ux, 0, uz))
}

export async function loadBuildings(world: World): Promise<THREE.Group | null> {
  const info = world.manifest.buildings
  if (!info) return null
  const response = await fetch(world.url(info.path))
  if (!response.ok) return null
  const records = (await response.json()) as BuildingRecord[]

  const walls = new MeshBuilder()
  const roofs = new MeshBuilder()
  for (const b of records) {
    const outline = counterClockwise(b.outline)
    const wallColor = new THREE.Color(b.wallColor)
    const roofColor = new THREE.Color(b.roofColor)
    const wallTop = b.base + b.wall
    addWalls(walls, outline, b.base - FOUNDATION, wallTop, wallColor)
    if (b.roofType === 'gable') {
      addGableRoof(roofs, b, outline, wallTop, roofColor, wallColor)
    } else if (b.roofType === 'hip') {
      addHipRoof(roofs, b, outline, wallTop, roofColor)
    } else if (b.roofType === 'shed') {
      addShedRoof(roofs, b, outline, wallTop, roofColor, wallColor)
    } else {
      addFlatRoof(roofs, outline, wallTop, roofColor)
    }
  }

  const group = new THREE.Group()
  group.name = 'buildings'
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })
  for (const builder of [walls, roofs]) {
    const mesh = new THREE.Mesh(builder.build(), material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}
