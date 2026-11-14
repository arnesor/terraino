import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import type { HeightField } from './heightfield'
import { isTyping } from './keyboard'

const EYE_HEIGHT = 1.7
export const JOG_SPEED = 3.2 // m/s, a steady orienteering pace
const FLY_SPEED = 40
const GRAVITY = 9.81
const BODY_RADIUS = 0.3
// A runner steps onto a deck whose surface is at most this far (m) above their feet, as at
// its ends; under a higher deck they stay on the ground and pass beneath it.
const STEP_UP = 0.5
// Under a deck this high (m) above the ground or less (slab and runner) there is no room to
// pass: the runner is on it, as on a footbridge over a stream.
const DECK_HEADROOM = 2.6
const DRAG_LOOK_SPEED = 0.004 // radians per pixel when looking by dragging
// The eye follows the ground under a footprint, as legs absorb bumps: the ground under the
// player and 8 points this far (m) around it, each cut off this far (m) above or below the
// ground under the player, so that a cliff edge does not pull the eye over it. On an even
// slope the points cancel out in pairs.
const FOOTPRINT_RADIUS = 0.75
const FOOTPRINT_LIMIT = 0.25
const FOOTPRINT = Array.from({ length: 8 }, (_, k) => [
  FOOTPRINT_RADIUS * Math.cos((k * Math.PI) / 4),
  FOOTPRINT_RADIUS * Math.sin((k * Math.PI) / 4),
])
// Time constant (s) of the spring that smooths the eye height over the slope changes at
// the height samples.
const EYE_SPRING = 0.03
// A runner holding a direction slowly veers off it: the turn rate (rad/m) wanders with this
// spread in easy forest, changing over about this distance (m). Over 300 m that is about 18°
// off, 50 m to the side, unless the runner checks the compass. Thicker forest spreads it by
// 1 / runnability (at most 1 / VEER_RUNNABILITY).
const VEER_TURN = 0.0027
const VEER_LENGTH = 25
const VEER_RUNNABILITY = 0.3
// Across a slope you also turn downhill, by this many rad/m per unit of side slope (5° per
// 100 m on a slope of 1 in 5), up to a side slope of VEER_SLOPE.
const DOWNHILL_PULL = 0.0044
const VEER_SLOPE = 0.5
// Glancing off a trunk or a boulder turns the runner by about this much (rad) at `glance` = 1
// in a head-on bump, less in a graze, made over about this time (s).
const GLANCE_TURN = 0.17
const GLANCE_TIME = 0.3
// After a bump the runner gets back to speed over about this time (s).
const STUMBLE_TIME = 0.6

/** A normally distributed random number, from uniform ones in [0, 1). */
function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
}

/**
 * Move `y`, moving at `v`, towards `target` for `dt` seconds on a critically damped spring
 * with time constant `tau`. Exact, so stable for any `dt`. Returns the new height and speed.
 */
function spring(y: number, v: number, target: number, dt: number, tau: number): [number, number] {
  const w = 1 / tau
  const x = y - target
  const c = v + w * x
  const e = Math.exp(-w * dt)
  return [target + (x + c * dt) * e, (v - w * c * dt) * e]
}

/** What the ground and the forest allow at a position. */
export interface Surroundings {
  /**
   * Running speed factor (1 = easy forest, 0 = impassable), or null if unknown; `onDeck`
   * when the runner is on a deck rather than the ground below it.
   */
  speedAt(x: number, z: number, onDeck?: boolean): number | null
  /** Push a position of a body with `radius` out of obstacles (on a deck: its rails). */
  collide(x: number, z: number, radius: number, onDeck?: boolean): [number, number]
  /** Height of something to walk on above the terrain (a bridge deck), or null. */
  deckAt?(x: number, z: number): number | null
}

/**
 * True if a runner with feet at `feet` stands on a deck at `deck` over ground at `terrain`:
 * they step up onto it at its ends, and pass under it elsewhere where there is room.
 */
