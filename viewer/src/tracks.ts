import * as THREE from 'three'
import { type Gfx, GROUND_TEX_GLSL, type QualitySettings } from './gfx'
import type { HeightField } from './heightfield'
import type { World } from './world'

export interface TrackRecord {
  kind: string
  width: number
  points: [number, number][]
}

/**
 * Look of each kind (terraino.process.symbols.TRACKS). Strips reach `margin` metres past
 * the track's edge, where the ground beside it is worn (paths) or damp (streams).
 * Footpaths are drawn first, then water (so a stream shows across a path, which gets a
 * footbridge), then roads (culverts carry them over streams).
 */
const STYLES: Record<string, { id: number; margin: number; order: number }> = {
  faint_path: { id: 5, margin: 0.8, order: 1 },
  small_path: { id: 4, margin: 1.0, order: 2 },
  path: { id: 3, margin: 1.2, order: 3 },
  water_channel: { id: 8, margin: 1.0, order: 4 },
  small_stream: { id: 7, margin: 1.6, order: 5 },
  stream: { id: 6, margin: 2.0, order: 6 },
  vehicle_track: { id: 2, margin: 1.0, order: 7 },
  gravel: { id: 1, margin: 1.0, order: 8 },
  paved: { id: 0, margin: 0.6, order: 9 },
}
const FOOTPATHS = new Set(['path', 'small_path', 'faint_path'])
const BRIDGED_WATER = new Set(['stream', 'small_stream', 'water_channel'])
const SAMPLE_M = 1.0
const LIFT_M = 0.06
// At most this far between vertices across a strip, so it follows the ground's shape.
const ACROSS_M = 1.0
const CAP_SEGMENTS = 6
const MAX_MITER = 2
const INDEX_CELL = 8
const TILE_M = 256
// Which strips are near enough to draw (QualitySettings.tracks) is checked again after
// moving this far.
const STRIP_RECHECK_M = 10

const SHADER_COMMON = /* glsl */ `
uniform int trackKind;
uniform float uTime;
varying vec3 vTrack;
varying vec3 vTrackPos;
${GROUND_TEX_GLSL}
vec3 tLin(vec3 c) { return pow(c, vec3(2.2)); }
`

