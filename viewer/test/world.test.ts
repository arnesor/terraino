// Loads the fixture world as the viewer does, with the files read from disk.
// The world is built first from tests/fixtures by the Python pipeline, offline.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MapFeatures } from '../src/features'
import { TreeChunk } from '../src/forest'
import { type Gfx, QUALITY } from '../src/gfx'
import { HeightField } from '../src/heightfield'
import { loadBuildings } from '../src/buildings'
import { readCourseFile } from '../src/ocad/courses'
import { blocked, type PlacementData, placeFlag } from '../src/placement'
import { Tracks } from '../src/tracks'
import { OModels } from '../src/vendor/models.js'
import { World } from '../src/world'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const NAME = 'LangvatnetUtsnitt'

/** What the loaders take from Gfx; textures and shaders only matter on a GPU. */
function stubGfx(): Gfx {
  const texture = new THREE.Texture()
  return {
    models: OModels.build(THREE),
    textures: new Proxy({}, { get: () => texture }),
    groundArray: null,
    time: { value: 0 },
  } as unknown as Gfx
}

let dir: string
let world: World
let heights: HeightField
const gfx = stubGfx()

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraino-world-'))
  execFileSync('uv', ['run', 'python', '-m', 'tests.fixture_world', path.join(dir, NAME)], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  vi.stubGlobal('fetch', async (url: string) => {
    const file = path.join(dir, decodeURIComponent(url.replace(/^\/worlds\//, '')))
    return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response(null, { status: 404 })
  })
  world = await World.load(NAME)
  heights = await HeightField.load(world, () => {})
}, 300_000)

afterAll(() => {
  vi.unstubAllGlobals()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('fixture world', () => {
  it('has the map in its manifest', () => {
    const m = world.manifest
    expect(m.name).toBe(NAME)
    expect(m.crs).toBe('EPSG:25832')
    const [x, z] = world.toScene(...m.spawn)
    const [w, d] = world.sceneSize
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(w)
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(d)
  })

  it('loads heights that join up between chunks', () => {
    const h = world.manifest.height
    const n = heights.chunk
    for (let cy = 0; cy < h.chunksY; cy++) {
      for (let cx = 0; cx < h.chunksX; cx++) {
        const chunk = heights.chunkHeights(cx, cy)
        expect(chunk).toHaveLength((n + 1) ** 2)
        expect(heights.chunkMin(cx, cy)).toBeGreaterThanOrEqual(h.min - h.scale)
        expect(heights.chunkMax(cx, cy)).toBeLessThanOrEqual(h.max + h.scale)
        if (cx + 1 < h.chunksX) {
          const east = heights.chunkHeights(cx + 1, cy)
          for (let row = 0; row <= n; row++) expect(east[row * (n + 1)]).toBe(chunk[row * (n + 1) + n])
        }
        if (cy + 1 < h.chunksY) {
          const south = heights.chunkHeights(cx, cy + 1)
          for (let col = 0; col <= n; col++) expect(south[col]).toBe(chunk[n * (n + 1) + col])
        }
      }
    }
  })

  it('decodes every tree chunk onto the ground', async () => {
    const info = world.manifest.trees!
    const n = heights.chunk
    let total = 0
    for (let cy = 0; cy < heights.chunksY; cy++) {
      for (let cx = 0; cx < heights.chunksX; cx++) {
        const response = await fetch(world.url(info.path, cx, cy))
        const trees = new TreeChunk(cx, cy, await response.arrayBuffer(), info, n, heights, null)
        expect(trees.count).toBe(info.counts[cy * heights.chunksX + cx])
        total += trees.count
        for (let i = 0; i < trees.count; i++) {
          const [x, z] = [trees.x[i]!, trees.z[i]!]
          expect(x >= cx * n && x < (cx + 1) * n && z >= cy * n && z < (cy + 1) * n).toBe(true)
          expect(trees.y[i]).toBeCloseTo(heights.heightAt(x, z) - 0.2, 3)
          expect(trees.height[i]).toBeGreaterThan(0.3)
          expect(trees.height[i]).toBeLessThan(45)
        }
      }
    }
    expect(total).toBe(info.total)
  })

  it('raises the buildings from the ground', async () => {
    const buildings = (await loadBuildings(world, gfx))!
    expect(buildings.outlines).toHaveLength(world.manifest.buildings!.count)
    expect(buildings.group.children.length).toBeGreaterThan(0)
    const records = (await (await fetch(world.url(world.manifest.buildings!.path))).json()) as {
      outline: [number, number][]
      base: number
    }[]
    const [w, d] = world.sceneSize
    // Buildings traced from Kartverket's map tiles can lie beyond the terrain; skip those.
    const inside = records.filter(b => b.outline.every(([x, z]) => x >= 0 && x <= w && z >= 0 && z <= d))
    expect(inside.length).toBeGreaterThan(20)
    for (const b of inside) {
      const ground = b.outline.map(([x, z]) => heights.heightAt(x, z))
      expect(b.base).toBeGreaterThan(Math.min(...ground) - 1)
      expect(b.base).toBeLessThan(Math.max(...ground) + 1)
    }
  })

  it('lays the tracks on the ground', async () => {
    const tracks = (await Tracks.load(world, heights, gfx))!
    const strips = tracks.group.children.filter(c => c instanceof THREE.Mesh)
    expect(strips.length).toBeGreaterThan(0)
    for (const strip of strips) {
      const position = strip.geometry.getAttribute('position')
      for (let i = 0; i < position.count; i++) {
        const lift = position.getY(i) - heights.heightAt(position.getX(i), position.getZ(i))
        expect(lift).toBeCloseTo(0.06, 3)
      }
    }
  })

  it('draws only the rocks near the player, farther at a higher quality', async () => {
    const features = (await MapFeatures.load(world, heights, gfx, QUALITY.low))!
    const { kinds, points } = features.data
    const rocks = points.filter(p => kinds[p[0]] === 'boulder' || kinds[p[0]] === 'stone')
    const drawn = () =>
      features.group.children.reduce((n, c) => n + (c instanceof THREE.InstancedMesh ? c.count : 0), 0)
    // Within the distance, plus the 10 m the player may move before the rocks are picked again.
    const expected = (eye: THREE.Vector3, quality: typeof QUALITY.low) =>
      rocks.filter(([k, x, z]) => {
        const reach = (kinds[k] === 'stone' ? quality.cover : quality.boulders) + 10
        return Math.hypot(x - eye.x, z - eye.z) <= reach
      }).length
    // 350 m from a boulder: beyond the boulders on low (300 m), within them on high (600 m).
    // Small stones (none in this world) only reach as far as the ground cover.
    const rock = rocks.find(p => kinds[p[0]] === 'boulder')!
    const eye = new THREE.Vector3(rock[1] + 350, 0, rock[2])
    expect(drawn()).toBe(0)
    features.update(eye)
    const low = drawn()
    expect(low).toBe(expected(eye, QUALITY.low))
    features.setQuality(QUALITY.high)
    features.update(eye)
    expect(drawn()).toBe(expected(eye, QUALITY.high))
    expect(drawn()).toBeGreaterThan(low)
    // Far away from every rock, none are drawn.
    features.update(new THREE.Vector3(-1e5, 0, -1e5))
    expect(drawn()).toBe(0)
  })

  it('places the test course flags clear of the map features', async () => {
    const features = (await MapFeatures.load(world, heights, gfx, QUALITY.high))!
    const m = world.manifest.features!
    expect(features.data.points).toHaveLength(m.points)
    expect(features.data.lines).toHaveLength(m.lines)
    expect(features.data.cliffs).toHaveLength(m.cliffs)
    const buildings = (await loadBuildings(world, gfx))!
    const placement: PlacementData = {
      ...features.data,
      buildings: buildings.outlines,
      heightAt: (x, z) => heights.heightAt(x, z),
    }
    const bytes = fs.readFileSync(new URL('./fixtures/TestCourseLangvatnet.ocd', import.meta.url))
    const file = readCourseFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const controls = file.courses[0]!.controls.filter(c => c.kind === 'control')
    expect(controls).toHaveLength(2)
    for (const control of controls) {
      const centre = world.toScene(...control.position)
      const flag = placeFlag(control.description, centre, placement)
      expect(Math.hypot(flag[0] - centre[0], flag[1] - centre[1])).toBeLessThan(25)
      expect(blocked(placement, flag)).toBe(false)
    }
  })
})
