import * as THREE from 'three'
import type { Gfx } from './gfx'
import type { HeightField } from './heightfield'
import type { World } from './world'

/** A road bridge in bridges.json (see the docstring of terraino.export). */
export interface BridgeRecord {
  kind: string
  /** Width of the track on the deck; the deck is wider by its rails. */
  width: number
  /** Running speed factor on the deck. */
  speed: number
  /** Centre line: scene x, z and the height of the road surface. */
  points: [number, number, number][]
  /** Distances (m) along the centre line of the pillars. */
  pillars: number[]
}

/** Guard rails stand this far outside the road's edge (terraino.process.bridges.RAIL_M). */
export const RAIL_M = 0.5
/** Thickness of the deck slab. */
export const SLAB_M = 0.8
const RAIL_TOP = 0.8
const RAIL_BOTTOM = 0.5
const POST_SPACING = 2
const PILLAR_THICKNESS = 0.8
const END_WALL_THICKNESS = 0.5
const CONCRETE = new THREE.Color(0.78, 0.77, 0.74)
// The concrete texture covers this many metres, with a formwork seam every metre.
const CONCRETE_TILE_M = 4
const STEEL = new THREE.Color(0.66, 0.68, 0.7)

/** Where a position is relative to a deck's centre line. */
export interface DeckPoint {
  /** Distance along the centre line (may be outside the deck, before 0 or past its length). */
  along: number
  /** Distance to the left of the centre line (scene x to the right of travel is negative). */
  across: number
  /** Height of the road surface there. */
  height: number
  /** The nearest point on the centre line and the unit normal to its left. */
  x: number
  z: number
  nx: number
  nz: number
}

/** One bridge deck: a straight-sloped road surface along a centre line, with rails. */
export class Deck {
  readonly record: BridgeRecord
  readonly half: number
  readonly length: number
  private readonly cumulative: number[]
  private readonly box: [number, number, number, number]

  constructor(record: BridgeRecord) {
    this.record = record
    this.half = record.width / 2 + RAIL_M
    this.cumulative = [0]
    const p = record.points
    for (let i = 1; i < p.length; i++) {
      this.cumulative.push(this.cumulative[i - 1]! + Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]))
    }
    this.length = this.cumulative[this.cumulative.length - 1]!
    const xs = p.map(q => q[0])
    const zs = p.map(q => q[1])
    const pad = this.half + 1
    this.box = [Math.min(...xs) - pad, Math.min(...zs) - pad, Math.max(...xs) + pad, Math.max(...zs) + pad]
  }

  /** True if (x, z) is near enough the deck to be worth locating. */
  near(x: number, z: number): boolean {
    const [x0, z0, x1, z1] = this.box
    return x >= x0 && x <= x1 && z >= z0 && z <= z1
  }

  /** Where (x, z) is relative to the centre line (its nearest point, ends extended). */
  locate(x: number, z: number): DeckPoint {
    const p = this.record.points
    let best: DeckPoint | null = null
    let bestDistance = Infinity
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i]!
      const [x1, z1] = p[i + 1]!
      const dx = x1 - x0
      const dz = z1 - z0
      const len = Math.hypot(dx, dz) || 1e-9
      const ux = dx / len
      const uz = dz / len
      let t = (x - x0) * ux + (z - z0) * uz
      // The first and last segments reach on past the ends.
      if (i > 0) t = Math.max(t, 0)
      if (i + 2 < p.length) t = Math.min(t, len)
      const cx = x0 + ux * t
      const cz = z0 + uz * t
      const distance = Math.hypot(x - cx, z - cz)
      if (distance < bestDistance) {
        bestDistance = distance
        // Left of travel: (uz, -ux) with scene z pointing south.
        const nx = uz
        const nz = -ux
        best = { along: this.cumulative[i]! + t, across: (x - cx) * nx + (z - cz) * nz, height: 0, x: cx, z: cz, nx, nz }
      }
    }
    const point = best!
    point.height = this.heightAlong(point.along)
    return point
  }

  /** Height of the road surface at a distance along the deck (straight between the ends). */
  heightAlong(along: number): number {
    const p = this.record.points
    const first = p[0]![2]
    const last = p[p.length - 1]![2]
    if (this.length <= 0) return first
    return first + ((last - first) * along) / this.length
  }

  /** Height of the deck at (x, z), or null if (x, z) is not on it. */
  heightAt(x: number, z: number): number | null {
    if (!this.near(x, z)) return null
    const q = this.locate(x, z)
    if (q.along < 0 || q.along > this.length || Math.abs(q.across) > this.half) return null
    return q.height
  }
}