const SHADER_MAIN = /* glsl */ `
  // vTrack: x = metres from the centre line, y = metres along, z = half width.
  vec2 tp = vTrackPos.xz;
  vec2 uv = tp / 3.2;
  float hw = vTrack.z;
  float am = abs(vTrack.x);
  float fine = gtNoise(tp * 3.1);
  float patches = gtNoise(tp * 0.45 + 13.0);
  // Signed distance to the track's edge, ragged.
  float e = am - hw + (gtNoise(tp * 0.9) - 0.5) * 0.22 + (gtNoise(tp * 3.7) - 0.5) * 0.08;
  vec3 surf;
  float core;
  // The worn (or damp) ground beside the track: darkened, partly covering.
  vec3 besideCol = tLin(vec3(0.25, 0.2, 0.14));
  float beside = (1.0 - smoothstep(0.0, 1.2, e)) * 0.3;

  if (trackKind == 0) {
    // Asphalt with a gravel shoulder.
    surf = gtx(GT_ASPHALT, uv * 1.3);
    core = 1.0 - smoothstep(-0.05, 0.05, e);
    besideCol = gtx(GT_GRAVEL, uv * 2.4) * 0.9;
    beside = (1.0 - smoothstep(0.1, 0.6, e)) * 0.95;
  } else if (trackKind == 1) {
    // Gravel road, sometimes a grassy strip in the middle.
    // Fine gravel worn into the soil.
    surf = mix(gtx(GT_GRAVEL, uv * 2.4), gtx(GT_SOIL, uv), 0.3);
    float mid = (1.0 - smoothstep(0.15, 0.4, am)) * smoothstep(0.55, 0.8, gtNoise(tp * 0.3));
    surf = mix(surf, gtx(GT_GRASS, uv) * 0.85, mid * 0.6);
    core = 1.0 - smoothstep(-0.2, 0.1, e);
  } else if (trackKind == 2) {
    // Vehicle track: two bare wheel ruts, grass between them and at the sides.
    float u = am / max(hw, 0.1) + (fine - 0.5) * 0.12;
    float rut = smoothstep(0.12, 0.3, u) * (1.0 - smoothstep(0.62, 0.86, u));
    surf = mix(gtx(GT_SOIL, uv), gtx(GT_GRAVEL, uv * 2.4), 0.3) * (0.85 + 0.25 * smoothstep(0.3, 0.55, abs(u - 0.57) * 4.0));
    core = rut * 0.92;
  } else if (trackKind <= 5) {
    // Footpaths: trodden earth with roots worn smooth and small stones sticking up.
    float narrow = trackKind == 3 ? 0.7 : 1.0;
    surf = gtx(GT_SOIL, uv);
    float nr = gtNoise(tp * 0.7 + vec2(gtNoise(tp * 0.23) * 2.3, 0.0)) * 0.65 + gtNoise(tp * 1.9 + 3.1) * 0.35;
    float rootLine = 1.0 - smoothstep(0.016, 0.034, abs(nr - 0.5));
    float rootPatch = smoothstep(0.32, 0.62, gtNoise(tp * 0.11 + 5.0)) * narrow;
    float rl = rootLine * rootPatch * smoothstep(0.5, 0.66, gtNoise(tp * 1.1 + 9.0));
    vec3 rootCol = mix(tLin(vec3(0.24, 0.16, 0.11)), tLin(vec3(0.44, 0.33, 0.24)), smoothstep(0.008, 0.0, abs(nr - 0.5)));
    surf = mix(surf * (1.0 - 0.35 * (1.0 - smoothstep(0.03, 0.06, abs(nr - 0.5))) * rootPatch), rootCol, rl);
    vec2 sc = tp * 2.5;
    vec2 ci = floor(sc);
    vec2 f = fract(sc) - 0.5;
    vec2 o = (vec2(gtHash(ci + 1.3), gtHash(ci + 7.1)) - 0.5) * 0.45;
    float rad = 0.13 + 0.22 * gtHash(ci + 3.7);
    float ds = length((f - o) * vec2(1.0, 1.25));
    float stoneP = (0.04 + 0.2 * smoothstep(0.4, 0.8, gtNoise(tp * 0.17 + 11.0))) * narrow;
    if (gtHash(ci + 17.0) < stoneP) {
      float st = 1.0 - smoothstep(rad * 0.82, rad, ds);
      float rim = (1.0 - smoothstep(rad, rad * 1.35, ds)) * (1.0 - st);
      float lit = 0.75 + 0.4 * clamp(dot(normalize(f - o + 1e-4), vec2(-0.55, -0.83)), -1.0, 1.0) * smoothstep(0.0, rad, ds);
      vec3 sCol = gtx(GT_ROCK, uv * 3.0) * (0.55 + 0.3 * gtHash(ci + 9.1)) * lit;
      // Half buried: the soil covers the stone's edge.
      st *= smoothstep(0.0, 0.5, gtNoise((f - o) * 9.0 + ci) + 0.4);
      surf = mix(surf * (1.0 - 0.4 * rim), sCol, st);
    }
    // Grass and moss creep in at the sides; faint paths are broken up by it.
    float strength = trackKind == 3 ? 1.0 : trackKind == 4 ? 0.9 : 0.7;
    core = (1.0 - smoothstep(-0.12, 0.08, e)) * strength;
    if (trackKind == 5) core *= smoothstep(0.2, 0.55, patches + 0.3 * fine);
    beside *= strength;
  } else if (trackKind <= 7) {
    // Streams: water over a stony bed, wet stones and mud on the banks.
    vec3 stones = mix(gtx(GT_GRAVEL, uv * 1.9), gtx(GT_ROCK, uv * 1.1), smoothstep(0.35, 0.65, gtNoise(tp * 2.2))) * vec3(0.4, 0.37, 0.3);
    vec3 mud = gtx(GT_SOIL, uv * 1.3) * vec3(0.55, 0.5, 0.42);
    float inBed = 1.0 - smoothstep(-0.05, 0.35, e);
    float wetBank = 1.0 - smoothstep(0.05, 0.6, e);
    vec3 viewDir = normalize(cameraPosition - vTrackPos);
    // Ripples drift downstream.
    vec2 flow = vec2(vTrack.y * 1.5 - uTime * 1.2, vTrack.x * 4.0);
    vec2 ripple = (vec2(gtNoise(flow), gtNoise(flow * 1.7 + 4.0)) - 0.5) * 0.16;
    float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(viewDir, normalize(vec3(ripple.x, 1.0, ripple.y))), 0.0), 5.0);
    vec3 sky = tLin(vec3(0.62, 0.72, 0.84));
    float water = 1.0 - smoothstep(-0.25, -0.05, e);
    vec3 wet = mix(stones * 0.45, sky, fresnel * 0.85);
    surf = mix(mix(mud, stones, 0.15), stones, inBed);
    surf = mix(surf, wet, water);
    core = max(wetBank * 0.85, inBed);
    besideCol = tLin(vec3(0.2, 0.21, 0.15));
    beside = (1.0 - smoothstep(0.4, 2.0, e)) * 0.35;
  } else {
    // Water channel: a wet, muddy ditch with a thin trickle in the middle.
    vec3 mud = gtx(GT_SOIL, uv * 1.3) * vec3(0.6, 0.55, 0.46);
    float trickle = 1.0 - smoothstep(0.08, 0.2, am + (fine - 0.5) * 0.1);
    vec3 viewDir = normalize(cameraPosition - vTrackPos);
    float fresnel = 0.04 + 0.96 * pow(1.0 - max(viewDir.y, 0.0), 5.0);
    surf = mix(mud, tLin(vec3(0.55, 0.65, 0.76)) * fresnel + mud * 0.3, trickle * 0.8);
    core = 1.0 - smoothstep(-0.15, 0.1, e);
    besideCol = tLin(vec3(0.2, 0.21, 0.15));
    beside = (1.0 - smoothstep(0.0, 1.0, e)) * 0.3;
  }
  surf *= 0.9 + 0.2 * fine;
  core = clamp(core, 0.0, 1.0);
  float alpha = core + (1.0 - core) * beside;
  vec3 col = (surf * core + besideCol * beside * (1.0 - core)) / max(alpha, 1e-4);
  diffuseColor = vec4(col, clamp(alpha, 0.0, 1.0));
`

