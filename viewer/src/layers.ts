import * as THREE from 'three'
import { asLayerTexture } from './groundMaterial'
import type { LayerInfo } from './world'
import type { World } from './world'

/** Ground classes, as in terraino.process.symbols.Ground. */
export const Ground = {
  unknown: 0,
  forest: 1,
  open: 2,
  rough: 3,
  marsh: 4,
  rock: 5,
  field: 6,
  paved: 7,
  gravel: 8,
  path: 9,
  water: 10,
  lawn: 11,
  stony: 12,
  sand: 13,
  building: 14,
  grain: 15,
} as const

export interface LayerSample {
  ground: number
  canopy: number
  shrubs: number
  speed: number
}

/** Decoded layer data of one chunk: RGBA pixels and a GPU texture. */
export class ChunkLayer {
  readonly pixels: Uint8ClampedArray
  readonly size: number
  readonly texture: THREE.Texture
  private readonly info: LayerInfo

  constructor(pixels: Uint8ClampedArray, size: number, texture: THREE.Texture, info: LayerInfo) {
    this.pixels = pixels
    this.size = size
    this.texture = texture
    this.info = info
  }

  /** Layer values at chunk-local sample position (x, z), nearest sample, written into `out`. */
  sample(x: number, z: number, out: LayerSample = { ground: 0, canopy: 0, shrubs: 0, speed: 0 }): LayerSample {
    const n = this.size - 1
    const col = Math.min(Math.max(Math.round(x), 0), n)
    const row = Math.min(Math.max(Math.round(z), 0), n)
    const i = (row * this.size + col) * 4
    const r = this.pixels[i]!
    out.ground = r & 15
    out.canopy = this.pixels[i + 1]! * this.info.canopyUnit
    out.shrubs = (r >> 4) / this.info.levels
    out.speed = this.pixels[i + 2]! * this.info.speedUnit
    return out
  }

  dispose() {
    const image: unknown = this.texture.image
    this.texture.dispose()
    // A decoded bitmap holds its pixels until it is closed.
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close()
  }
}

/** Decode a PNG into exact pixel values (no colour management or premultiplication). */
export async function decodePng(url: string): Promise<{ bitmap: ImageBitmap; pixels: Uint8ClampedArray }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url}`)
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  return { bitmap, pixels: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data }
}

/** Loads and caches chunk layers on demand. */
export class LayerStore {
  readonly info: LayerInfo
  private readonly world: World
  private readonly cache = new Map<string, ChunkLayer>()
  private readonly pending = new Map<string, Promise<ChunkLayer | null>>()
  private added = 0

  constructor(world: World, info: LayerInfo) {
    this.world = world
    this.info = info
  }

  private key(cx: number, cy: number) {
    return `${cx}_${cy}`
  }

  get(cx: number, cy: number): ChunkLayer | undefined {
    return this.cache.get(this.key(cx, cy))
  }

  load(cx: number, cy: number): Promise<ChunkLayer | null> {
    const key = this.key(cx, cy)
    const cached = this.cache.get(key)
    if (cached) return Promise.resolve(cached)
    let promise = this.pending.get(key)
    if (!promise) {
      promise = decodePng(this.world.url(this.info.path, cx, cy))
        .then(({ bitmap, pixels }) => {
          const texture = asLayerTexture(new THREE.Texture(bitmap))
          const layer = new ChunkLayer(pixels, bitmap.width, texture, this.info)
          this.put(cx, cy, layer)
          return layer
        })
        .catch(err => {
          console.warn(err)
          return null
        })
        .finally(() => this.pending.delete(key))
      this.pending.set(key, promise)
    }
    return promise
  }

  /** Goes up whenever a layer is added, so users can tell when to look again. */
  get version(): number {
    return this.added
  }

  /** Add a decoded layer to the cache. */
  put(cx: number, cy: number, layer: ChunkLayer) {
    this.cache.set(this.key(cx, cy), layer)
    this.added++
  }

  /** The cached layers, with their chunk coordinates. */
  *entries(): Generator<[number, number, ChunkLayer]> {
    for (const [key, layer] of this.cache) {
      const [cx, cy] = key.split('_').map(Number) as [number, number]
      yield [cx, cy, layer]
    }
  }

  release(cx: number, cy: number) {
    const key = this.key(cx, cy)
    this.cache.get(key)?.dispose()
    this.cache.delete(key)
  }
}
