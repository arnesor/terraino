import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayerStore } from '../src/layers'
import { Terrain } from '../src/terrain'
import { CHUNK, LAYER_INFO, syntheticWorld, uniformLayer } from './synthetic'

// A tilted plane: height 100 m, rising 0.3 m per metre east and 0.2 m per metre north.
const plane = (col: number, row: number) => 100 + 0.3 * col - 0.2 * row

/** A terrain on a 3 by 3 chunk world; with `layers`, it shows the ground instead of the map. */
async function setup(withLayers = false) {
  const { world, heights } = await syntheticWorld(3, 3, plane)
  let layers: LayerStore | undefined
  if (withLayers) {
    layers = new LayerStore(world, LAYER_INFO)
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) layers.put(cx, cy, uniformLayer())
  }
  const terrain = new Terrain(world, heights, {
    overviewDrape: new THREE.Texture(),
    layers,
    layerOverview: layers && { texture: new THREE.Texture(), size: [192, 192] },
    maxAnisotropy: 1,
    canopyFade: [0, 1],
    groundTex: new THREE.Texture(),
  })
  const eye = (x: number, z: number, above = 1.7) => new THREE.Vector3(x, heights.heightAt(x, z) + above, z)
  return { terrain, eye, layers }
}

/**
 * Stand in for the browser's images, which three's texture loader uses: every image
 * fails to load. Returns the URLs requested.
 */
function brokenImages(): string[] {
  const requests: string[] = []
  vi.stubGlobal('document', {
    createElementNS: () => {
      const listeners = new Map<string, (event: unknown) => void>()
      const image = {
        addEventListener: (type: string, f: (event: unknown) => void) => listeners.set(type, f),
        removeEventListener: (type: string) => listeners.delete(type),
        set src(url: string) {
          requests.push(url)
          setTimeout(() => listeners.get('error')?.call(image, new Error(`404 ${url}`)), 0)
        },
      }
      return image
    },
  })
  return requests
}

/** Let pending texture loads finish. */
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

function chunks(terrain: Terrain): THREE.Mesh[] {
  return terrain.group.children as THREE.Mesh[]
}

/** Vertex spacing of a chunk mesh, from its vertex count: (n + 1)^2 grid plus a 4n skirt. */
function step(mesh: THREE.Mesh): number {
  const count = mesh.geometry.getAttribute('position').count
  const n = Math.sqrt(count + 8) - 3 // (n + 1)^2 + 4n = (n + 3)^2 - 8
  return CHUNK / n
}

// Near chunks try to load their drape textures, which cannot load without a browser.
vi.spyOn(console, 'warn').mockImplementation(() => {})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('terrain levels of detail', () => {
  it('rebuilds only one full-detail chunk per frame', async () => {
    const { terrain, eye } = await setup()
    // Every chunk is within 250 m of the middle, so all of them want full detail.
    terrain.update(eye(384, 384))
    const fine = chunks(terrain).filter(m => step(m) === 1)
    expect(fine).toHaveLength(1)
    // The chunk under the player comes first.
    expect(fine[0]!.position.toArray()).toEqual([256, 0, 256])
  })

  it('rebuilds many coarse chunks in one frame', async () => {
    const { terrain, eye } = await setup()
    await terrain.prepare(eye(384, 384))
    expect(chunks(terrain).every(m => step(m) === 1)).toBe(true)
    // Flying high above the world: every chunk wants the coarsest level.
    terrain.update(eye(384, 384, 4000))
    expect(chunks(terrain).every(m => step(m) === 16)).toBe(true)
  })

  it('shades a tilted plane with the plane normal', async () => {
    const { terrain, eye } = await setup()
    await terrain.prepare(eye(384, 384))
    const middle = chunks(terrain).find(m => m.position.x === 256 && m.position.z === 256)!
    const normals = middle.geometry.getAttribute('normal')
    const expected = new THREE.Vector3(-0.3, 1, 0.2).normalize()
    const normal = new THREE.Vector3()
    for (let i = 0; i < normals.count; i++) {
      normal.fromBufferAttribute(normals, i)
      expect(normal.distanceTo(expected)).toBeLessThan(1e-4)
    }
  })
})

describe('terrain detail textures', () => {
  it('does not fetch a missing drape again every frame', async () => {
    const requests = brokenImages()
    const { terrain, eye } = await setup()
    await terrain.prepare(eye(384, 384))
    const tried = requests.length
    expect(tried).toBeGreaterThan(0)
    for (let frame = 0; frame < 3; frame++) {
      terrain.update(eye(384, 384))
      await settle()
    }
    expect(requests).toHaveLength(tried)
  })

  it('shows the detailed ground where the drape is missing, and releases its layer far away', async () => {
    brokenImages()
    const { terrain, eye, layers } = await setup(true)
    const middle = chunks(terrain).find(m => m.position.x === 256 && m.position.z === 256)!
    const overview = middle.material
    await terrain.prepare(eye(384, 384))
    expect(middle.material).not.toBe(overview)

    // Flying high above the world, every chunk is far away.
    terrain.update(eye(384, 384, 4000))
    expect(middle.material).toBe(overview)
    expect(layers!.get(1, 1)).toBeUndefined()
  })
})