function createTrackMaterial(kind: string, gfx: Gfx): THREE.MeshLambertMaterial {
  const style = STYLES[kind] ?? STYLES['path']!
  const material = new THREE.MeshLambertMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  })
  material.onBeforeCompile = shader => {
    shader.uniforms['trackKind'] = { value: style.id }
    shader.uniforms['groundTex'] = { value: gfx.groundArray }
    shader.uniforms['uTime'] = gfx.time
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 trackUv;\nvarying vec3 vTrack;\nvarying vec3 vTrackPos;',
      )
      .replace(
        '#include <project_vertex>',
        `vTrack = trackUv;
        vec4 trackWorld = modelMatrix * vec4(transformed, 1.0);
        vTrackPos = trackWorld.xyz;
        // Coarse distant terrain can rise above the strip; lift it a little with distance.
        transformed.y += distance(trackWorld.xyz, cameraPosition) * 0.002;
        #include <project_vertex>`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SHADER_COMMON)
      .replace('#include <map_fragment>', SHADER_MAIN)
  }
  material.customProgramCacheKey = () => 'terraino-track-v2'
  return material
}

/** Accumulates strip geometry for one track style. */
class StripBuilder {
  readonly positions: number[] = []
  readonly normals: number[] = []
  readonly uvs: number[] = []
  readonly indices: number[] = []

  vertex(x: number, y: number, z: number, normal: THREE.Vector3, across: number, along: number, half: number): number {
    this.positions.push(x, y, z)
    this.normals.push(normal.x, normal.y, normal.z)
    this.uvs.push(across, along, half)
    return this.positions.length / 3 - 1
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    g.setAttribute('trackUv', new THREE.Float32BufferAttribute(this.uvs, 3))
    g.setIndex(this.indices)
    g.computeBoundingSphere()
    return g
  }
}

/**
 * Evenly spaced points along a polyline, SAMPLE_M apart (both ends included).
 *
 * The map's own vertices are not kept: curves flattened by OCAD have vertices very close
 * together, and a strip through them folds over itself and shows as a line across it.
 */
function resample(points: [number, number][]): { x: number; z: number; d: number }[] {
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) {
    const [x0, z0] = points[i - 1]!
    const [x1, z1] = points[i]!
    cumulative.push(cumulative[i - 1]! + Math.hypot(x1 - x0, z1 - z0))
  }
  const total = cumulative[cumulative.length - 1]!
  const count = Math.max(1, Math.round(total / SAMPLE_M))
  const out: { x: number; z: number; d: number }[] = []
  let seg = 0
  for (let k = 0; k <= count; k++) {
    const d = (k / count) * total
    while (seg < points.length - 2 && cumulative[seg + 1]! < d) seg++
    const [x0, z0] = points[seg]!
    const [x1, z1] = points[seg + 1]!
    const len = cumulative[seg + 1]! - cumulative[seg]!
    const t = len > 0 ? (d - cumulative[seg]!) / len : 0
    out.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, d })
  }
  return out
}

