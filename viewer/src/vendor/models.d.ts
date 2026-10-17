import type * as THREE from 'three'

export interface TreeModel {
  trunk: THREE.BufferGeometry
  foliage: THREE.BufferGeometry
}

export interface Models {
  /** Open-grown, in a stand, and in a dense mature stand. */
  spruce: TreeModel[]
  pine: TreeModel[]
  birch: TreeModel[]
  bush: { foliage: THREE.BufferGeometry }[]
  rocks: THREE.BufferGeometry[]
  root: THREE.BufferGeometry[]
  twig: THREE.BufferGeometry[]
  card: THREE.BufferGeometry
  log: THREE.BufferGeometry
  tube: unknown
}

export const OModels: {
  build(three: typeof THREE): Models
}
