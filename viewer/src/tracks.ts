import * as THREE from 'three'
import type { HeightField } from './heightfield'
import type { World } from './world'

export interface TrackRecord {
  kind: string
  width: number
  points: [number, number][]
}

/**
 * Look of each kind (otest.process.symbols.TRACKS). Strips are partly transparent and
 * fade out towards their edges, so they blend into the ground like worn earth:
 * `opacity` in the middle, fading from `fade` (0 = centre, 1 = edge) outwards.
 */
const STYLES: Record<string, { id: number; colour: number; opacity: number; fade: number; order: number }> = {
  paved: { id: 0, colour: 0x48484b, opacity: 0.97, fade: 0.8, order: 1 },
  gravel: { id: 1, colour: 0x7f776a, opacity: 0.92, fade: 0.65, order: 2 },
  vehicle_track: { id: 2, colour: 0x6f5e4a, opacity: 0.85, fade: 0.5, order: 3 },
  path: { id: 3, colour: 0x86705a, opacity: 0.8, fade: 0.35, order: 4 },
  small_path: { id: 4, colour: 0x86705a, opacity: 0.7, fade: 0.3, order: 5 },
  faint_path: { id: 5, colour: 0x7a6853, opacity: 0.6, fade: 0.25, order: 6 },
  // Water lines: dark water reflecting the sky; a water channel is wet earth with a
  // thin trickle in the middle. Drawn below paths, so a path crossing a stream shows.
  stream: { id: 6, colour: 0x1f2d30, opacity: 0.95, fade: 0.6, order: 0 },
  small_stream: { id: 7, colour: 0x1f2d30, opacity: 0.9, fade: 0.45, order: 0 },
  water_channel: { id: 8, colour: 0x3a3127, opacity: 0.8, fade: 0.35, order: 0 },
}
const SAMPLE_M = 1.0
const LIFT_M = 0.06
// At most this far between vertices across a strip, so it follows the ground's shape.
const ACROSS_M = 1.0
const CAP_SEGMENTS = 6
const MAX_MITER = 2
const INDEX_CELL = 8

const SHADER_COMMON = /* glsl */ `
uniform int trackKind;
uniform float trackOpacity;
uniform float trackFade;
varying vec2 vTrackUv;
varying vec3 vTrackPos;

float tHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
}
`

const SHADER_MAIN = /* glsl */ `
  float across = abs(vTrackUv.x);
  vec2 tp = vTrackPos.xz;
  float fine = tNoise(tp * 3.1);
  float patches = tNoise(tp * 0.45 + 13.0);
  // Ragged, uneven edges instead of a ruler-straight border.
  float edge = across + (tNoise(tp * 1.3 + 7.0) - 0.5) * 0.35;
  vec3 col = diffuse * (0.86 + 0.2 * fine + 0.12 * patches);
  float alpha = trackOpacity * (1.0 - smoothstep(trackFade, 1.0, edge));
  if (trackKind == 2) {
    // Vehicle track: two bare ruts; the ground shows in the middle and at the sides.
    float rut = smoothstep(0.15, 0.32, edge) * (1.0 - smoothstep(0.62, 0.85, edge));
    alpha = trackOpacity * rut;
  } else if (trackKind >= 6) {
    // Water: sky reflection grows towards grazing angles; small ripples break it up.
    vec3 viewDir = normalize(cameraPosition - vTrackPos);
    vec2 ripple = (vec2(tNoise(tp * 6.0), tNoise(tp * 6.0 + 4.0)) - 0.5) * 0.12;
    float fresnel = 0.05 + 0.95 * pow(1.0 - max(dot(viewDir, normalize(vec3(ripple.x, 1.0, ripple.y))), 0.0), 5.0);
    vec3 sky = vec3(0.45, 0.58, 0.72);
    float water = trackKind == 8 ? 1.0 - smoothstep(0.12, 0.3, edge + (fine - 0.5) * 0.2) : 1.0;
    col = mix(col, mix(diffuse, sky, fresnel), water);
    if (trackKind == 8) alpha *= 0.85 + 0.15 * water;
  } else if (trackKind >= 3) {
    // Footpaths: the trodden middle is barest; patches of the ground show through.
    alpha *= 0.75 + 0.25 * smoothstep(0.25, 0.6, patches + 0.3 * fine);
  }
  diffuseColor = vec4(col, clamp(alpha, 0.0, 1.0));
`

