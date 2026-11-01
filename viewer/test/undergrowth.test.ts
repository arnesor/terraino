import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { QUALITY } from '../src/gfx'
import type { HeightField } from '../src/heightfield'
import { LayerStore } from '../src/layers'
import { Undergrowth } from '../src/undergrowth'
import type { World } from '../src/world'
import { LAYER_INFO, stubGfx, syntheticWorld, uniformLayer } from './synthetic'

let world: World
let heights: HeightField

beforeAll(async () => {
  ;({ world, heights } = await syntheticWorld(3, 3))
})

function meshes(undergrowth: Undergrowth): THREE.InstancedMesh[] {
  return undergrowth.group.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh)
}

/** Versions of every instance buffer: they go up when a GPU upload is requested. */
function uploads(undergrowth: Undergrowth): number[] {
  return meshes(undergrowth).map(m => m.instanceMatrix.version)
}

function setup(loaded: (cx: number, cy: number) => boolean = () => true) {
  const layers = new LayerStore(world, LAYER_INFO)
  for (let cy = 0; cy < heights.chunksY; cy++) {
    for (let cx = 0; cx < heights.chunksX; cx++) if (loaded(cx, cy)) layers.put(cx, cy, uniformLayer())
  }
  const undergrowth = new Undergrowth(layers, heights, stubGfx(), QUALITY.high)
  return { layers, undergrowth }
}

const eye = (x: number, z: number) => new THREE.Vector3(x, heights.heightAt(x, z) + 1.7, z)

describe('undergrowth refill', () => {
  it('fills once near the edge of the world, then waits until the player moves', () => {
    const { undergrowth } = setup()
    undergrowth.update(eye(30, 30))
    expect(meshes(undergrowth).some(m => m.count > 0)).toBe(true)
    const before = uploads(undergrowth)
    undergrowth.update(eye(30, 30))
    expect(uploads(undergrowth)).toEqual(before)
  })

  it('waits for a missing layer instead of refilling every frame, and fills when it arrives', () => {
    // The player stands in the middle chunk; the chunk to the east is loading or failed.
    const { layers, undergrowth } = setup((cx, cy) => !(cx === 2 && cy === 1))
    const at = eye(500, 384)
    undergrowth.update(at)
    const before = uploads(undergrowth)
    undergrowth.update(at)
    expect(uploads(undergrowth)).toEqual(before)

    const bushes = meshes(undergrowth)[0]!.count
    layers.put(2, 1, uniformLayer())
    undergrowth.update(at)
    expect(meshes(undergrowth)[0]!.count).toBeGreaterThan(bushes)
  })

  it('uploads only the instances in use, not the whole capacity', () => {
    const { undergrowth } = setup()
    undergrowth.update(eye(384, 384))
    for (const mesh of meshes(undergrowth)) {
      expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: mesh.count * 16 }])
      // three creates instance colours with the first one set.
      if (mesh.instanceColor) expect(mesh.instanceColor.updateRanges).toEqual([{ start: 0, count: mesh.count * 3 }])
    }
  })

  it('grows nothing on an ant hill', () => {
    const at = eye(384, 384)
    const positions = (undergrowth: Undergrowth) => {
      const m = new THREE.Matrix4()
      const p = new THREE.Vector3()
      return meshes(undergrowth).flatMap(mesh =>
        Array.from({ length: mesh.count }, (_, i) => {
          mesh.getMatrixAt(i, m)
          return p.setFromMatrixPosition(m).clone()
        }),
      )
    }
    const inside = (ps: THREE.Vector3[]) => ps.filter(p => Math.hypot(p.x - 384, p.z - 384) < 1.3).length
    const plain = setup().undergrowth
    plain.update(at)
    expect(inside(positions(plain))).toBeGreaterThan(0)

    const { undergrowth } = setup()
    undergrowth.setClearings([384, 384, 1.3])
    undergrowth.update(at)
    expect(inside(positions(undergrowth))).toBe(0)
  })
})