interface Segment {
  x0: number
  z0: number
  x1: number
  z1: number
  half: number
  kind: string
}

// Grid cell for finding where paths cross streams, and for keeping footbridges apart.
const CROSSING_CELL = 16
const BRIDGE_SPACING = 5

/** Where a path segment (`path.points[i]` to `[i + 1]`) crosses a stream segment (`water.points[j]` …). */
export interface Crossing {
  path: TrackRecord
  i: number
  water: TrackRecord
  j: number
  /** How far along the path segment the crossing is, 0–1. */
  t: number
}

const cellOf = (v: number, size: number) => Math.floor(v / size)
const cellKey = (gx: number, gz: number) => gx * 100003 + gz

/**
 * Every crossing of a path segment with a stream segment, in the order of the paths and their
 * segments, then the streams and theirs. Stream segments are put in a grid, so each path
 * segment is tested only against the stream segments near it.
 */
export function findCrossings(paths: TrackRecord[], water: TrackRecord[]): Crossing[] {
  // Stream segments by grid cell, numbered in stream order so that results keep that order.
  const segments: { w: TrackRecord; j: number }[] = []
  const grid = new Map<number, number[]>()
  for (const w of water) {
    for (let j = 0; j + 1 < w.points.length; j++) {
      const [cx, cz] = w.points[j]!
      const [dx, dz] = w.points[j + 1]!
      const id = segments.push({ w, j }) - 1
      for (let gx = cellOf(Math.min(cx, dx), CROSSING_CELL); gx <= cellOf(Math.max(cx, dx), CROSSING_CELL); gx++) {
        for (let gz = cellOf(Math.min(cz, dz), CROSSING_CELL); gz <= cellOf(Math.max(cz, dz), CROSSING_CELL); gz++) {
          const key = cellKey(gx, gz)
          const list = grid.get(key)
          if (list) list.push(id)
          else grid.set(key, [id])
        }
      }
    }
  }
  const found: Crossing[] = []
  const candidates = new Set<number>()
  for (const p of paths) {
    for (let i = 0; i + 1 < p.points.length; i++) {
      const [ax, az] = p.points[i]!
      const [bx, bz] = p.points[i + 1]!
      candidates.clear()
      for (let gx = cellOf(Math.min(ax, bx), CROSSING_CELL); gx <= cellOf(Math.max(ax, bx), CROSSING_CELL); gx++) {
        for (let gz = cellOf(Math.min(az, bz), CROSSING_CELL); gz <= cellOf(Math.max(az, bz), CROSSING_CELL); gz++) {
          for (const id of grid.get(cellKey(gx, gz)) ?? []) candidates.add(id)
        }
      }
      for (const id of [...candidates].sort((a, b) => a - b)) {
        const { w, j } = segments[id]!
        const [cx, cz] = w.points[j]!
        const [dx, dz] = w.points[j + 1]!
        const rx = bx - ax
        const rz = bz - az
        const sx = dx - cx
        const sz = dz - cz
        const den = rx * sz - rz * sx
        if (Math.abs(den) < 1e-9) continue
        const t = ((cx - ax) * sz - (cz - az) * sx) / den
        const u = ((cx - ax) * rz - (cz - az) * rx) / den
        if (t < 0 || t > 1 || u < 0 || u > 1) continue
        found.push({ path: p, i, water: w, j, t })
      }
    }
  }
  return found
}

/** A footbridge where a path crosses a stream. */
interface Bridge {
  x: number
  z: number
  /** Unit vector along the path. */
  ux: number
  uz: number
  halfLength: number
  width: number
  deck: number
  /** Just a few logs side by side (over minor water channels), no planks. */
  logs: boolean
}

/** Roads, paths and streams drawn as soft strips on the terrain, with footbridges. */
export class Tracks {
  readonly group = new THREE.Group()
  private readonly heights: HeightField
  private readonly gfx: Gfx
  private readonly index = new Map<number, Segment[]>()
  private readonly normal = new THREE.Vector3()
  private readonly bridges: Bridge[] = []
  /** The strip meshes, one per kind and tile, and how far they are drawn. */
  private readonly strips: THREE.Mesh[] = []
  private reach = Infinity
  private checkedAt: THREE.Vector3 | null = null

  private constructor(heights: HeightField, gfx: Gfx) {
    this.heights = heights
    this.gfx = gfx
    this.group.name = 'tracks'
  }

