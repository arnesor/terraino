import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Tree models are built for a tree of height 1 and crown radius 1; instances scale
// them by (crown radius, height, crown radius). Colours are in vertex colours.

export const SPRUCE = 1
export const PINE = 2
export const DECIDUOUS = 3
export const SPECIES = [SPRUCE, PINE, DECIDUOUS] as const
export type LodLevel = 0 | 1 | 2

const SPRUCE_BARK = new THREE.Color(0x4a3c30)
const PINE_BARK_LOW = new THREE.Color(0x5e4a3a)
const PINE_BARK_HIGH = new THREE.Color(0xb0683a)
const BIRCH_BARK = new THREE.Color(0xe2ded2)
const BIRCH_MARK = new THREE.Color(0x2a2622)
const SPRUCE_DARK = new THREE.Color(0x14301a)
const SPRUCE_TIP = new THREE.Color(0x2f5a2c)
const PINE_GREEN = new THREE.Color(0x2b4a26)
const BIRCH_GREEN = new THREE.Color(0x5c8a30)

/** Deterministic noise in [0, 1) so every tree of a kind looks the same. */
function noise(a: number, b: number, salt: number): number {
  const h = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453
  return h - Math.floor(h)
}

function finish(geometry: THREE.BufferGeometry, color: (p: THREE.Vector3, i: number) => THREE.Color): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  g.computeVertexNormals()
  const pos = g.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    const c = color(p, i)
    colors.set([c.r, c.g, c.b], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

function trunk(height: number, radius: number, segments: number, color: (y: number, i: number) => THREE.Color) {
  const g = new THREE.CylinderGeometry(radius * 0.55, radius, height, segments, 6, true)
  g.translate(0, height / 2, 0)
  return finish(g, (p, i) => color(p.y / height, i))
}

/** A layer of spruce branches: a drooping cone with a ragged rim. */
function branchLayer(base: number, top: number, radius: number, segments: number, seed: number) {
  const g = new THREE.ConeGeometry(radius, top - base, segments, 2, true)
  g.translate(0, base + (top - base) / 2, 0)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const r = Math.hypot(v.x, v.z)
    if (r > radius * 0.6) {
      // Ragged, drooping branch tips.
      const angle = Math.round(Math.atan2(v.z, v.x) * 10)
      const k = 0.8 + 0.4 * noise(angle, seed, 1)
      v.x *= k
      v.z *= k
      v.y -= (top - base) * 0.18 * noise(angle, seed, 2)
    }
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  return finish(g, p => {
    const r = Math.hypot(p.x, p.z) / radius
    return SPRUCE_DARK.clone().lerp(SPRUCE_TIP, Math.min(r * 1.1, 1))
  })
}

/** A clump of leaves or needles: a squashed, lumpy sphere. */
function clump(cx: number, cy: number, cz: number, rx: number, ry: number, color: THREE.Color, detail: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, detail)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const k = 0.82 + 0.3 * noise(Math.round(v.x * 7), Math.round(v.y * 7 + v.z * 5), seed)
    pos.setXYZ(i, v.x * rx * k + cx, v.y * ry * k + cy, v.z * rx * k + cz)
  }
  const light = color.clone().multiplyScalar(1.25)
  const dark = color.clone().multiplyScalar(0.6)
  return finish(g, p => dark.clone().lerp(light, THREE.MathUtils.clamp((p.y - cy) / (2 * ry) + 0.5, 0, 1)))
}

function spruce(lod: LodLevel): THREE.BufferGeometry {
  if (lod === 2) return mergeGeometries([branchLayer(0.12, 1, 0.72, 4, 1)])
  if (lod === 1) {
    return mergeGeometries([
      trunk(0.15, 0.05, 4, () => SPRUCE_BARK),
      branchLayer(0.14, 0.62, 0.72, 7, 1),
      branchLayer(0.45, 1, 0.48, 7, 2),
    ])
  }
  const parts = [trunk(0.35, 0.05, 6, () => SPRUCE_BARK)]
  const layers = 7
  for (let i = 0; i < layers; i++) {
    const f = i / layers
    // The lowest branches start a bit up the trunk and are the most shortened, so
    // the view under the trees stays open.
    const base = 0.13 + f * 0.75
    const top = Math.min(1, base + 0.3 - f * 0.08)
    parts.push(branchLayer(base, top, 0.72 - f * 0.58, 10, i + 1))
  }
  return mergeGeometries(parts)
}

