// World package format written by the Python pipeline (src/terraino/export.py).
//
// Scene coordinates: x = easting - origin easting, z = origin northing - northing
// (so +z points south), y = height above sea level. The origin is the north-west
// height sample, so height sample (col, row) sits at scene (col * step, row * step).

export interface HeightInfo {
  origin: [number, number]
  step: number
  cols: number
  rows: number
  chunk: number
  chunksX: number
  chunksY: number
  encoding: 'uint16le'
  offset: number
  scale: number
  min: number
  max: number
  path: string
  /** Chunks away from the map, stored with only every `step`-th sample (format 3). */
  coarse?: { step: number; chunks: number[] }
}

export interface LayerInfo {
  path: string
  size: number
  overview: string
  overviewStep: number
  canopyUnit: number
  /** Undergrowth levels: density = level / levels. */
  levels: number
  /** Running speed = blue channel value × speedUnit. */
  speedUnit: number
  ground: Record<string, number>
  /** 'lidar' when the undergrowth layer comes from a laser point cloud as well. */
  undergrowth?: 'lidar' | 'map'
}

export interface TreeInfo {
  path: string
  counts: number[]
  total: number
  posScale: number
  heightScale: number
  crownScale: number
  recordBytes: number
  species: Record<string, string>
  /** Added to the species byte of trees that grew up in a stand (seed trees). */
  standGrownFlag?: number
  /** Added to the species byte of thickets: dense clumps of young trees or brush. */
  thicketFlag?: number
  /** Crown base class (0 unknown, 1-3 low to high) in the species byte, from this bit. */
  crownBaseShift?: number
}

export type MapKind = 'orienteering' | 'topographic'

export interface Manifest {
  format: number
  name: string
  crs: string
  extent: [number, number, number, number]
  height: HeightInfo
  drape: { path: string; tilePx: number; overview: string }
  /**
   * offset: shift the map was built with (--offset), applied to courses from OCAD files.
   * kind: the orienteering map, or Kartverket's topographic map in a mapless world (format 9).
   */
  map: {
    image: string
    size: [number, number]
    scale: number | null
    offset?: [number, number]
    kind: MapKind
  }
  /** Where the runner is meant to be: the mapped area, or a mapless world's chosen area. */
  coreArea: [number, number][]
  spawn: [number, number]
  /** Where the runner looks at the spawn, in degrees clockwise from grid north (format 6). */
  spawnHeading?: number
  attribution: string[]
  layers?: LayerInfo
  trees?: TreeInfo
  buildings?: { path: string; count: number }
  features?: { path: string; points: number; lines: number; cliffs: number }
  tracks?: { path: string; count: number }
  /** Road bridge decks (format 8); the tracks stop at their ends. */
  bridges?: { path: string; count: number }
}

// Format 5 added the grain ground class; format 4 worlds have none and still work.
// Format 6 added the spawn heading; older worlds open looking north.
// Format 9 renamed mapArea to coreArea and added the map's kind; older worlds have an
// orienteering map.
export const SUPPORTED_FORMATS = [4, 5, 6, 7, 8, 9]

/** A manifest of an older format in the current shape. */
export function upgradeManifest(manifest: Manifest): Manifest {
  if (manifest.format >= 9) return manifest
  const old = manifest as Manifest & { mapArea?: [number, number][] }
  const { mapArea, ...rest } = old
  return { ...rest, coreArea: mapArea ?? [], map: { ...old.map, kind: 'orienteering' } }
}

export class World {
  readonly base: string
  readonly manifest: Manifest

  constructor(base: string, manifest: Manifest) {
    this.base = base
    this.manifest = manifest
  }

  static async load(name: string): Promise<World> {
    const base = `/worlds/${encodeURIComponent(name)}/`
    const response = await fetch(base + 'manifest.json')
    if (!response.ok) throw new Error(`World "${name}" not found (${response.status})`)
    const manifest = (await response.json()) as Manifest
    if (!SUPPORTED_FORMATS.includes(manifest.format)) {
      throw new Error(`World format ${manifest.format} is not supported; rebuild the world`)
    }
    return new World(base, upgradeManifest(manifest))
  }

  url(template: string, x?: number, y?: number): string {
    return this.base + template.replace('{x}', String(x)).replace('{y}', String(y))
  }

  /** Scene x/z of a projected coordinate. */
  toScene(easting: number, northing: number): [number, number] {
    const [e0, n0] = this.manifest.height.origin
    return [easting - e0, n0 - northing]
  }

  /** Projected easting/northing of a scene x/z. */
  toProjected(x: number, z: number): [number, number] {
    const [e0, n0] = this.manifest.height.origin
    return [x + e0, n0 - z]
  }

  /** Size of the height grid in scene units. */
  get sceneSize(): [number, number] {
    const h = this.manifest.height
    return [(h.cols - 1) * h.step, (h.rows - 1) * h.step]
  }
}

export async function listWorlds(): Promise<string[]> {
  const response = await fetch('/worlds/index.json')
  return response.ok ? ((await response.json()) as string[]) : []
}