  static async load(world: World, heights: HeightField, gfx: Gfx): Promise<Tracks | null> {
    const info = world.manifest.tracks
    if (!info) return null
    const response = await fetch(world.url(info.path))
    if (!response.ok) return null
    const tracks = new Tracks(heights, gfx)
    const records = (await response.json()) as TrackRecord[]
    tracks.build(records)
    tracks.buildBridges(records)
    return tracks
  }

  setQuality(quality: QualitySettings) {
    this.reach = quality.tracks
    this.checkedAt = null
  }

  /** Draw the strips within reach of `eye`; the ground paints the tracks beyond. */
  update(eye: THREE.Vector3) {
    if (this.checkedAt && this.checkedAt.distanceTo(eye) < STRIP_RECHECK_M) return
    this.checkedAt = eye.clone()
    for (const strip of this.strips) {
      const sphere = strip.geometry.boundingSphere!
      strip.visible = sphere.center.distanceTo(eye) - sphere.radius < this.reach + STRIP_RECHECK_M
    }
  }

  /** Add a vertex on the ground at (x, z), lit like the terrain there. */
  private ground(b: StripBuilder, x: number, z: number, across: number, along: number, half: number): number {
    const h = this.heights
    const y = h.heightAt(x, z) + LIFT_M
    this.normal.set(h.heightAt(x - 1, z) - h.heightAt(x + 1, z), 2, h.heightAt(x, z - 1) - h.heightAt(x, z + 1)).normalize()
    return b.vertex(x, y, z, this.normal, across, along, half)
  }

  private build(records: TrackRecord[]) {
    // One mesh per kind and tile, so tracks out of view are culled.
    const builders = new Map<string, { kind: string; builder: StripBuilder }>()
    for (const record of records) {
      if (record.points.length < 2) continue
      const [x, z] = record.points[Math.floor(record.points.length / 2)]!
      const key = `${record.kind}:${Math.floor(x / TILE_M)}_${Math.floor(z / TILE_M)}`
      let entry = builders.get(key)
      if (!entry) builders.set(key, (entry = { kind: record.kind, builder: new StripBuilder() }))
      this.addStrip(entry.builder, record)
      this.addToIndex(record)
    }
    const materials = new Map<string, THREE.Material>()
    for (const { kind, builder } of builders.values()) {
      let material = materials.get(kind)
      if (!material) materials.set(kind, (material = createTrackMaterial(kind, this.gfx)))
      const mesh = new THREE.Mesh(builder.build(), material)
      mesh.geometry.computeBoundingSphere()
      mesh.receiveShadow = true
      mesh.renderOrder = (STYLES[kind] ?? STYLES['path']!).order
      this.strips.push(mesh)
      this.group.add(mesh)
    }
  }

  private addStrip(b: StripBuilder, record: TrackRecord) {
    const half = record.width / 2
    const outer = half + (STYLES[record.kind] ?? STYLES['path']!).margin
    const samples = resample(record.points)
    if (samples[samples.length - 1]!.d <= 0) return // no length
    const columns = Math.max(2, 2 * Math.ceil(outer / ACROSS_M))
    let previous: number[] | null = null
    let lastNormal: [number, number] = [0, 1]
    samples.forEach((s, i) => {
      const a = samples[Math.max(i - 1, 0)]!
      const c = samples[Math.min(i + 1, samples.length - 1)]!
      // Mitred offset: the average of the neighbouring segments' normals, scaled so the
      // strip keeps its width through bends.
      const n1 = this.segmentNormal(a, s)
      const n2 = this.segmentNormal(s, c)
      // Repeated points have no direction; keep the last one.
      const m1 = n1 ?? n2 ?? lastNormal
      const m2 = n2 ?? n1 ?? lastNormal
      lastNormal = m2
      let nx = m1[0] + m2[0]
      let nz = m1[1] + m2[1]
      const len = Math.hypot(nx, nz) || 1
      nx /= len
      nz /= len
      const cos = n1 && n2 ? Math.max(nx * m1[0] + nz * m1[1], 1 / MAX_MITER) : 1
      const w = outer / cos
      const row: number[] = []
      for (let k = 0; k <= columns; k++) {
        const u = -1 + (2 * k) / columns
        row.push(this.ground(b, s.x - nx * w * u, s.z - nz * w * u, u * outer, s.d, half))
      }
      if (previous) {
        for (let k = 0; k < columns; k++) {
          // Wound to face up (scene z points south).
          b.indices.push(previous[k]!, row[k]!, previous[k + 1]!, previous[k + 1]!, row[k]!, row[k + 1]!)
        }
      }
      previous = row
    })
    // Rounded ends (half discs beyond the end only, so nothing is drawn twice).
    this.addCap(b, samples[0]!, samples[1]!, outer, half)
    this.addCap(b, samples[samples.length - 1]!, samples[samples.length - 2]!, outer, half)
  }