export function standsOnDeck(deck: number | null, terrain: number, feet: number): boolean {
  if (deck === null || deck < terrain) return false
  return feet >= deck - STEP_UP || deck - terrain < DECK_HEADROOM
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
  // Eye height of the body without smoothing (gravity and decks), and the speed of
  // the smoothed eye, which is the camera's height.
  private bodyY = 0
  private eyeSpeed = 0
  /** Current horizontal speed (m/s of game time), for the HUD. */
  speed = 0
  /** Running speed factor of the ground under the player, for the HUD. */
  runnability = 1
  surroundings: Surroundings | null = null
  /** Whether F may start flying now (not in a competition run); says why not itself. */
  canFly: () => boolean = () => true
  /** Accept movement keys without pointer lock (while the map window has the mouse). */
  keysWithoutLock = false
  /** How much the runner veers off a straight line (1 = as set by VEER_TURN, 0 = not at all). */
  veer = 1
  /**
   * How much a bump into a trunk or a boulder turns the runner (1 = about GLANCE_TURN head-on,
   * 0 = not at all). The defaults of this, `stumble` and `legs` were found by trying them out.
   */
  glance = 2
  /** How much of the running speed a bump takes away at first (0 to 1). */
  stumble = 0.6
  /**
   * Distance (m) over which a turn of the legs (veering, bumps) passes into the view; until
   * then the runner runs off where they look, which is hard to notice. 0 turns the view at once.
   */
  legs = 40
  /** Uniform random numbers in [0, 1) for veering. */
  random: () => number = Math.random
  private turnRate = 0
  // How far (rad, positive to the left) the legs run off the view, the turn from a bump still to
  // make, the speed still lost to it, and whether the runner was against an obstacle last step.
  private legYaw = 0
  private glanceLeft = 0
  private slowdown = 0
  private touching = false
  /** Whether the runner stands on a deck rather than the ground. */
  onDeck = false

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, heights: HeightField, bounds: [number, number]) {
    this.camera = camera
    this.heights = heights
    this.bounds = bounds
    this.controls = new PointerLockControls(camera, dom)
    window.addEventListener('keydown', e => {
      if (isTyping(e)) return
      this.keys.add(e.code)
      if (e.code === 'KeyF' && this.acceptsKeys && this.canFly()) this.toggleFlying()
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
    this.bodyY = this.camera.position.y
    this.verticalSpeed = 0
    this.eyeSpeed = 0
    this.turnRate = 0
    this.legYaw = 0
    this.glanceLeft = 0
    this.slowdown = 0
    this.touching = false
    this.onDeck = false
  }

  toggleFlying() {
    this.flying = !this.flying
    if (!this.flying) this.verticalSpeed = 0
  }

  /** Ground height under the player's footprint (see FOOTPRINT_RADIUS). */
  private footprintHeight(x: number, z: number): number {
    const h0 = this.heights.heightAt(x, z)
    let sum = h0
    for (const [dx, dz] of FOOTPRINT) {
      const h = this.heights.heightAt(x + dx!, z + dz!)
      sum += THREE.MathUtils.clamp(h, h0 - FOOTPRINT_LIMIT, h0 + FOOTPRINT_LIMIT)
    }
    return sum / (FOOTPRINT.length + 1)
  }

  /** Compass heading in degrees, 0 = grid north, 90 = east. */
  get heading(): number {
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    const deg = THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z))
    return (deg + 360) % 360
  }

  /** Compass heading (degrees) the legs run in, which is off the view's by `legs`. */
  get runHeading(): number {
    return (this.heading - THREE.MathUtils.radToDeg(this.legYaw) + 360) % 360
  }

  /**
   * Turn the legs a little for `move`, made on foot from the camera's position: the runner
   * veers, more in thick forest and downhill across a slope. It goes by the distance run, not
   * the time, so it is the same at any time factor and nothing while standing still.
   */
  private veerFor(move: THREE.Vector3) {
    const dist = move.length()
    if (dist === 0 || this.veer === 0) return
    const pos = this.camera.position
    // The turn rate wanders (exactly for any step), so the path bends rather than the view shaking.
    const decay = Math.exp(-dist / VEER_LENGTH)
    const spread = VEER_TURN / Math.max(this.runnability, VEER_RUNNABILITY)
    this.turnRate = this.turnRate * decay + spread * Math.sqrt(1 - decay * decay) * gaussian(this.random)
    // The rise of the ground to the right; turning left (a larger yaw) is downhill then.
    // A deck is level across.
    const side = this.onDeck ? 0 : this.heights.slopeAlong(pos.x, pos.z, -move.z, move.x)
    const pull = DOWNHILL_PULL * THREE.MathUtils.clamp(side, -VEER_SLOPE, VEER_SLOPE)
    this.legYaw += (this.turnRate + pull) * dist * this.veer
  }

  /**
   * A bump: the runner was moving by `move` and the obstacles pushed them by (px, pz). They
   * glance off to the side they were pushed (either way when head-on), more the more head-on.
   */
  private bump(move: THREE.Vector3, px: number, pz: number) {
    this.slowdown = this.stumble
    if (this.glance === 0) return
    const step = move.length()
    const push = Math.hypot(px, pz)
    if (step === 0 || push === 0) return
    // The cosine between the push and straight back, and the push to the right of the move.
    const headOn = THREE.MathUtils.clamp(-(px * move.x + pz * move.z) / (push * step), 0, 1)
    const right = (px * -move.z + pz * move.x) / step
    const sign = Math.abs(right) > 0.2 * push ? Math.sign(right) : this.random() < 0.5 ? -1 : 1
    const size = this.glance * GLANCE_TURN * (0.25 + 0.75 * headOn) * Math.abs(gaussian(this.random))
    // Turning right is a smaller yaw.
    this.glanceLeft -= sign * size
  }

  /**
   * Make what is left of a bump's turn over `dt` s, and pass the legs' turn into the view
   * over `dist` m run.
   */
  private settle(dt: number, dist: number) {
    const glance = this.glanceLeft * (1 - Math.exp(-dt / GLANCE_TIME))
    this.glanceLeft -= glance
    this.legYaw += glance
    const share = this.legs > 0 ? 1 - Math.exp(-dist / this.legs) : 1
    const turn = this.legYaw * share
    if (turn === 0) return
    this.legYaw -= turn
    const euler = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(this.camera.quaternion)
    euler.y += turn
    this.camera.quaternion.setFromEuler(euler)
  }

  /**
   * Move on by `dt` seconds of game time, at most a few hundredths of a second (see
   * GameClock.advance), so the runner does not pass through trunks and walls.
   */
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

    if (this.flying) {
      // Flying goes where you look: look up to climb, down to dive.
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(FLY_SPEED * dt)
      pos.add(move)
      pos.y = Math.max(pos.y, this.heights.heightAt(pos.x, pos.z) + EYE_HEIGHT)
      this.bodyY = pos.y
      this.speed = move.length() / Math.max(dt, 1e-6)
    } else {
      let speed = JOG_SPEED * (1 - this.slowdown)
      this.slowdown *= Math.exp(-dt / STUMBLE_TIME)
      if (move.lengthSq() > 0) {
        // The legs may run off where the runner looks.
        move.normalize().applyAxisAngle(this.camera.up, this.legYaw)
        // Uphill is slow, gentle downhill a little faster, steep downhill careful. Decks are
        // gentle; the ground under them is not what the runner climbs.
        const slope = this.onDeck ? 0 : this.heights.slopeAlong(pos.x, pos.z, move.x, move.z)
        const factor = slope > 0 ? 1 / (1 + slope * 4) : slope > -0.25 ? 1 - slope * 0.4 : 1.1 + (slope + 0.25) * 1.5
        speed *= THREE.MathUtils.clamp(factor, 0.25, 1.15)
        const here = this.surroundings?.speedAt(pos.x, pos.z, this.onDeck) ?? null
        this.runnability = here ?? 1
        speed *= Math.max(this.runnability, 0.15)
        move.multiplyScalar(speed * dt)
        let nx = pos.x + move.x
        let nz = pos.z + move.z
        if (this.surroundings) {
          const [fx, fz] = [nx, nz]
          ;[nx, nz] = this.surroundings.collide(nx, nz, BODY_RADIUS, this.onDeck)
          const touching = Math.hypot(nx - fx, nz - fz) > 1e-6
          if (touching && !this.touching) this.bump(move, nx - fx, nz - fz)
          this.touching = touching
          // Lakes and buildings stop you (speed 0); you can still step back out.
          const ahead = this.surroundings.speedAt(nx, nz, this.onDeck)
          if (ahead === 0 && (here ?? 1) > 0) {
            nx = pos.x
            nz = pos.z
          }
        }
        move.set(nx - pos.x, 0, nz - pos.z)
        this.veerFor(move)
        pos.x = nx
        pos.z = nz
      }
      this.settle(dt, move.length())
      this.speed = move.length() / Math.max(dt, 1e-6)

      const terrain = this.heights.heightAt(pos.x, pos.z)
      const deck = this.surroundings?.deckAt?.(pos.x, pos.z) ?? null
      const onDeck = standsOnDeck(deck, terrain, this.bodyY - EYE_HEIGHT)
      this.onDeck = onDeck
      const ground = (onDeck ? deck! : terrain) + EYE_HEIGHT
      this.verticalSpeed -= GRAVITY * dt
      this.bodyY += this.verticalSpeed * dt
      // Follow the ground when walking downhill instead of falling in small hops; fall
      // only from higher up (after flying, or off a cliff or a deck).
      if (this.bodyY - ground < 0.6) {
        this.bodyY = ground
        this.verticalSpeed = 0
        // Decks are flat; on the ground the eye follows the footprint, smoothed.
        const target = onDeck ? ground : this.footprintHeight(pos.x, pos.z) + EYE_HEIGHT
        ;[pos.y, this.eyeSpeed] = spring(pos.y, this.eyeSpeed, target, dt, EYE_SPRING)
      } else {
        // In the air the eye moves with the body.
        pos.y = this.bodyY
        this.eyeSpeed = this.verticalSpeed
      }
    }

    pos.x = THREE.MathUtils.clamp(pos.x, 0, this.bounds[0])
    pos.z = THREE.MathUtils.clamp(pos.z, 0, this.bounds[1])
  }
}
