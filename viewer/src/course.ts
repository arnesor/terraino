import * as THREE from 'three'
import type { HeightField } from './heightfield'
import type { World } from './world'

/** A control in projected coordinates (easting, northing). */
export type Control = [number, number]

/** Start, controls and finish, in running order. */
export interface Course {
  controls: Control[]
}

const PUNCH_DISTANCE = 2.5
const START_LEAVE_DISTANCE = 3
const STORAGE_PREFIX = 'otest.course.'
const ORANGE = new THREE.Color(0xf26a1b)
const WHITE = new THREE.Color(0xf4f4f0)
const STAND = new THREE.Color(0x777777)

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
  const size = 0.3
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
  const pole = new THREE.CylinderGeometry(0.015, 0.015, top + 0.1, 5).toNonIndexed()
  pole.translate(size * 0.35, (top + 0.1) / 2 - 0.1, 0)
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

/** A small text plate with the control number, as a sprite. */
function numberSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 128, 64)
  ctx.fillStyle = '#111111'
  ctx.font = 'bold 44px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 64, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }))
  sprite.scale.set(0.3, 0.15, 1)
  return sprite
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
  private readonly flag = flagGeometry()
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  private onPunch: (index: number) => void = () => {}

  constructor(world: World, heights: HeightField, course: Course) {
    this.world = world
    this.heights = heights
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

  /** Scene position of control `i`, on the ground. */
  scenePosition(i: number): THREE.Vector3 {
    const [e, n] = this.course.controls[i]!
    const [x, z] = this.world.toScene(e, n)
    return new THREE.Vector3(x, this.heights.heightAt(x, z), z)
  }

  private rebuild() {
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      if (child instanceof THREE.Sprite) child.material.map?.dispose()
    }
    const n = this.course.controls.length
    for (let i = 0; i < n; i++) {
      const p = this.scenePosition(i)
      if (i === 0 && n > 1) continue // the start has no flag, just the map triangle
      const mesh = new THREE.Mesh(this.flag, this.material)
      mesh.position.copy(p)
      mesh.castShadow = true
      this.group.add(mesh)
      if (i < n - 1) {
        const label = numberSprite(String(i))
        label.position.copy(p).add(new THREE.Vector3(0.12, 0.6, 0))
        this.group.add(label)
      }
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