  private segmentNormal(a: { x: number; z: number }, b: { x: number; z: number }): [number, number] | null {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    return len > 1e-6 ? [-dz / len, dx / len] : null
  }

  /** Half disc at `end`, bulging away from `inner`. */
  private addCap(
    b: StripBuilder,
    end: { x: number; z: number; d: number },
    inner: { x: number; z: number },
    radius: number,
    half: number,
  ) {
    const ox = end.x - inner.x
    const oz = end.z - inner.z
    const len = Math.hypot(ox, oz) || 1
    const out = Math.atan2(oz / len, ox / len)
    const centre = this.ground(b, end.x, end.z, 0, end.d, half)
    const rim: number[] = []
    for (let k = 0; k <= CAP_SEGMENTS; k++) {
      const a = out - Math.PI / 2 + (k / CAP_SEGMENTS) * Math.PI
      rim.push(this.ground(b, end.x + Math.cos(a) * radius, end.z + Math.sin(a) * radius, radius, end.d, half))
    }
    for (let k = 0; k < CAP_SEGMENTS; k++) {
      // Face up whichever way the rim runs.
      const [p, q] = [rim[k]!, rim[k + 1]!]
      const pos = b.positions
      const ax = pos[p * 3]! - pos[centre * 3]!
      const az = pos[p * 3 + 2]! - pos[centre * 3 + 2]!
      const bx = pos[q * 3]! - pos[centre * 3]!
      const bz = pos[q * 3 + 2]! - pos[centre * 3 + 2]!
      if (az * bx - ax * bz > 0) b.indices.push(centre, p, q)
      else b.indices.push(centre, q, p)
    }
  }

  private cellKey(gx: number, gz: number) {
    return gx * 100003 + gz
  }

  private addToIndex(record: TrackRecord) {
    const half = record.width / 2
    for (let i = 0; i + 1 < record.points.length; i++) {
      const [x0, z0] = record.points[i]!
      const [x1, z1] = record.points[i + 1]!
      const segment: Segment = { x0, z0, x1, z1, half, kind: record.kind }
      const pad = half + 2
      for (let gx = Math.floor((Math.min(x0, x1) - pad) / INDEX_CELL); gx <= Math.floor((Math.max(x0, x1) + pad) / INDEX_CELL); gx++) {
        for (let gz = Math.floor((Math.min(z0, z1) - pad) / INDEX_CELL); gz <= Math.floor((Math.max(z0, z1) + pad) / INDEX_CELL); gz++) {
          const key = this.cellKey(gx, gz)
          let list = this.index.get(key)
          if (!list) this.index.set(key, (list = []))
          list.push(segment)
        }
      }
    }
  }

