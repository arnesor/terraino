import * as THREE from 'three'
import type { HeightField } from './heightfield'
import { t } from './i18n'
import type { ImportedCourse } from './ocad/courses'
import type { World } from './world'

/** A control in projected coordinates (easting, northing). */
export type Control = [number, number]

/** Start, controls and finish, in running order. */
export interface Course {
  /** Centres of the start triangle, control circles and finish. */
  controls: Control[]
  /** The course from an OCAD file, with codes and control descriptions. */
  imported?: ImportedCourse
  /** Where each flag stands (projected), when it is not at the circle centre. */
  flags?: Control[]
  /** The other controls in the OCAD file: they stand in the terrain too, but are not punched. */
  others?: OtherControl[]
}

export interface OtherControl {
  code: string
  /** Centre of the control circle (the control feature). */
  position: Control
  /** Where the flag stands. */
  flag: Control
}

const PUNCH_DISTANCE = 2.5
const START_LEAVE_DISTANCE = 3
const STORAGE_PREFIX = 'otest.course.'
const ORANGE = new THREE.Color(0xf26a1b)
const WHITE = new THREE.Color(0xf4f4f0)
const STAND = new THREE.Color(0x777777)
// The flag's pole stands this far from its centre; the code plates hang on it.
const FLAG_SIZE = 0.3
const POLE_X = FLAG_SIZE * 0.35
const POLE_RADIUS = 0.015
const PLATE_SIZE: [number, number] = [0.36, 0.18]
const PLATE_HEIGHT = 0.62
// How far behind the start banner the runner is put when a course is opened.
const START_VIEW_DISTANCES = [8, 6, 10, 4, 12]
// Start and finish banners: two poles with a cloth between them, across the course.
const BANNER_WIDTH = 3
const BANNER_POLE = 2.4
const BANNER_CLOTH = 0.6
const BANNER_ORANGE = '#e8611a'
// The start and finish flags stand this far beside the banner.
const BANNER_FLAG_OFFSET = BANNER_WIDTH / 2 + 0.5
// Where to try a banner (along the course, across it) when its own spot is taken by a building.
const BANNER_SHIFTS: [number, number][] = [-6, -4, -3, -2, -1, 0, 1, 2, 3, 4, 6]
  .flatMap(along => [-3, -1.5, 0, 1.5, 3].map((across): [number, number] => [along, across]))
  .sort((a, b) => Math.hypot(...a) - Math.hypot(...b))

/** Course as text for a URL parameter: "E,N;E,N;...". */
export function encodeCourse(course: Course): string {
  return course.controls.map(([e, n]) => `${Math.round(e)},${Math.round(n)}`).join(';')
}

export function decodeCourse(text: string): Course | null {
  const controls = text
    .split(';')
    .map(pair => pair.split(',').map(Number))
    .filter(p => p.length === 2 && p.every(Number.isFinite)) as Control[]
  return controls.length ? { controls } : null
}

export function loadCourse(world: World): Course {
  const fromUrl = new URLSearchParams(location.search).get('course')
  const decoded = fromUrl ? decodeCourse(fromUrl) : null
  if (decoded) return decoded
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + world.manifest.name)
    if (stored) return JSON.parse(stored) as Course
  } catch {
    // Storage can be unavailable (private mode); start with an empty course.
  }
  return { controls: [] }
}

export function saveCourse(world: World, course: Course) {
  try {
    localStorage.setItem(STORAGE_PREFIX + world.manifest.name, JSON.stringify(course))
  } catch {
    // Not saved, but the course still works for this session.
  }
}

