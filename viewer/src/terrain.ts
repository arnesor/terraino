import * as THREE from 'three'
import { createGroundMaterial } from './groundMaterial'
import type { HeightField } from './heightfield'
import type { LayerStore } from './layers'
import type { World } from './world'

// Distance (m) up to which each level of detail is used; the step is the vertex spacing.
const LODS = [
  { maxDistance: 250, step: 1 },
  { maxDistance: 600, step: 2 },
  { maxDistance: 1400, step: 4 },
  { maxDistance: 3000, step: 8 },
  { maxDistance: Infinity, step: 16 },
]
// Chunks closer than this use their full-resolution textures.
const DETAIL_TEXTURE_DISTANCE = 450
// Chunk vertices rebuilt per frame at most, to avoid stutter: about one full-detail chunk.
// A chunk bigger than this is still rebuilt when it is the first in a frame.
const MAX_REBUILT_VERTICES_PER_FRAME = 70_000
const MAX_TEXTURE_LOADS = 6

export type TerrainMode = 'ground' | 'map'

interface Chunk {
  cx: number
  cy: number
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>
  center: THREE.Vector3
  step: number
  wantStep: number
  near: boolean
  overviewDrape: THREE.MeshLambertMaterial
  detailDrape: THREE.MeshLambertMaterial | null
  detailGround: THREE.MeshLambertMaterial | null
  loading: boolean
}

/** Index buffer for a chunk grid with `n` cells per side plus a skirt around it. */
function buildIndex(n: number): THREE.BufferAttribute {
  const side = n + 1
  const grid = side * side
  const indices: number[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r * side + c
      const b = a + 1
      const d = a + side
      const e = d + 1
      indices.push(a, d, b, b, d, e)
    }
  }
  // Skirt: a second ring of vertices below the edge, in the same order as `edgeRing`.
  const ring = edgeRing(n)
  for (let i = 0; i < ring.length; i++) {
    const top0 = ring[i]!
    const top1 = ring[(i + 1) % ring.length]!
    const low0 = grid + i
    const low1 = grid + ((i + 1) % ring.length)
    // Wound so the skirt faces outward.
    indices.push(top0, top1, low0, top1, low1, low0)
  }
  const IndexArray = grid + ring.length > 65535 ? Uint32Array : Uint16Array
  return new THREE.BufferAttribute(new IndexArray(indices), 1)
}

/** Vertex indices around the edge of the grid, clockwise seen from above. */
function edgeRing(n: number): number[] {
  const side = n + 1
  const ring: number[] = []
  for (let c = 0; c < n; c++) ring.push(c) // north edge, west to east
  for (let r = 0; r < n; r++) ring.push(r * side + n) // east edge, north to south
  for (let c = n; c > 0; c--) ring.push(n * side + c) // south edge, east to west
  for (let r = n; r > 0; r--) ring.push(r * side) // west edge, south to north
  return ring
}

export interface TerrainOptions {
  overviewDrape: THREE.Texture
  layers?: LayerStore
  layerOverview?: { texture: THREE.Texture; size: [number, number] }
  maxAnisotropy: number
  /** Distances over which the ground turns into painted canopy (trees fade out). */
  canopyFade: [number, number]
  /** Ground textures (gfx.groundArray). */
  groundTex: THREE.Texture
}

export class Terrain {
  readonly group = new THREE.Group()
  private readonly world: World
  private readonly heights: HeightField
  private readonly options: TerrainOptions
  private readonly chunks: Chunk[] = []
  private readonly indexCache = new Map<number, THREE.BufferAttribute>()
  private readonly textureLoader = new THREE.TextureLoader()
  private readonly overviewGround: THREE.MeshLambertMaterial | null = null
  private texturesLoading = 0
  private modeValue: TerrainMode