/** Road bridges: decks to run on, with rails, end walls and pillars to run past. */
export class Bridges {
  readonly group = new THREE.Group()
  readonly decks: Deck[]

  constructor(records: BridgeRecord[]) {
    this.group.name = 'bridges'
    this.decks = records.filter(r => r.points.length >= 2).map(r => new Deck(r))
  }

  static async load(world: World): Promise<Bridges | null> {
    const info = world.manifest.bridges
    if (!info) return null
    const response = await fetch(world.url(info.path))
    if (!response.ok) return null
    return new Bridges((await response.json()) as BridgeRecord[])
  }

  /** The deck at (x, z) and its height there, or null. */
  private deckAt(x: number, z: number): { deck: Deck; height: number } | null {
    for (const deck of this.decks) {
      const height = deck.heightAt(x, z)
      if (height !== null) return { deck, height }
    }
    return null
  }

  /** Height of a deck's road surface at (x, z), or null. */
  heightAt(x: number, z: number): number | null {
    return this.deckAt(x, z)?.height ?? null
  }

  /** Running speed on a deck at (x, z), or null if there is none. */
  speedAt(x: number, z: number): number | null {
    return this.deckAt(x, z)?.deck.record.speed ?? null
  }

  /** Keep a body of `radius` on a deck between its rails; it leaves only at the ends. */
  collideOnDeck(x: number, z: number, radius: number): [number, number] {
    for (const deck of this.decks) {
      if (!deck.near(x, z)) continue
      const q = deck.locate(x, z)
      if (q.along < 0 || q.along > deck.length) continue
      // Just past the rails counts as on the deck, so a step cannot slip through them.
      if (Math.abs(q.across) > deck.half + radius + 0.5) continue
      const limit = deck.half - 0.1 - radius
      if (Math.abs(q.across) <= limit) return [x, z]
      const across = Math.sign(q.across) * limit
      return [q.x + q.nx * across, q.z + q.nz * across]
    }
    return [x, z]
  }

  /** Push a body of `radius` on the ground out of the pillars. */
  collideBelow(x: number, z: number, radius: number): [number, number] {
    for (const deck of this.decks) {
      if (!deck.near(x, z) || !deck.record.pillars.length) continue
      const q = deck.locate(x, z)
      const halfAcross = deck.half - 0.6 + radius
      if (Math.abs(q.across) > halfAcross) continue
      for (const at of deck.record.pillars) {
        const along = q.along - at
        const halfAlong = PILLAR_THICKNESS / 2 + radius
        if (Math.abs(along) > halfAlong) continue
        // Out along the deck or across it, whichever is nearer.
        const outAlong = halfAlong - Math.abs(along)
        const outAcross = halfAcross - Math.abs(q.across)
        const { ux, uz } = { ux: -q.nz, uz: q.nx }
        if (outAlong < outAcross) {
          const s = Math.sign(along) || 1
          return [x + ux * s * outAlong, z + uz * s * outAlong]
        }
        const s = Math.sign(q.across) || 1
        return [x + q.nx * s * outAcross, z + q.nz * s * outAcross]
      }
    }
    return [x, z]
  }

  /** Both ends of every deck, where the roads leading onto them stop. */
  ends(): [number, number][] {
    return this.decks.flatMap(d => {
      const p = d.record.points
      return [
        [p[0]![0], p[0]![1]],
        [p[p.length - 1]![0], p[p.length - 1]![1]],
      ] as [number, number][]
    })
  }