/** Orange and white control flag on a stand: three panels forming a prism. */
function flagGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const size = FLAG_SIZE
  const top = 1.15
  const corners = [0, 1, 2].map(i => {
    const a = (i / 3) * Math.PI * 2
    return new THREE.Vector2(Math.cos(a) * size * 0.58, Math.sin(a) * size * 0.58)
  })
  for (let i = 0; i < 3; i++) {
    const a = corners[i]!
    const b = corners[(i + 1) % 3]!
    // Each face is split diagonally: white upper-left, orange lower-right.
    const tl = [a.x, top, a.y]
    const tr = [b.x, top, b.y]
    const bl = [a.x, top - size, a.y]
    const br = [b.x, top - size, b.y]
    for (const [tri, color] of [
      [[tl, bl, tr], WHITE],
      [[tr, bl, br], ORANGE],
      [[tl, tr, bl], WHITE],
      [[tr, br, bl], ORANGE],
    ] as [number[][], THREE.Color][]) {
      for (const p of tri) {
        positions.push(...p)
        colors.push(color.r, color.g, color.b)
      }
    }
  }
  // Stand: a thin pole.
  const pole = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, top + 0.1, 5).toNonIndexed()
  pole.translate(POLE_X, (top + 0.1) / 2 - 0.1, 0)
  const pp = pole.getAttribute('position')
  for (let i = 0; i < pp.count; i++) {
    positions.push(pp.getX(i), pp.getY(i), pp.getZ(i))
    colors.push(STAND.r, STAND.g, STAND.b)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  g.computeVertexNormals()
  return g
}

/** A white plate with the control code, readable from 2–3 m. */
function plateMaterial(text: string): THREE.MeshLambertMaterial {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 256, 128)
  ctx.strokeStyle = '#222222'
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, 250, 122)
  ctx.fillStyle = '#111111'
  ctx.font = 'bold 96px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 70, 236)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  // A little light of its own keeps the code readable in the shade.
  return new THREE.MeshLambertMaterial({ map: texture, emissive: 0x555555, emissiveMap: texture })
}

/**
 * A banner with `text` between two poles, standing on the ground at scene (x, z) and facing
 * along `dir` (scene x, z). The cloth is two planes back to back, so the text reads from both sides.
 */