  private static distance(s: Segment, x: number, z: number): number {
    const dx = s.x1 - s.x0
    const dz = s.z1 - s.z0
    const t = Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / (dx * dx + dz * dz || 1)))
    return Math.hypot(x - (s.x0 + dx * t), z - (s.z0 + dz * t))
  }

  /** True if (x, z) is on a road, path or stream, or within `margin` metres of its edge. */
  near(x: number, z: number, margin: number): boolean {
    const list = this.index.get(this.cellKey(Math.floor(x / INDEX_CELL), Math.floor(z / INDEX_CELL)))
    if (!list) return false
    for (const s of list) if (Tracks.distance(s, x, z) <= s.half + margin) return true
    return false
  }

  /** The nearest point within `maxDistance` on a track of one of `kinds`, or null. */
  nearestPoint(x: number, z: number, maxDistance: number, kinds: ReadonlySet<string>): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null
    let bestDistance = maxDistance
    const g0x = Math.floor((x - maxDistance) / INDEX_CELL)
    const g1x = Math.floor((x + maxDistance) / INDEX_CELL)
    const g0z = Math.floor((z - maxDistance) / INDEX_CELL)
    const g1z = Math.floor((z + maxDistance) / INDEX_CELL)
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        for (const s of this.index.get(this.cellKey(gx, gz)) ?? []) {
          if (!kinds.has(s.kind)) continue
          const d = Tracks.distance(s, x, z)
          if (d >= bestDistance) continue
          const dx = s.x1 - s.x0
          const dz = s.z1 - s.z0
          const t = Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / (dx * dx + dz * dz || 1)))
          best = { x: s.x0 + dx * t, z: s.z0 + dz * t }
          bestDistance = d
        }
      }
    }
    return best
  }

  /** Distance from (x, z) to the edge of the nearest track within 2 m, and its kind. */
  edgeDistance(x: number, z: number): { distance: number; kind: string } | null {
    const list = this.index.get(this.cellKey(Math.floor(x / INDEX_CELL), Math.floor(z / INDEX_CELL)))
    if (!list) return null
    let best: { distance: number; kind: string } | null = null
    for (const s of list) {
      const d = Tracks.distance(s, x, z) - s.half
      if (d < 2 && (!best || d < best.distance)) best = { distance: d, kind: s.kind }
    }
    return best
  }

  /** Find where footpaths cross streams and put a footbridge there. */
  private buildBridges(records: TrackRecord[]) {
    const water = records.filter(r => BRIDGED_WATER.has(r.kind))
    const paths = records.filter(r => FOOTPATHS.has(r.kind))
    const found: (Bridge & { order: number })[] = []
    for (const { path: p, i, water: w, j, t } of findCrossings(paths, water)) {
      const [ax, az] = p.points[i]!
      const [bx, bz] = p.points[i + 1]!
      const [cx, cz] = w.points[j]!
      const [dx, dz] = w.points[j + 1]!
      const rx = bx - ax
      const rz = bz - az
      const sx = dx - cx
      const sz = dz - cz
      const len = Math.hypot(rx, rz)
      const ux = rx / len
      const uz = rz / len
      // The channel is longer along the path when it is crossed at a slant.
      const sin = Math.max(0.45, Math.abs(ux * sz - uz * sx) / Math.hypot(sx, sz))
      const logs = w.kind === 'water_channel'
      const halfLength = (w.width / 2 + (logs ? 0.7 : 1.0)) / sin
      const x = ax + rx * t
      const z = az + rz * t
      const bank = Math.max(
        this.heights.heightAt(x + ux * (halfLength + 0.6), z + uz * (halfLength + 0.6)),
        this.heights.heightAt(x - ux * (halfLength + 0.6), z - uz * (halfLength + 0.6)),
        this.heights.heightAt(x, z) + (logs ? 0.15 : 0.45),
      )
      found.push({
        x,
        z,
        ux,
        uz,
        halfLength,
        width: logs ? 0.6 : p.kind === 'path' ? 1.1 : 0.8,
        deck: bank + (logs ? 0.08 : 0.12),
        logs,
        order: p.kind === 'path' ? 2 : 1,
      })
    }
    // One bridge per crossing, the widest path's; nearby bridges are found through a grid.
    found.sort((a, b) => b.order - a.order)
    const placed = new Map<number, Bridge[]>()
    for (const c of found) {
      const gx = cellOf(c.x, BRIDGE_SPACING)
      const gz = cellOf(c.z, BRIDGE_SPACING)
      let taken = false
      for (let x = gx - 1; x <= gx + 1 && !taken; x++) {
        for (let z = gz - 1; z <= gz + 1 && !taken; z++) {
          taken = (placed.get(cellKey(x, z)) ?? []).some(k => Math.hypot(k.x - c.x, k.z - c.z) < BRIDGE_SPACING)
        }
      }
      if (taken) continue
      this.bridges.push(c)
      const key = cellKey(gx, gz)
      const list = placed.get(key)
      if (list) list.push(c)
      else placed.set(key, [c])
    }
    if (this.bridges.length) this.group.add(this.bridgeMeshes())
  }

  /** Planks across two log beams, with a hand rail on longer spans; or just logs. */
  private bridgeMeshes(): THREE.Group {
    const group = new THREE.Group()
    group.name = 'footbridges'
    const t = this.gfx.textures
    const planks = new THREE.MeshLambertMaterial({ map: t.boards, color: new THREE.Color(0.55, 0.45, 0.35) })
    const bark = new THREE.MeshLambertMaterial({ map: t.bark.spruce, color: new THREE.Color(0.75, 0.68, 0.6) })
    const plankGeo = new THREE.BoxGeometry(0.2, 0.05, 1)
    const beamGeo = new THREE.CylinderGeometry(0.1, 0.11, 1, 8)
    beamGeo.rotateZ(Math.PI / 2)
    const postGeo = new THREE.BoxGeometry(0.08, 0.95, 0.08)
    const railGeo = new THREE.BoxGeometry(1, 0.07, 0.07)
    const parts: { geo: THREE.BufferGeometry; mat: THREE.Material; m: THREE.Matrix4; tint: number }[] = []
    const quat = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const rnd = (k: number, salt: number) => {
      const h = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453
      return h - Math.floor(h)
    }
    this.bridges.forEach((c, bi) => {
      const yaw = -Math.atan2(c.uz, c.ux)
      const length = c.halfLength * 2 + 0.4
      const along = (s: number, side: number, y: number) =>
        new THREE.Vector3(c.x + c.ux * s - c.uz * side, y, c.z + c.uz * s + c.ux * side)
      if (c.logs) {
        // Three logs side by side, a little askew.
        for (let k = -1; k <= 1; k++) {
          quat.setFromAxisAngle(up, yaw + (rnd(bi * 31 + k, 5) - 0.5) * 0.08)
          const m = new THREE.Matrix4().compose(
            along((rnd(bi * 31 + k, 6) - 0.5) * 0.3, k * 0.2, c.deck - 0.1),
            quat,
            new THREE.Vector3(length + 0.4 * rnd(bi * 31 + k, 7), 1, 1),
          )
          parts.push({ geo: beamGeo, mat: bark, m, tint: 0.85 + 0.25 * rnd(bi * 31 + k, 8) })
        }
        return
      }
      const n = Math.max(3, Math.round(length / 0.24))
      for (let k = 0; k < n; k++) {
        const s = -length / 2 + ((k + 0.5) * length) / n
        quat.setFromAxisAngle(up, yaw + (rnd(bi * 97 + k, 1) - 0.5) * 0.06)
        const m = new THREE.Matrix4().compose(
          along(s, 0, c.deck - 0.025 + (rnd(bi * 97 + k, 2) - 0.5) * 0.015),
          quat,
          new THREE.Vector3(1, 1, c.width * (0.95 + 0.1 * rnd(bi * 97 + k, 3))),
        )
        parts.push({ geo: plankGeo, mat: planks, m, tint: 0.8 + 0.35 * rnd(bi * 97 + k, 4) })
      }
      quat.setFromAxisAngle(up, yaw)
      for (const side of [-1, 1]) {
        const m = new THREE.Matrix4().compose(
          along(0, side * c.width * 0.32, c.deck - 0.15),
          quat,
          new THREE.Vector3(length + 0.6, 1, 1),
        )
        parts.push({ geo: beamGeo, mat: bark, m, tint: 1 })
      }
      if (length > 4.2) {
        const side = c.width / 2 + 0.05
        parts.push({
          geo: railGeo,
          mat: bark,
          m: new THREE.Matrix4().compose(along(0, side, c.deck + 0.9), quat, new THREE.Vector3(length, 1, 1)),
          tint: 1,
        })
        for (let s = -length / 2 + 0.2; s <= length / 2; s += 1.8) {
          parts.push({
            geo: postGeo,
            mat: bark,
            m: new THREE.Matrix4().compose(along(s, side, c.deck + 0.45), quat, new THREE.Vector3(1, 1, 1)),
            tint: 1,
          })
        }
      }
    })
    // One instanced mesh per (geometry, material).
    const groups = new Map<string, typeof parts>()
    for (const p of parts) {
      const key = `${p.geo.uuid}:${p.mat.uuid}`
      let list = groups.get(key)
      if (!list) groups.set(key, (list = []))
      list.push(p)
    }
    const color = new THREE.Color()
    for (const list of groups.values()) {
      const mesh = new THREE.InstancedMesh(list[0]!.geo, list[0]!.mat, list.length)
      list.forEach((p, i) => {
        mesh.setMatrixAt(i, p.m)
        mesh.setColorAt(i, color.setScalar(p.tint))
      })
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
    return group
  }

  /** Height of a bridge deck at (x, z), or null. */
  deckAt(x: number, z: number): number | null {
    for (const c of this.bridges) {
      const dx = x - c.x
      const dz = z - c.z
      if (dx * dx + dz * dz > (c.halfLength + 1) ** 2) continue
      const u = dx * c.ux + dz * c.uz
      const v = -dx * c.uz + dz * c.ux
      if (Math.abs(u) <= c.halfLength + 0.2 && Math.abs(v) <= c.width / 2 + 0.1) return c.deck
    }
    return null
  }
}