  /** Build the slabs, rails, end walls and pillars. */
  buildMeshes(heights: HeightField, gfx: Gfx) {
    const concrete = new THREE.MeshLambertMaterial({ color: CONCRETE, map: concreteTexture(gfx), side: THREE.DoubleSide })
    const steel = new THREE.MeshLambertMaterial({ color: STEEL, side: THREE.DoubleSide })
    for (const deck of this.decks) {
      const slab = new THREE.Mesh(slabGeometry(deck), concrete)
      const rails = new THREE.Mesh(railGeometry(deck), steel)
      for (const mesh of [slab, rails]) {
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
      for (const part of supports(deck, heights)) {
        const mesh = new THREE.Mesh(part, concrete)
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
    }
  }
}

/** Stations along a deck: centre, height and the mitred normal to the left. */
function stations(deck: Deck): { x: number; z: number; y: number; nx: number; nz: number; along: number }[] {
  const p = deck.record.points
  let along = 0
  return p.map((q, i) => {
    if (i > 0) along += Math.hypot(q[0] - p[i - 1]![0], q[1] - p[i - 1]![1])
    const a = p[Math.max(i - 1, 0)]!
    const b = p[Math.min(i + 1, p.length - 1)]!
    const normal = (u: number[], v: number[]) => {
      const dx = v[0]! - u[0]!
      const dz = v[1]! - u[1]!
      const len = Math.hypot(dx, dz) || 1
      return [dz / len, -dx / len]
    }
    const n1 = normal(a, q)
    const n2 = normal(q, b)
    const first = i === 0 ? n2 : n1
    const second = i === p.length - 1 ? n1 : n2
    let nx = first[0]! + second[0]!
    let nz = first[1]! + second[1]!
    const len = Math.hypot(nx, nz) || 1
    nx /= len
    nz /= len
    const cos = Math.max(nx * first[0]! + nz * first[1]!, 0.5)
    return { x: q[0], z: q[1], y: deck.heightAlong(along), nx: nx / cos, nz: nz / cos, along }
  })
}

/** A geometry from quads given as four corners each. */
function quads(list: THREE.Vector3[][]): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const edge = new THREE.Vector3()
  const side = new THREE.Vector3()
  const normal = new THREE.Vector3()
  for (const [a, b, c, d] of list) {
    edge.subVectors(b!, a!)
    side.subVectors(d!, a!)
    normal.crossVectors(edge, side)
    // Upright faces: across along the face, up the height; level faces: from above.
    const upright = Math.abs(normal.y) < 0.5 * normal.length()
    const along = upright ? (Math.hypot(edge.x, edge.z) > 1e-6 ? edge : new THREE.Vector3().subVectors(c!, b!)) : null
    const lx = along ? along.x / (Math.hypot(along.x, along.z) || 1) : 0
    const lz = along ? along.z / (Math.hypot(along.x, along.z) || 1) : 0
    for (const v of [a!, b!, c!, a!, c!, d!]) {
      positions.push(v.x, v.y, v.z)
      // The texture covers CONCRETE_TILE_M square.
      if (upright) uvs.push((v.x * lx + v.z * lz) / CONCRETE_TILE_M, v.y / CONCRETE_TILE_M)
      else uvs.push(v.x / CONCRETE_TILE_M, v.z / CONCRETE_TILE_M)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/** The slab: top under the road strip, sides, underside and ends. */
function slabGeometry(deck: Deck): THREE.BufferGeometry {
  const s = stations(deck)
  const h = deck.half
  const corner = (k: number, side: number, down: number) =>
    new THREE.Vector3(s[k]!.x + s[k]!.nx * h * side, s[k]!.y - down, s[k]!.z + s[k]!.nz * h * side)
  const list: THREE.Vector3[][] = []
  for (let k = 0; k + 1 < s.length; k++) {
    list.push([corner(k, 1, 0), corner(k, -1, 0), corner(k + 1, -1, 0), corner(k + 1, 1, 0)])
    list.push([corner(k, 1, SLAB_M), corner(k, -1, SLAB_M), corner(k + 1, -1, SLAB_M), corner(k + 1, 1, SLAB_M)])
    for (const side of [1, -1]) {
      list.push([corner(k, side, 0), corner(k + 1, side, 0), corner(k + 1, side, SLAB_M), corner(k, side, SLAB_M)])
    }
  }
  for (const k of [0, s.length - 1]) {
    list.push([corner(k, 1, 0), corner(k, -1, 0), corner(k, -1, SLAB_M), corner(k, 1, SLAB_M)])
  }
  return quads(list)
}

/** Guard rails on both sides: a steel band on posts. */
function railGeometry(deck: Deck): THREE.BufferGeometry {
  const s = stations(deck)
  const offset = deck.half - 0.12
  const at = (k: number, side: number, up: number) =>
    new THREE.Vector3(s[k]!.x + s[k]!.nx * offset * side, s[k]!.y + up, s[k]!.z + s[k]!.nz * offset * side)
  const list: THREE.Vector3[][] = []
  for (const side of [1, -1]) {
    for (let k = 0; k + 1 < s.length; k++) {
      list.push([at(k, side, RAIL_BOTTOM), at(k + 1, side, RAIL_BOTTOM), at(k + 1, side, RAIL_TOP), at(k, side, RAIL_TOP)])
    }
    for (let along = 0.2; along < deck.length; along += POST_SPACING) {
      const q = deck.locate(...pointAlong(s, along))
      const post = deck.half - 0.08
      const cx = q.x + q.nx * post * side
      const cz = q.z + q.nz * post * side
      list.push(...box(cx, cz, q.height, q.height + RAIL_TOP, 0.06, 0.06, -q.nz, q.nx))
    }
  }
  return quads(list)
}

function pointAlong(s: ReturnType<typeof stations>, along: number): [number, number] {
  for (let k = 0; k + 1 < s.length; k++) {
    const a = s[k]!
    const b = s[k + 1]!
    if (along <= b.along || k + 2 === s.length) {
      const t = (along - a.along) / (b.along - a.along || 1)
      return [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t]
    }
  }
  return [s[0]!.x, s[0]!.z]
}

/** The faces of an upright box centred on (x, z), half sizes along (ux, uz) and across it. */
function box(
  x: number,
  z: number,
  bottom: number,
  top: number,
  halfAlong: number,
  halfAcross: number,
  ux: number,
  uz: number,
): THREE.Vector3[][] {
  const nx = uz
  const nz = -ux
  const c = (a: number, b: number, y: number) =>
    new THREE.Vector3(x + ux * a * halfAlong + nx * b * halfAcross, y, z + uz * a * halfAlong + nz * b * halfAcross)
  const ring: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]
  const faces: THREE.Vector3[][] = []
  for (let k = 0; k < 4; k++) {
    const [a0, b0] = ring[k]!
    const [a1, b1] = ring[(k + 1) % 4]!
    faces.push([c(a0, b0, bottom), c(a1, b1, bottom), c(a1, b1, top), c(a0, b0, top)])
  }
  faces.push(ring.map(([a, b]) => c(a, b, top)))
  return faces
}

/** End walls under each end of the deck, and the pillars, down into the ground. */
function supports(deck: Deck, heights: HeightField): THREE.BufferGeometry[] {
  const s = stations(deck)
  const parts: THREE.BufferGeometry[] = []
  const ends: [number, number][] = [
    [0, 1],
    [s.length - 1, -1],
  ]
  for (const [k, inward] of ends) {
    const q = s[k]!
    // Direction into the deck.
    const ux = -q.nz * inward
    const uz = q.nx * inward
    const len = Math.hypot(ux, uz) || 1
    const at = deck.length * (k === 0 ? 0 : 1) + (END_WALL_THICKNESS / 2) * inward
    const cx = q.x + (ux / len) * (END_WALL_THICKNESS / 2)
    const cz = q.z + (uz / len) * (END_WALL_THICKNESS / 2)
    let ground = Infinity
    for (let a = 0; a <= 3; a += 1) {
      for (let b = -1; b <= 1; b += 0.5) {
        ground = Math.min(ground, heights.heightAt(q.x + (ux / len) * a + q.nx * deck.half * b, q.z + (uz / len) * a + q.nz * deck.half * b))
      }
    }
    const top = deck.heightAlong(at) - SLAB_M
    if (top - ground < 0.2) continue
    parts.push(quads(box(cx, cz, ground - 0.3, top, END_WALL_THICKNESS / 2, deck.half + 0.2, ux / len, uz / len)))
  }
  for (const along of deck.record.pillars) {
    const q = deck.locate(...pointAlong(s, along))
    const ground = heights.heightAt(q.x, q.z)
    const top = q.height - SLAB_M
    if (top - ground < 0.2) continue
    parts.push(quads(box(q.x, q.z, ground - 0.5, top, PILLAR_THICKNESS / 2, deck.half - 0.6, -q.nz, q.nx)))
  }
  return parts
}

/** Cast concrete: fine grain, faint seams of the formwork boards, and some stains. */
function concreteTexture(gfx: Gfx): THREE.Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  let seed = 12345
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  // Soft stains: a few blurred blobs, darker and lighter.
  const stains = Array.from({ length: 14 }, () => ({ x: random() * size, y: random() * size, r: 12 + random() * 40, k: (random() - 0.5) * 0.12 }))
  const boards = size / CONCRETE_TILE_M
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0.92 + (random() - 0.5) * 0.08
      for (const s of stains) {
        const dx = Math.min(Math.abs(x - s.x), size - Math.abs(x - s.x))
        const dy = Math.min(Math.abs(y - s.y), size - Math.abs(y - s.y))
        v += s.k * Math.exp(-(dx * dx + dy * dy) / (s.r * s.r))
      }
      // A thin dark seam between formwork boards.
      if (y % boards < 2) v -= 0.07
      const i = (y * size + x) * 4
      const c = Math.round(255 * Math.min(1, Math.max(0, v)))
      image.data[i] = image.data[i + 1] = image.data[i + 2] = c
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = gfx.textures.wall.anisotropy
  return texture
}
