import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import type { HeightField } from './heightfield'

const EYE_HEIGHT = 1.7
const JOG_SPEED = 3.2 // m/s, a steady orienteering pace
const RUN_SPEED = 5.5
const FLY_SPEED = 40
const FLY_FAST_SPEED = 200
const GRAVITY = 9.81
const JUMP_SPEED = 3.5
const BODY_RADIUS = 0.3
const DRAG_LOOK_SPEED = 0.004 // radians per pixel when looking by dragging

/** What the ground and the forest allow at a position. */
export interface Surroundings {
  /** Running speed factor (1 = easy forest, 0 = impassable), or null if unknown. */
  speedAt(x: number, z: number): number | null
  /** Push a position of a body with `radius` out of obstacles. */
  collide(x: number, z: number, radius: number): [number, number]
}

/** First-person walking (or flying) on the terrain, with mouse look. */
export class Player {
  readonly controls: PointerLockControls
  readonly camera: THREE.PerspectiveCamera
  flying = false
  private readonly heights: HeightField
  private readonly bounds: [number, number]
  private readonly keys = new Set<string>()
  private verticalSpeed = 0
  private onGround = true
  /** Current horizontal speed in m/s, for the HUD. */
  speed = 0
  /** Running speed factor of the ground under the player, for the HUD. */
  runnability = 1
  surroundings: Surroundings | null = null
  /** Accept movement keys without pointer lock (while the map window has the mouse). */
  keysWithoutLock = false

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, heights: HeightField, bounds: [number, number]) {
    this.camera = camera
    this.heights = heights
    this.bounds = bounds
    this.controls = new PointerLockControls(camera, dom)
    window.addEventListener('keydown', e => {
      this.keys.add(e.code)
      if (e.code === 'KeyF' && this.acceptsKeys) this.toggleFlying()
      if (e.code === 'Space' && !this.flying && this.onGround) {
        this.verticalSpeed = JUMP_SPEED
        this.onGround = false
      }
    })
    window.addEventListener('keyup', e => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
  }

  private get acceptsKeys(): boolean {
    return this.controls.isLocked || this.keysWithoutLock
  }

  /** Turn the view by a mouse movement of (dx, dy) pixels, as when dragging. */
  look(dx: number, dy: number) {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(this.camera.quaternion)
    euler.y -= dx * DRAG_LOOK_SPEED
    euler.x = THREE.MathUtils.clamp(euler.x - dy * DRAG_LOOK_SPEED, -1.4, 1.4)
    this.camera.quaternion.setFromEuler(euler)
  }

  placeAt(x: number, z: number) {
    this.camera.position.set(x, this.heights.heightAt(x, z) + EYE_HEIGHT, z)
    this.verticalSpeed = 0
  }

  toggleFlying() {
    this.flying = !this.flying
    if (!this.flying) this.verticalSpeed = 0
  }

  /** Compass heading in degrees, 0 = grid north, 90 = east. */
  get heading(): number {
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    const deg = THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z))
    return (deg + 360) % 360
  }

  update(dt: number) {
    const pos = this.camera.position
    const forward = new THREE.Vector3()
    this.camera.getWorldDirection(forward)
    if (!this.flying) forward.y = 0
    forward.normalize()
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize()

    const move = new THREE.Vector3()
    if (this.acceptsKeys) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(forward)
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(forward)
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right)
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right)
    }
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')

    if (this.flying) {
      if (this.keys.has('Space')) move.y += 1
      if (this.keys.has('KeyC')) move.y -= 1
      if (move.lengthSq() > 0) move.normalize().multiplyScalar((fast ? FLY_FAST_SPEED : FLY_SPEED) * dt)
      pos.add(move)
      pos.y = Math.max(pos.y, this.heights.heightAt(pos.x, pos.z) + EYE_HEIGHT)
      this.speed = move.length() / Math.max(dt, 1e-6)
    } else {
      let speed = fast ? RUN_SPEED : JOG_SPEED
      if (move.lengthSq() > 0) {
        move.normalize()
        // Uphill is slow, gentle downhill a little faster, steep downhill careful.
        const slope = this.heights.slopeAlong(pos.x, pos.z, move.x, move.z)
        const factor = slope > 0 ? 1 / (1 + slope * 4) : slope > -0.25 ? 1 - slope * 0.4 : 1.1 + (slope + 0.25) * 1.5
        speed *= THREE.MathUtils.clamp(factor, 0.25, 1.15)
        const here = this.surroundings?.speedAt(pos.x, pos.z) ?? null
        this.runnability = here ?? 1
        speed *= Math.max(this.runnability, 0.15)
        move.multiplyScalar(speed * dt)
        let nx = pos.x + move.x
        let nz = pos.z + move.z
        if (this.surroundings) {
          ;[nx, nz] = this.surroundings.collide(nx, nz, BODY_RADIUS)
          // Lakes and buildings stop you (speed 0); you can still step back out.
          const ahead = this.surroundings.speedAt(nx, nz)
          if (ahead === 0 && (here ?? 1) > 0) {
            nx = pos.x
            nz = pos.z
          }
        }
        move.set(nx - pos.x, 0, nz - pos.z)
        pos.x = nx
        pos.z = nz
      }
      this.speed = move.length() / Math.max(dt, 1e-6)

      const ground = this.heights.heightAt(pos.x, pos.z) + EYE_HEIGHT
      this.verticalSpeed -= GRAVITY * dt
      pos.y += this.verticalSpeed * dt
      // Follow the ground when walking downhill instead of falling in small hops.
      const snap = this.onGround && this.verticalSpeed <= 0 && pos.y - ground < 0.6
      if (pos.y <= ground || snap) {
        pos.y = ground
        this.verticalSpeed = 0
        this.onGround = true
      }
    }

    pos.x = THREE.MathUtils.clamp(pos.x, 0, this.bounds[0])
    pos.z = THREE.MathUtils.clamp(pos.z, 0, this.bounds[1])
  }
}