function pine(lod: LodLevel): THREE.BufferGeometry {
  const bark = (y: number) => PINE_BARK_LOW.clone().lerp(PINE_BARK_HIGH, THREE.MathUtils.smoothstep(y, 0.25, 0.6))
  if (lod === 2) {
    return mergeGeometries([clump(0, 0.82, 0, 0.9, 0.2, PINE_GREEN, 0, 1), trunk(0.75, 0.05, 3, bark)])
  }
  if (lod === 1) {
    return mergeGeometries([
      trunk(0.8, 0.055, 5, bark),
      clump(0.15, 0.85, 0.05, 0.75, 0.17, PINE_GREEN, 0, 1),
      clump(-0.2, 0.78, -0.1, 0.6, 0.15, PINE_GREEN, 0, 2),
    ])
  }
  const parts = [trunk(0.86, 0.055, 7, bark)]
  const clumps: [number, number, number, number, number][] = [
    [0.25, 0.88, 0.1, 0.55, 0.13],
    [-0.3, 0.83, -0.12, 0.5, 0.13],
    [0.05, 0.95, -0.2, 0.42, 0.1],
    [-0.08, 0.76, 0.32, 0.45, 0.12],
    [0.4, 0.74, -0.25, 0.38, 0.11],
    [-0.42, 0.7, 0.18, 0.35, 0.1],
  ]
  clumps.forEach(([x, y, z, r, h], i) => parts.push(clump(x, y, z, r, h, PINE_GREEN, 1, i + 1)))
  return mergeGeometries(parts)
}

function deciduous(lod: LodLevel): THREE.BufferGeometry {
  const bark = (y: number, i: number) =>
    noise(Math.round(y * 20), i % 3, 3) < 0.18 ? BIRCH_MARK : BIRCH_BARK.clone().multiplyScalar(y < 0.08 ? 0.6 : 1)
  if (lod === 2) {
    return mergeGeometries([clump(0, 0.65, 0, 0.9, 0.36, BIRCH_GREEN, 0, 1), trunk(0.35, 0.05, 3, () => BIRCH_BARK)])
  }
  if (lod === 1) {
    return mergeGeometries([
      trunk(0.45, 0.05, 5, () => BIRCH_BARK),
      clump(0, 0.68, 0, 0.85, 0.34, BIRCH_GREEN, 0, 1),
      clump(0.15, 0.48, -0.1, 0.55, 0.2, BIRCH_GREEN, 0, 2),
    ])
  }
  const parts = [trunk(0.6, 0.05, 7, bark)]
  const clumps: [number, number, number, number, number][] = [
    [0, 0.82, 0, 0.5, 0.2],
    [0.35, 0.68, 0.1, 0.45, 0.22],
    [-0.32, 0.7, -0.15, 0.45, 0.22],
    [0.1, 0.62, -0.38, 0.42, 0.2],
    [-0.12, 0.58, 0.36, 0.42, 0.2],
    [0.25, 0.48, 0.3, 0.35, 0.16],
    [-0.3, 0.46, 0.05, 0.33, 0.15],
    [0.05, 0.94, 0.1, 0.3, 0.1],
  ]
  clumps.forEach(([x, y, z, r, h], i) => parts.push(clump(x, y, z, r, h, BIRCH_GREEN, 1, i + 1)))
  return mergeGeometries(parts)
}

const cache = new Map<string, THREE.BufferGeometry>()

/** Shared geometry for a species at a level of detail. */
export function treeGeometry(species: number, lod: LodLevel): THREE.BufferGeometry {
  const key = `${species}:${lod}`
  let g = cache.get(key)
  if (!g) {
    g = species === PINE ? pine(lod) : species === DECIDUOUS ? deciduous(lod) : spruce(lod)
    g.computeBoundingSphere()
    cache.set(key, g)
  }
  return g
}

/** Low bush made of a few clumps, for undergrowth. */
export function bushGeometry(): THREE.BufferGeometry {
  const key = 'bush'
  let g = cache.get(key)
  if (!g) {
    const green = new THREE.Color(0x3a5c2c)
    g = mergeGeometries([
      clump(0, 0.45, 0, 0.6, 0.45, green, 1, 1),
      clump(0.35, 0.3, 0.2, 0.4, 0.3, green, 0, 2),
      clump(-0.3, 0.32, -0.15, 0.45, 0.32, green, 0, 3),
    ])
    cache.set(key, g)
  }
  return g
}

/** A tuft of grass blades: three thin triangles, visible from both sides. */
export function tuftGeometry(): THREE.BufferGeometry {
  const key = 'tuft'
  let g = cache.get(key)
  if (!g) {
    const positions: number[] = []
    const colors: number[] = []
    const base = new THREE.Color(0x6a7a3a)
    const tip = new THREE.Color(0xc4c27a)
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI
      const dx = Math.cos(a) * 0.12
      const dz = Math.sin(a) * 0.12
      const lean = 0.15 * (i - 1)
      // Both windings, so each blade is seen from both sides with upward normals.
      positions.push(-dx, 0, -dz, dx, 0, dz, lean, 1, lean * 0.5)
      positions.push(dx, 0, dz, -dx, 0, -dz, lean, 1, lean * 0.5)
      for (let k = 0; k < 2; k++) colors.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b)
    }
    g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    // Grass is lit like the ground below it.
    const normals = new Float32Array(positions.length)
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    cache.set(key, g)
  }
  return g
}