  constructor(world: World, heights: HeightField, options: TerrainOptions) {
    this.world = world
    this.heights = heights
    this.options = options
    this.group.name = 'terrain'

    const layerInfo = world.manifest.layers
    if (options.layerOverview && layerInfo) {
      const step = layerInfo.overviewStep
      this.overviewGround = createGroundMaterial(
        {
          texture: options.layerOverview.texture,
          origin: [step / 2, step / 2],
          step,
          size: options.layerOverview.size,
        },
        layerInfo.canopyUnit,
        options.canopyFade,
        options.groundTex,
      )
    }
    this.modeValue = this.overviewGround ? 'ground' : 'map'

    const n = heights.chunk
    const [x0, y0, x1, y1] = world.manifest.extent
    const width = x1 - x0
    const height = y1 - y0
    const overview = options.overviewDrape
    overview.colorSpace = THREE.SRGBColorSpace
    overview.anisotropy = options.maxAnisotropy

    for (let cy = 0; cy < heights.chunksY; cy++) {
      for (let cx = 0; cx < heights.chunksX; cx++) {
        // Map this chunk's 0..1 UVs into the overview image, which covers the full extent.
        const tex = overview.clone()
        tex.repeat.set(n / width, n / height)
        tex.offset.set((0.5 + n * cx) / width, 1 - (0.5 + n * (cy + 1)) / height)
        const overviewDrape = new THREE.MeshLambertMaterial({ map: tex })

        const center = new THREE.Vector3((cx + 0.5) * n, 0, (cy + 0.5) * n)
        center.y = heights.heightAt(center.x, center.z)
        const step = LODS[LODS.length - 1]!.step
        const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
          this.buildGeometry(cx, cy, step),
          this.overviewGround ?? overviewDrape,
        )
        mesh.position.set(cx * n, 0, cy * n)
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        mesh.receiveShadow = true
        this.group.add(mesh)
        this.chunks.push({
          cx,
          cy,
          mesh,
          center,
          step,
          wantStep: step,
          near: false,
          overviewDrape,
          detailDrape: null,
          detailGround: null,
          loading: false,
        })
      }
    }
  }

  get mode(): TerrainMode {
    return this.modeValue
  }

  /** Switch between the realistic ground and the draped orienteering map. */
  setMode(mode: TerrainMode) {
    if (mode === 'ground' && !this.overviewGround) return
    this.modeValue = mode
    for (const chunk of this.chunks) this.applyMaterial(chunk)
  }

  private applyMaterial(chunk: Chunk) {
    if (this.modeValue === 'ground' && this.overviewGround) {
      chunk.mesh.material = (chunk.near && chunk.detailGround) || this.overviewGround
    } else {
      chunk.mesh.material = (chunk.near && chunk.detailDrape) || chunk.overviewDrape
    }
  }

  private index(n: number): THREE.BufferAttribute {
    let index = this.indexCache.get(n)
    if (!index) {
      index = buildIndex(n)
      this.indexCache.set(n, index)
    }
    return index
  }

  private buildGeometry(cx: number, cy: number, step: number): THREE.BufferGeometry {
    const size = this.heights.chunk
    const n = size / step
    const side = n + 1
    const ring = edgeRing(n)
    const count = side * side + ring.length
    const positions = new Float32Array(count * 3)
    const normals = new Float32Array(count * 3)
    const uvs = new Float32Array(count * 2)
    const col0 = cx * size
    const row0 = cy * size
    const h = this.heights
    const normal = new THREE.Vector3()

    for (let r = 0; r < side; r++) {
      for (let c = 0; c < side; c++) {
        const i = r * side + c
        const col = col0 + c * step
        const row = row0 + r * step
        positions[i * 3] = c * step
        positions[i * 3 + 1] = h.sample(col, row)
        positions[i * 3 + 2] = r * step
        // Central differences over the whole field give seamless lighting across chunks.
        normal
          .set(
            h.sample(col - step, row) - h.sample(col + step, row),
            2 * step,
            h.sample(col, row - step) - h.sample(col, row + step),
          )
          .normalize()
        normals[i * 3] = normal.x
        normals[i * 3 + 1] = normal.y
        normals[i * 3 + 2] = normal.z
        uvs[i * 2] = c / n
        uvs[i * 2 + 1] = 1 - r / n
      }
    }
    // Skirt vertices hang below the edge to hide cracks between levels of detail.
    const drop = 1 + step * 1.5
    ring.forEach((top, k) => {
      const i = side * side + k
      positions[i * 3] = positions[top * 3]!
      positions[i * 3 + 1] = positions[top * 3 + 1]! - drop
      positions[i * 3 + 2] = positions[top * 3 + 2]!
      normals.set(normals.subarray(top * 3, top * 3 + 3), i * 3)
      uvs[i * 2] = uvs[top * 2]!
      uvs[i * 2 + 1] = uvs[top * 2 + 1]!
    })

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geometry.setIndex(this.index(n))
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, h.chunkMin(cx, cy) - drop, 0),
      new THREE.Vector3(size, h.chunkMax(cx, cy), size),
    )
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
    return geometry
  }

  /** Load the full-resolution drape and ground layer of a chunk. */
  private async fetchDetail(chunk: Chunk): Promise<void> {
    chunk.loading = true
    this.texturesLoading++
    const url = this.world.url(this.world.manifest.drape.path, chunk.cx, chunk.cy)
    const layerInfo = this.world.manifest.layers
    try {
      const [drape, layer] = await Promise.all([
        this.textureLoader.loadAsync(url),
        this.options.layers?.load(chunk.cx, chunk.cy) ?? Promise.resolve(null),
      ])
      drape.colorSpace = THREE.SRGBColorSpace
      drape.anisotropy = this.options.maxAnisotropy
      drape.wrapS = drape.wrapT = THREE.ClampToEdgeWrapping
      chunk.detailDrape = new THREE.MeshLambertMaterial({ map: drape })
      if (layer && layerInfo) {
        const n = this.heights.chunk
        chunk.detailGround = createGroundMaterial(
          {
            texture: layer.texture,
            origin: [chunk.cx * n, chunk.cy * n],
            step: 1,
            size: [layer.size, layer.size],
          },
          layerInfo.canopyUnit,
          this.options.canopyFade,
          this.options.groundTex,
        )
      }
      this.applyMaterial(chunk)
    } catch (err) {
      console.warn(`Could not load details of chunk ${chunk.cx}_${chunk.cy}`, err)
    } finally {
      this.texturesLoading--
      chunk.loading = false
    }
  }

  private loadDetail(chunk: Chunk) {
    if (chunk.loading || chunk.detailDrape || this.texturesLoading >= MAX_TEXTURE_LOADS) return
    void this.fetchDetail(chunk)
  }

  private dropDetail(chunk: Chunk) {
    if (!chunk.detailDrape) return
    chunk.near = false
    this.applyMaterial(chunk)
    chunk.detailDrape.map?.dispose()
    chunk.detailDrape.dispose()
    chunk.detailDrape = null
    chunk.detailGround?.dispose()
    chunk.detailGround = null
    this.options.layers?.release(chunk.cx, chunk.cy)
  }

  private distanceTo(chunk: Chunk, eye: THREE.Vector3): number {
    return Math.max(0, chunk.center.distanceTo(eye) - (this.heights.chunk * Math.SQRT2) / 2)
  }

  /**
   * Bring every chunk to its final level of detail for a camera at `eye` and load the
   * nearby textures, so the first frame shows the finished terrain without pop-in.
   */
  async prepare(eye: THREE.Vector3): Promise<void> {
    const near: Chunk[] = []
    for (const chunk of this.chunks) {
      const distance = this.distanceTo(chunk, eye)
      chunk.wantStep = LODS.find(l => distance < l.maxDistance)!.step
      if (chunk.wantStep !== chunk.step) {
        chunk.mesh.geometry.dispose()
        chunk.mesh.geometry = this.buildGeometry(chunk.cx, chunk.cy, chunk.wantStep)
        chunk.step = chunk.wantStep
      }
      if (distance < DETAIL_TEXTURE_DISTANCE) {
        chunk.near = true
        near.push(chunk)
      }
    }
    await Promise.all(near.map(chunk => this.fetchDetail(chunk)))
  }

  /** Update levels of detail and textures for a camera at `eye`. */
  update(eye: THREE.Vector3) {
    for (const chunk of this.chunks) {
      const distance = this.distanceTo(chunk, eye)
      chunk.wantStep = LODS.find(l => distance < l.maxDistance)!.step

      if (distance < DETAIL_TEXTURE_DISTANCE) {
        if (!chunk.near) {
          chunk.near = true
          this.applyMaterial(chunk)
        }
        this.loadDetail(chunk)
      } else if (distance > DETAIL_TEXTURE_DISTANCE * 1.5) {
        this.dropDetail(chunk)
      }
    }

    // Rebuild the chunks that most need a finer level first.
    const pending = this.chunks
      .filter(c => c.wantStep !== c.step)
      .sort((a, b) => a.wantStep - b.wantStep || a.center.distanceTo(eye) - b.center.distanceTo(eye))
    let budget = MAX_REBUILT_VERTICES_PER_FRAME
    for (const chunk of pending) {
      const vertices = (this.heights.chunk / chunk.wantStep + 1) ** 2
      if (vertices > budget && budget < MAX_REBUILT_VERTICES_PER_FRAME) break
      budget -= vertices
      const old = chunk.mesh.geometry
      chunk.mesh.geometry = this.buildGeometry(chunk.cx, chunk.cy, chunk.wantStep)
      chunk.step = chunk.wantStep
      old.dispose()
    }
  }
}
