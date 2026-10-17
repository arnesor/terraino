import type * as THREE from 'three'

export type CoverKind = 'blueberry' | 'fern' | 'grass' | 'heather' | 'sedge' | 'dry'
export type GroundKind = 'forest' | 'grass' | 'soil' | 'gravel' | 'rock' | 'marsh' | 'field' | 'asphalt'

export interface Textures {
  bark: { spruce: THREE.Texture; pine: THREE.Texture; birch: THREE.Texture }
  foliage: { spruce: THREE.Texture; pine: THREE.Texture; birch: THREE.Texture; bush: THREE.Texture }
  cover: Record<CoverKind, THREE.Texture>
  ground: Record<GroundKind, THREE.Texture>
  canvases: Record<GroundKind, HTMLCanvasElement>
  wall: THREE.Texture
  roof: THREE.Texture
  cladding: THREE.Texture
  boards: THREE.Texture
  logs: THREE.Texture
}

export const OTex: {
  build(three: typeof THREE, renderer: THREE.WebGLRenderer): Textures
}
