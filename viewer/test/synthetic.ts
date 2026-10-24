// A small synthetic world for unit tests: heights from a function, served by a stubbed fetch.
import * as THREE from 'three'
import type { Gfx } from '../src/gfx'
import { HeightField } from '../src/heightfield'
import { ChunkLayer, Ground } from '../src/layers'
import { OModels } from '../src/vendor/models.js'
import { type LayerInfo, type Manifest, World } from '../src/world'

export const CHUNK = 256
const SCALE = 0.01

export const LAYER_INFO: LayerInfo = {
  path: 'layers/{x}_{y}.png',
  size: CHUNK + 1,
  overview: 'layers_overview.png',
  overviewStep: 4,
  canopyUnit: 0.1,
  levels: 15,
  ground: {},
}

/** A world of chunksX by chunksY height chunks, with heights f(col, row) in metres. */
export async function syntheticWorld(
  chunksX: number,
  chunksY: number,
  f: (col: number, row: number) => number = () => 100,
): Promise<{ world: World; heights: HeightField }> {
  const manifest = {
    format: 3,
    name: 'synthetic',
    extent: [0, 0, chunksX * CHUNK, chunksY * CHUNK],
    height: {
      origin: [0, chunksY * CHUNK],
      step: 1,
      cols: chunksX * CHUNK + 1,
      rows: chunksY * CHUNK + 1,
      chunk: CHUNK,
      chunksX,
      chunksY,
      encoding: 'uint16le',
      offset: 0,
      scale: SCALE,
      min: 0,
      max: 655,
      path: 'height/{x}_{y}.bin',
    },
    drape: { path: 'drape/{x}_{y}.jpg', tilePx: 256, overview: 'drape.jpg' },
    layers: LAYER_INFO,
  } as unknown as Manifest
  const world = new World('/worlds/synthetic/', manifest)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const match = /height\/(\d+)_(\d+)\.bin$/.exec(url)
    if (!match) return new Response(null, { status: 404 })
    const cx = Number(match[1])
    const cy = Number(match[2])
    const raw = new Uint16Array((CHUNK + 1) ** 2)
    for (let r = 0; r <= CHUNK; r++) {
      for (let c = 0; c <= CHUNK; c++) raw[r * (CHUNK + 1) + c] = Math.round(f(cx * CHUNK + c, cy * CHUNK + r) / SCALE)
    }
    return new Response(raw.buffer)
  }) as typeof fetch
  try {
    return { world, heights: await HeightField.load(world, () => {}) }
  } finally {
    globalThis.fetch = realFetch
  }
}

/** A chunk layer with the same ground class, canopy (m) and shrubs (0..1) everywhere. */
export function uniformLayer(ground: number = Ground.forest, canopy = 10, shrubs = 0.5): ChunkLayer {
  const size = CHUNK + 1
  const pixels = new Uint8ClampedArray(size * size * 4)
  const b = (Math.round(shrubs * LAYER_INFO.levels) << 4) | LAYER_INFO.levels
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = ground
    pixels[i + 1] = Math.round(canopy / LAYER_INFO.canopyUnit)
    pixels[i + 2] = b
    pixels[i + 3] = 255
  }
  return new ChunkLayer(pixels, size, new THREE.Texture(), LAYER_INFO)
}

/** What the content classes take from Gfx; textures and shaders only matter on a GPU. */
export function stubGfx(): Gfx {
  const texture = new THREE.Texture()
  const material = () => new THREE.MeshLambertMaterial()
  return {
    models: OModels.build(THREE),
    textures: new Proxy({}, { get: () => new Proxy({}, { get: () => texture }) }),
    groundArray: texture,
    time: { value: 0 },
    bush: material(),
    bushDepth: new THREE.MeshDepthMaterial(),
    logBark: material(),
    coverMaterial: () => material(),
  } as unknown as Gfx
}