function banner(text: string, x: number, z: number, dir: THREE.Vector2, heights: HeightField): THREE.Group {
  const group = new THREE.Group()
  const across = new THREE.Vector2(-dir.y, dir.x)
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x9a9a96 })
  let top = -Infinity
  for (const side of [-1, 1]) {
    const px = x + across.x * side * (BANNER_WIDTH / 2)
    const pz = z + across.y * side * (BANNER_WIDTH / 2)
    const ground = heights.heightAt(px, pz)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, BANNER_POLE + 0.3, 6), poleMaterial)
    pole.position.set(px, ground + (BANNER_POLE + 0.3) / 2 - 0.3, pz)
    pole.castShadow = true
    group.add(pole)
    top = Math.max(top, ground + BANNER_POLE)
  }

  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = Math.round((1024 * BANNER_CLOTH) / BANNER_WIDTH)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = BANNER_ORANGE
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, canvas.height - 14, canvas.width, 14)
  ctx.fillRect(0, 0, canvas.width, 14)
  ctx.font = `bold ${Math.round(canvas.height * 0.62)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4, canvas.width - 60)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  // A little light of its own keeps the text readable in the shade.
  const material = new THREE.MeshLambertMaterial({ map: texture, emissive: 0x666666, emissiveMap: texture })
  const yaw = Math.atan2(dir.x, dir.y)
  for (const turn of [0, Math.PI]) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(BANNER_WIDTH, BANNER_CLOTH), material)
    cloth.position.set(x, top - BANNER_CLOTH / 2, z)
    cloth.rotation.y = yaw + turn
    cloth.castShadow = true
    group.add(cloth)
  }
  return group
}

export type RunState = 'ready' | 'running' | 'finished'

/** The course in the 3D world, and timing of a run. */
export class CourseRun {
  readonly group = new THREE.Group()
  course: Course
  state: RunState = 'ready'
  /** Index of the next control to punch (0 = start). */
  next = 0
  startTime = 0
  splits: number[] = []
  private readonly world: World
  private readonly heights: HeightField
  /** True where something solid stands (scene x, z); banners and flags keep clear of it. */
  private readonly blocked: (x: number, z: number) => boolean
  /** Where the start and finish banners ended up (scene x, z), when moved off their point. */
  private readonly spots = new Map<number, THREE.Vector2>()
  private readonly flag = flagGeometry()
  private readonly plate = new THREE.PlaneGeometry(...PLATE_SIZE)
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  private onPunch: (index: number) => void = () => {}

  constructor(world: World, heights: HeightField, course: Course, blocked: (x: number, z: number) => boolean = () => false) {
    this.world = world
    this.heights = heights
    this.blocked = blocked
    this.course = course
    this.group.name = 'course'
    this.rebuild()
  }

  set punchListener(listener: (index: number) => void) {
    this.onPunch = listener
  }

  setCourse(course: Course) {
    this.course = course
    saveCourse(this.world, course)
    this.reset()
    this.rebuild()
  }

  reset() {
    this.state = 'ready'
    this.next = 0
    this.startTime = 0
    this.splits = []
  }

  /** Scene position of control `i` on the ground: where its flag stands, for punching. */
  scenePosition(i: number): THREE.Vector3 {
    const spot = this.spots.get(i)
    if (spot) return new THREE.Vector3(spot.x, this.heights.heightAt(spot.x, spot.y), spot.y)
    const [e, n] = this.course.flags?.[i] ?? this.course.controls[i]!
    const [x, z] = this.world.toScene(e, n)
    return new THREE.Vector3(x, this.heights.heightAt(x, z), z)
  }

  /**
   * A free spot for a banner near `p` facing along `dir`, and the side (+1 or -1)
   * its flag stands on: the poles and the flag must not stand in a building or a rock.
   */
  private bannerSpot(p: THREE.Vector3, dir: THREE.Vector2): { centre: THREE.Vector2; side: number } {
    const across = new THREE.Vector2(-dir.y, dir.x)
    for (const [along, sideways] of BANNER_SHIFTS) {
      const centre = new THREE.Vector2(p.x, p.z).addScaledVector(dir, along).addScaledVector(across, sideways)
      const free = (k: number) => {
        const q = centre.clone().addScaledVector(across, k)
        return !this.blocked(q.x, q.y)
      }
      if (![-BANNER_WIDTH / 2, -0.75, 0, 0.75, BANNER_WIDTH / 2].every(free)) continue
      for (const side of [1, -1]) {
        if (free(side * BANNER_FLAG_OFFSET)) return { centre, side }
      }
    }
    return { centre: new THREE.Vector2(p.x, p.z), side: 1 }
  }

  /**
   * Where to put the runner when a course is opened: a few metres behind the start banner,
   * looking at it and the start control. `heading` is in radians, clockwise from north.
   */
  startView(): { x: number; z: number; heading: number } | null {
    if (this.course.controls.length < 2) return null
    const start = this.scenePosition(0)
    const next = this.scenePosition(1)
    const dir = new THREE.Vector2(next.x - start.x, next.z - start.z)
    if (dir.lengthSq() < 1e-6) dir.set(0, -1)
    dir.normalize()
    const heading = Math.atan2(dir.x, -dir.y)
    for (const d of START_VIEW_DISTANCES) {
      const x = start.x - dir.x * d
      const z = start.z - dir.y * d
      if (!this.blocked(x, z)) return { x, z, heading }
    }
    return { x: start.x - dir.x * START_VIEW_DISTANCES[0]!, z: start.z - dir.y * START_VIEW_DISTANCES[0]!, heading }
  }

  /**
   * A control stand at `p`: the flag, and a plate with `code` on each side of the pole,
   * in front of it, so the pole never hides the code. `facing` (scene x, z) is where the
   * front plate looks.
   */
  private stand(p: THREE.Vector3, code: string, facing: THREE.Vector2): THREE.Group {
    const group = new THREE.Group()
    group.position.copy(p)
    // The group's +z (the front plate's normal) turns to `facing`.
    group.rotation.y = Math.atan2(facing.x, facing.y)
    const flag = new THREE.Mesh(this.flag, this.material)
    flag.castShadow = true
    group.add(flag)
    if (code) {
      const material = plateMaterial(code)
      for (const side of [1, -1]) {
        const plate = new THREE.Mesh(this.plate, material)
        plate.position.set(POLE_X, PLATE_HEIGHT, side * (POLE_RADIUS + 0.006))
        if (side < 0) plate.rotation.y = Math.PI
        plate.castShadow = true
        group.add(plate)
      }
    }
    return group
  }

  /** Text on the plate of control `i`: its code, or its number on a course set by hand. */
  private label(i: number): string {
    const code = this.course.imported?.controls[i]?.code
    if (code) return code
    const n = this.course.controls.length
    return i > 0 && i < n - 1 ? String(i) : ''
  }

  private rebuild() {
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      child.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return
        if (o.geometry !== this.flag && o.geometry !== this.plate) o.geometry.dispose()
        const material = o.material as THREE.MeshLambertMaterial
        if (material !== this.material) {
          material.map?.dispose()
          material.dispose()
        }
      })
    }
    const n = this.course.controls.length
    this.spots.clear()
    for (let i = 0; i < n; i++) {
      let p = this.scenePosition(i)
      const isStart = i === 0 && n > 1
      const isFinish = i === n - 1 && n > 1
      // The front plate looks toward where the runner comes from.
      const from = i > 0 ? this.scenePosition(i - 1) : null
      const facing = from ? new THREE.Vector2(from.x - p.x, from.z - p.z) : new THREE.Vector2(0, 1)
      if (isStart || isFinish) {
        // A banner across the course, and the start or finish control beside it.
        const other = this.scenePosition(isStart ? 1 : n - 2)
        const dir = isStart
          ? new THREE.Vector2(other.x - p.x, other.z - p.z)
          : new THREE.Vector2(p.x - other.x, p.z - other.z)
        if (dir.lengthSq() < 1e-6) dir.set(0, -1)
        dir.normalize()
        const { centre, side } = this.bannerSpot(p, dir)
        // The run starts and ends at the banner.
        this.spots.set(i, centre)
        this.group.add(banner(t(isStart ? 'bannerStart' : 'bannerFinish'), centre.x, centre.y, dir, this.heights))
        const x = centre.x - dir.y * side * BANNER_FLAG_OFFSET
        const z = centre.y + dir.x * side * BANNER_FLAG_OFFSET
        p = new THREE.Vector3(x, this.heights.heightAt(x, z), z)
        facing.set(-dir.x, -dir.y)
      }
      if (facing.lengthSq() < 1e-6) facing.set(0, 1)
      this.group.add(this.stand(p, this.label(i), facing))
    }

    // The other controls in the file, with their plates looking away from their feature.
    const onCourse = new Set(this.course.imported?.controls.map(c => c.code))
    for (const other of this.course.others ?? []) {
      if (onCourse.has(other.code)) continue
      const [x, z] = this.world.toScene(...other.flag)
      const [cx, cz] = this.world.toScene(...other.position)
      const facing = new THREE.Vector2(x - cx, z - cz)
      if (facing.lengthSq() < 0.01) facing.set(0, 1)
      this.group.add(this.stand(new THREE.Vector3(x, this.heights.heightAt(x, z), z), other.code, facing))
    }
  }

  /** Elapsed running time in seconds. */
  elapsed(now = performance.now()): number {
    if (this.state === 'ready') return 0
    const end = this.state === 'finished' ? this.startTime + this.splits[this.splits.length - 1]! * 1000 : now
    return (end - this.startTime) / 1000
  }

  /** Check punching for a runner at scene position `pos`. */
  update(pos: THREE.Vector3, now = performance.now()) {
    const n = this.course.controls.length
    if (n < 2 || this.state === 'finished') return
    const flat = (p: THREE.Vector3) => Math.hypot(p.x - pos.x, p.z - pos.z)
    if (this.state === 'ready') {
      // The clock starts when the runner leaves the start triangle.
      if (flat(this.scenePosition(0)) < START_LEAVE_DISTANCE) {
        this.next = 1
      } else if (this.next === 1) {
        this.state = 'running'
        this.startTime = now
      }
      return
    }
    if (flat(this.scenePosition(this.next)) < PUNCH_DISTANCE) {
      this.splits.push((now - this.startTime) / 1000)
      this.onPunch(this.next)
      this.next++
      if (this.next >= n) this.state = 'finished'
    }
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** A short electronic beep, like an SI/EMIT punch. */
export function beep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 2800
    gain.gain.value = 0.08
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.12)
    osc.onended = () => void ctx.close()
  } catch {
    // No audio available.
  }
}