function createTrackMaterial(kind: string): THREE.MeshLambertMaterial {
  const style = STYLES[kind] ?? STYLES['path']!
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(style.colour),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  })
  material.onBeforeCompile = shader => {
    shader.uniforms['trackKind'] = { value: style.id }
    shader.uniforms['trackOpacity'] = { value: style.opacity }
    shader.uniforms['trackFade'] = { value: style.fade }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 trackUv;\nvarying vec2 vTrackUv;\nvarying vec3 vTrackPos;',
      )
      .replace(
        '#include <project_vertex>',
        `vTrackUv = trackUv;
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
  material.customProgramCacheKey = () => 'otest-track'
  return material
}

/** Accumulates strip geometry for one track style. */
class StripBuilder {
  readonly positions: number[] = []
  readonly normals: number[] = []
  readonly uvs: number[] = []
  readonly indices: number[] = []

  vertex(x: number, y: number, z: number, normal: THREE.Vector3, u: number, v: number): number {
    this.positions.push(x, y, z)
    this.normals.push(normal.x, normal.y, normal.z)
    this.uvs.push(u, v)
    return this.positions.length / 3 - 1
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    g.setAttribute('trackUv', new THREE.Float32BufferAttribute(this.uvs, 2))
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

/** Roads and paths drawn as soft strips on the terrain, plus a lookup for "is this on a path". */
export class Tracks {
  readonly group = new THREE.Group()
  private readonly heights: HeightField
  private readonly index = new Map<number, [number, number, number, number, number][]>()
  private readonly normal = new THREE.Vector3()

  private constructor(heights: HeightField) {
    this.heights = heights
    this.group.name = 'tracks'
  }

  static async load(world: World, heights: HeightField): Promise<Tracks | null> {
    const info = world.manifest.tracks
    if (!info) return null
    const response = await fetch(world.url(info.path))
    if (!response.ok) return null
    const tracks = new Tracks(heights)
    tracks.build((await response.json()) as TrackRecord[])
    return tracks
  }

  /** Add a vertex on the ground at (x, z), lit like the terrain there. */
  private ground(b: StripBuilder, x: number, z: number, u: number, v: number): number {
    const h = this.heights
    const y = h.heightAt(x, z) + LIFT_M
    this.normal.set(h.heightAt(x - 1, z) - h.heightAt(x + 1, z), 2, h.heightAt(x, z - 1) - h.heightAt(x, z + 1)).normalize()
    return b.vertex(x, y, z, this.normal, u, v)
  }

  private build(records: TrackRecord[]) {
    const builders = new Map<string, StripBuilder>()
    for (const record of records) {
      if (record.points.length < 2) continue
      let builder = builders.get(record.kind)
      if (!builder) builders.set(record.kind, (builder = new StripBuilder()))
      this.addStrip(builder, record)
      this.addToIndex(record)
    }
    for (const [kind, builder] of builders) {
      const mesh = new THREE.Mesh(builder.build(), createTrackMaterial(kind))
      mesh.receiveShadow = true
      // Paths are drawn after (on top of) the roads they cross.
      mesh.renderOrder = (STYLES[kind] ?? STYLES['path']!).order
      this.group.add(mesh)
    }
  }

  private addStrip(b: StripBuilder, record: TrackRecord) {
    const half = record.width / 2
    const samples = resample(record.points)
    if (samples[samples.length - 1]!.d <= 0) return // no length
    const columns = Math.max(2, 2 * Math.ceil(record.width / (2 * ACROSS_M)))
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
      const w = half / cos
      const row: number[] = []
      for (let k = 0; k <= columns; k++) {
        const u = -1 + (2 * k) / columns
        row.push(this.ground(b, s.x - nx * w * u, s.z - nz * w * u, u, s.d))
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
    this.addCap(b, samples[0]!, samples[1]!, half)
    this.addCap(b, samples[samples.length - 1]!, samples[samples.length - 2]!, half)
  }

  private segmentNormal(a: { x: number; z: number }, b: { x: number; z: number }): [number, number] | null {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    return len > 1e-6 ? [-dz / len, dx / len] : null
  }

  /** Half disc at `end`, bulging away from `inner`. */
  private addCap(b: StripBuilder, end: { x: number; z: number; d: number }, inner: { x: number; z: number }, radius: number) {
    const ox = end.x - inner.x
    const oz = end.z - inner.z
    const len = Math.hypot(ox, oz) || 1
    const out = Math.atan2(oz / len, ox / len)
    const centre = this.ground(b, end.x, end.z, 0, end.d)
    const rim: number[] = []
    for (let k = 0; k <= CAP_SEGMENTS; k++) {
      const a = out - Math.PI / 2 + (k / CAP_SEGMENTS) * Math.PI
      rim.push(this.ground(b, end.x + Math.cos(a) * radius, end.z + Math.sin(a) * radius, 1, end.d))
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
      const segment: [number, number, number, number, number] = [x0, z0, x1, z1, half]
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

  /** True if (x, z) is on a road or path, or within `margin` metres of its edge. */
  near(x: number, z: number, margin: number): boolean {
    const list = this.index.get(this.cellKey(Math.floor(x / INDEX_CELL), Math.floor(z / INDEX_CELL)))
    if (!list) return false
    for (const [x0, z0, x1, z1, half] of list) {
      const dx = x1 - x0
      const dz = z1 - z0
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz || 1)))
      if (Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)) <= half + margin) return true
    }
    return false
  }
}
