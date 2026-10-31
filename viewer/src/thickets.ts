import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Models, TreeModel } from './vendor/models.js'

// Thickets: dense clumps of young trees or brush, about 4 m tall, that block the view in
// the map's green areas. Each is built from copies of the tree and bush models, packed
// close enough that little light shows through at eye height. Like the trees, the models
// are built at unit height and scaled per instance.

/** Crown radius of the thicket models at height 1; the impostors show ±0.26. */
export const THICKET_CROWN = 0.22
// The models reach at most this far from the centre.
const MAX_HALF_W = 0.25

/** Deterministic random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

/** A copy of `g` turned by `turn`, scaled by (w, h, w) and moved to (x, y, z). */
function copy(g: THREE.BufferGeometry, x: number, y: number, z: number, w: number, h: number, turn: number) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn),
    new THREE.Vector3(w, h, w),
  )
  return g.clone().applyMatrix4(m)
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts)
  if (!merged) throw new Error('thicket parts do not match')
  for (const p of parts) p.dispose()
  merged.computeBoundingSphere()
  return merged
}

/** Narrow the model, if needed, to fit within ±MAX_HALF_W across. */
function fit(model: TreeModel): TreeModel {
  const box = new THREE.Box3()
  for (const g of [model.trunk, model.foliage]) {
    box.union(new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute))
  }
  const reach = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z)
  if (reach > MAX_HALF_W) {
    const m = new THREE.Matrix4().makeScale(MAX_HALF_W / reach, 1, MAX_HALF_W / reach)
    for (const g of [model.trunk, model.foliage]) g.applyMatrix4(m).computeBoundingSphere()
  }
  return model
}

/** Positions within `radius` of the centre, spread evenly by the golden angle. */
function spots(n: number, radius: number, R: () => number): [number, number][] {
  const turn = R() * Math.PI * 2
  return Array.from({ length: n }, (_, i) => {
    const r = radius * Math.sqrt((i + 0.5) / n) * (0.8 + 0.4 * R())
    const a = turn + i * 2.39996
    return [Math.cos(a) * r, Math.sin(a) * r]
  })
}

/** Young spruce packed together, with branches to the ground: a tall one in the middle. */
export function spruceThicket(models: Models, seed = 1): TreeModel {
  const R = rng(seed)
  const tree = models.spruce[0]!
  const trunks: THREE.BufferGeometry[] = []
  const foliage: THREE.BufferGeometry[] = []
  const add = (x: number, z: number, h: number) => {
    const turn = R() * Math.PI * 2
    trunks.push(copy(tree.trunk, x, 0, z, h, h, turn))
    foliage.push(copy(tree.foliage, x, 0, z, h, h, turn))
  }
  add(0, 0, 1)
  for (const [x, z] of spots(8, 0.07, R)) add(x, z, 0.5 + 0.3 * R())
  return fit({ trunk: merge(trunks), foliage: merge(foliage) })
}

/** Deciduous brush: a few birch stems over a dense mass of bush to the ground. */
export function deciduousThicket(models: Models, seed = 2): TreeModel {
  const R = rng(seed)
  const tree = models.birch[0]!
  const bush = models.bush[0]!.foliage
  const trunks: THREE.BufferGeometry[] = []
  const foliage: THREE.BufferGeometry[] = []
  for (const [x, z] of spots(5, 0.06, R)) {
    const h = 0.75 + 0.25 * R()
    const turn = R() * Math.PI * 2
    trunks.push(copy(tree.trunk, x, 0, z, h * 1.05, h, turn))
    foliage.push(copy(tree.foliage, x, 0, z, h * 1.05, h, turn))
  }
  // Bush (about 1 m wide and tall at scale 1) in layers from the ground to the crowns.
  for (const [y, n, w, radius] of [
    [0, 7, 0.18, 0.09],
    [0.22, 6, 0.17, 0.08],
    [0.42, 4, 0.15, 0.06],
  ] as const) {
    for (const [x, z] of spots(n, radius, R)) {
      foliage.push(copy(bush, x, y - 0.04, z, w * (0.85 + 0.3 * R()), w * 1.1, R() * Math.PI * 2))
    }
  }
  return fit({ trunk: merge(trunks), foliage: merge(foliage) })
}
