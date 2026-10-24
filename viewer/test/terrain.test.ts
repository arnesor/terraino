import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terrain } from '../src/terrain'
import { CHUNK, syntheticWorld } from './synthetic'

// A tilted plane: height 100 m, rising 0.3 m per metre east and 0.2 m per metre north.
const plane = (col: number, row: number) => 100 + 0.3 * col - 0.2 * row

async function setup() {
  const { world, heights } = await syntheticWorld(3, 3, plane)
  const terrain = new Terrain(world, heights, {
    overviewDrape: new THREE.Texture(),
    maxAnisotropy: 1,
    canopyFade: [0, 1],
    groundTex: new THREE.Texture(),
  })
  const eye = (x: number, z: number, above = 1.7) => new THREE.Vector3(x, heights.heightAt(x, z) + above, z)
  return { terrain, eye }
}

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
afterEach(() => vi.clearAllMocks())

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
