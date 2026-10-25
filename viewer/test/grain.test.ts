import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { QUALITY } from '../src/gfx'
import { GRAIN_HEIGHT, GrainFields, grainSurface } from '../src/grain'
import type { HeightField } from '../src/heightfield'
import { Ground, LayerStore } from '../src/layers'
import { Undergrowth } from '../src/undergrowth'
import type { World } from '../src/world'
import { CHUNK, LAYER_INFO, layerFrom, stubGfx, syntheticWorld, uniformLayer } from './synthetic'

let world: World
let heights: HeightField

beforeAll(async () => {
  ;({ world, heights } = await syntheticWorld(2, 2, col => 100 + col * 0.05))
})

/** Vertices of a surface: position, normal and whether it is part of a wall. */
function vertices(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const grain = geometry.getAttribute('aGrain')
  return Array.from({ length: position.count }, (_, i) => ({
    x: position.getX(i),
    y: position.getY(i),
    z: position.getZ(i),
    nx: normal.getX(i),
    ny: normal.getY(i),
    wall: grain.getX(i) > 0.5,
  }))
}

describe('grain surface', () => {
  it('is null for a chunk without grain', () => {
    expect(grainSurface(uniformLayer(Ground.field), 0, 0, heights)).toBeNull()
  })

  it('covers a chunk of grain at the height of the ears, without walls', () => {
    const geometry = grainSurface(uniformLayer(Ground.grain), 1, 0, heights)!
    const all = vertices(geometry)
    expect(all.some(v => v.wall)).toBe(false)
    for (const v of all) {
      expect(v.y).toBeCloseTo(heights.heightAt(CHUNK + v.x, v.z) + GRAIN_HEIGHT, 4)
      expect(v.ny).toBeGreaterThan(0.9)
    }
    // Two triangles for each cell of the grid, all facing up.
    const index = geometry.getIndex()!
    expect(index.count / 3).toBe(2 * (CHUNK / 2) ** 2)
    const p = (i: number) => new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'), index.getX(i))
    for (let t = 0; t < index.count; t += 3) {
      const a = p(t)
      const up = new THREE.Vector3().subVectors(p(t + 1), a).cross(new THREE.Vector3().subVectors(p(t + 2), a))
      expect(up.y).toBeGreaterThan(0)
    }
  })

  it('follows a slanting edge without steps', () => {
    // Grain east of a line rising one sample in three.
    const geometry = grainSurface(layerFrom((col, row) => (col >= 60 + row / 3 ? Ground.grain : Ground.field)), 0, 0, heights)!
    for (const v of vertices(geometry).filter(v => v.wall)) {
      expect(Math.abs(v.x - (59.5 + v.z / 3))).toBeLessThan(0.7)
    }
  })

  it('stands walls along the edge of a field, facing out of it', () => {
    // Grain east of x = 100.
    const geometry = grainSurface(layerFrom(col => (col >= 100 ? Ground.grain : Ground.field)), 0, 0, heights)!
    const walls = vertices(geometry).filter(v => v.wall)
    expect(walls.length).toBeGreaterThan(0)
    for (const v of walls) {
      // Halfway between the last field sample and the first grain sample.
      expect(v.x).toBeCloseTo(99.5)
      expect(v.nx).toBeCloseTo(-1)
    }
    const index = geometry.getIndex()!
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const p = (i: number) => new THREE.Vector3().fromBufferAttribute(position, index.getX(i))
    // Each wall triangle's front face points the way of its normal.
    for (let t = 0; t < index.count; t += 3) {
      if (geometry.getAttribute('aGrain').getX(index.getX(t)) < 0.5) continue
      const a = p(t)
      const front = new THREE.Vector3().subVectors(p(t + 1), a).cross(new THREE.Vector3().subVectors(p(t + 2), a))
      expect(front.x * normal.getX(index.getX(t))).toBeGreaterThan(0)
    }
  })
})

describe('grain fields', () => {
  it('builds a surface per loaded chunk, and drops it with the layer', () => {
    const layers = new LayerStore(world, LAYER_INFO)
    layers.put(0, 0, uniformLayer(Ground.grain))
    layers.put(1, 0, uniformLayer(Ground.forest))
    layers.put(0, 1, uniformLayer(Ground.grain))
    const fields = new GrainFields(layers, heights, new THREE.MeshLambertMaterial())
    fields.update()
    expect(fields.meshes.length).toBe(1)
    fields.fill()
    expect(fields.meshes.length).toBe(2)
    layers.release(0, 0)
    fields.update()
    expect(fields.meshes.length).toBe(1)
    expect(fields.group.children.length).toBe(1)
  })
})

describe('grain cards', () => {
  it('stand densely on grain and not on the grass beside it', () => {
    const layers = new LayerStore(world, LAYER_INFO)
    const ground = (col: number) => (col < 128 ? Ground.grain : Ground.field)
    for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) layers.put(cx, cy, layerFrom(ground))
    const gfx = stubGfx()
    const undergrowth = new Undergrowth(layers, heights, gfx, QUALITY.high)
    undergrowth.update(new THREE.Vector3(128, heights.heightAt(128, 128) + 1.7, 128))
    const grain = undergrowth.group.children.find(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.material === gfx.grainCard,
    )!
    const matrix = new THREE.Matrix4()
    const pos = new THREE.Vector3()
    for (let i = 0; i < grain.count; i++) {
      pos.setFromMatrixPosition((grain.getMatrixAt(i, matrix), matrix))
      // Cards fill the square metre around each grain sample, the last one at x = 127.
      expect(pos.x).toBeLessThan(127.5)
    }
    // Half a circle of 40 m radius with 3.5 cards per square metre.
    expect(grain.count).toBeGreaterThan(0.8 * 3.5 * (Math.PI * 40 ** 2) / 2)
  })
})
