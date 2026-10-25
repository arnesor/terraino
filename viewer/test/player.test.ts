import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameClock } from '../src/clock'
import type { HeightField } from '../src/heightfield'
import { Player } from '../src/player'
import { CHUNK, syntheticWorld } from './synthetic'

// clock.ts loads the UI texts, which pick a language from the page's URL.
vi.hoisted(() => vi.stubGlobal('location', { search: '' }))

const FPS = 60
const DT = 1 / FPS
const EYE = 1.7

/** A player on a one-chunk world with heights f(col, row), and its keyboard. */
async function setup(f: (col: number, row: number) => number) {
  const { heights } = await syntheticWorld(1, 1, f)
  const listeners = new Map<string, ((e: { code: string }) => void)[]>()
  const target = {
    addEventListener: (type: string, listener: (e: { code: string }) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener: () => {},
  }
  vi.stubGlobal('window', target)
  const dom = { ...target, ownerDocument: target } as unknown as HTMLElement
  const camera = new THREE.PerspectiveCamera()
  const player = new Player(camera, dom, heights, [CHUNK, CHUNK])
  player.keysWithoutLock = true
  const key = (type: 'keydown' | 'keyup', code: string) => listeners.get(type)?.forEach(l => l({ code }))
  return { player, camera, heights, key }
}

/** Face along the x axis (east). */
function faceEast(camera: THREE.Camera) {
  camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ')
}

/** Run `seconds` of frames; returns the eye height above the ground under the player, per frame. */
function frames(player: Player, heights: HeightField, seconds: number): { eye: number[]; above: number[] } {
  const eye: number[] = []
  const above: number[] = []
  for (let i = 0; i < seconds * FPS; i++) {
    player.update(DT)
    const p = player.camera.position
    eye.push(p.y)
    above.push(p.y - heights.heightAt(p.x, p.z))
  }
  return { eye, above }
}

/** Largest change in vertical speed between frames, in m/s². */
function peakAcceleration(y: number[]): number {
  let peak = 0
  for (let i = 2; i < y.length; i++) {
    const a = (y[i]! - 2 * y[i - 1]! + y[i - 2]!) / (DT * DT)
    peak = Math.max(peak, Math.abs(a))
  }
  return peak
}

afterEach(() => vi.unstubAllGlobals())

describe('eye height while running', () => {
  it('barely moves over small bumps', async () => {
    // Ground zigzagging ±5 cm between neighbouring samples: the slope flips at every metre.
    const { player, camera, heights, key } = await setup(col => 100 + (col % 2 ? 0.05 : -0.05))
    player.placeAt(20, 128)
    faceEast(camera)
    key('keydown', 'KeyW')
    frames(player, heights, 0.5) // get going
    const { eye } = frames(player, heights, 3)
    // Under half a g, and well under the ground's own 10 cm range.
    expect(peakAcceleration(eye)).toBeLessThan(5)
    expect(Math.max(...eye) - Math.min(...eye)).toBeLessThan(0.03)
  })

  it('keeps 1.7 m above a steep even slope, and settles exactly there when stopping', async () => {
    // Rising 0.5 m per metre east: steeper than the footprint's cut-off.
    const { player, camera, heights, key } = await setup(col => 100 + 0.5 * col)
    player.placeAt(20, 128)
    faceEast(camera)
    key('keydown', 'KeyW')
    frames(player, heights, 0.5)
    const { above } = frames(player, heights, 3)
    for (const a of above) expect(Math.abs(a - EYE)).toBeLessThan(0.1)

    key('keyup', 'KeyW')
    const stopped = frames(player, heights, 0.5).above
    expect(stopped.at(-1)).toBeCloseTo(EYE, 3)
  })

  it('stays near 1.7 m when running up and down a cliff', async () => {
    // A 3 m cliff between x = 29 and 30.
    const { player, camera, heights, key } = await setup(col => (col >= 30 ? 103 : 100))
    key('keydown', 'KeyW')
    for (const [from, heading] of [
      [20, -Math.PI / 2], // east, up the cliff
      [40, Math.PI / 2], // west, down it
    ] as const) {
      player.placeAt(from, 128)
      camera.rotation.set(0, heading, 0, 'YXZ')
      for (let i = 0; i < 6 * FPS; i++) {
        player.update(DT)
        const p = camera.position
        const above = p.y - heights.heightAt(p.x, p.z)
        expect(Math.abs(above - EYE)).toBeLessThan(0.3)
        // Once the footprint is clear of the cliff and the spring has settled, exactly 1.7 m.
        if (Math.abs(p.x - 29.5) > 2) expect(above).toBeCloseTo(EYE, 2)
      }
    }
  })
})

describe('eye height in the air and on decks', () => {
  it('keeps 1.7 m above a bridge deck', async () => {
    const { player, camera, heights, key } = await setup(() => 100)
    player.surroundings = {
      speedAt: () => 1,
      collide: (x, z) => [x, z],
      deckAt: x => (x >= 30 && x <= 36 ? 100.6 : null),
    }
    player.placeAt(20, 128)
    faceEast(camera)
    key('keydown', 'KeyW')
    let onDeck = 0
    for (let i = 0; i < 7 * FPS; i++) {
      player.update(DT)
      const x = camera.position.x
      if (x > 31.5 && x < 35.5) {
        expect(camera.position.y).toBeCloseTo(100.6 + EYE, 3)
        onDeck++
      }
    }
    expect(onDeck).toBeGreaterThan(0)
    expect(camera.position.y - heights.heightAt(camera.position.x, 128)).toBeCloseTo(EYE, 3)
  })

  it('stands at 1.7 m right after moving to a lower place', async () => {
    const { player, camera, heights } = await setup(col => 100 + 0.5 * col)
    player.placeAt(200, 128)
    frames(player, heights, 0.5)
    player.placeAt(20, 128) // 90 m lower
    player.update(DT)
    expect(camera.position.y - heights.heightAt(20, 128)).toBeCloseTo(EYE, 2)
  })

  it('falls to the ground after flying', async () => {
    const { player, camera, heights, key } = await setup(() => 100)
    player.placeAt(128, 128)
    key('keydown', 'KeyF')
    // Fly up by looking up.
    camera.rotation.set(1.2, 0, 0, 'YXZ')
    key('keydown', 'KeyW')
    frames(player, heights, 0.5)
    key('keyup', 'KeyW')
    const high = camera.position.y
    expect(high - 100).toBeGreaterThan(10)

    key('keydown', 'KeyF')
    player.update(DT)
    // Falling, not dropped to the ground at once.
    expect(camera.position.y).toBeGreaterThan(high - 0.1)
    const { above } = frames(player, heights, 3)
    expect(above.at(-1)).toBeCloseTo(EYE, 3)
  })
})

describe('at a high time factor', () => {
  /**
   * Play `seconds` of game time at time factor `steps` up the ladder, in real frames of `dt`
   * (0.1 s is the longest the game loop takes). Returns the eye height above the ground and
   * the game time after each step.
   */
  function play(player: Player, heights: HeightField, steps: number, seconds: number, dt = DT) {
    const clock = new GameClock()
    for (let i = 0; i < steps; i++) clock.faster()
    const above: number[] = []
    const times: number[] = []
    while (clock.time < seconds - 1e-9) {
      clock.advance(dt, {}, step => {
        player.update(step)
        const p = player.camera.position
        above.push(p.y - heights.heightAt(p.x, p.z))
        times.push(clock.time)
      })
    }
    return { above, times }
  }

  // 1×, 8× and 10×, at 60 frames a second and at the 0.1 s frames of a slow computer.
  const CASES = [
    [0, DT],
    [6, DT],
    [7, DT],
    [6, 0.1],
    [7, 0.1],
  ] as const

  it.each(CASES)('covers the same ground at game pace (ladder step %i, frames of %f s)', async (steps, dt) => {
    const { player, camera, heights, key } = await setup(col => 100 + 0.1 * col)
    player.placeAt(20, 128)
    faceEast(camera)
    key('keydown', 'KeyW')
    // 12 s is a whole number of frames at every factor here.
    expect(play(player, heights, steps, 12, dt).times.at(-1)).toBeCloseTo(12, 9)
    const atOne = await setup(col => 100 + 0.1 * col)
    atOne.player.placeAt(20, 128)
    faceEast(atOne.camera)
    atOne.key('keydown', 'KeyW')
    frames(atOne.player, atOne.heights, 12)
    // Uphill jogging: well short of 3.2 m/s, and the same pace (m per game second) as at 1×.
    expect(camera.position.x - 20).toBeGreaterThan(20)
    expect(camera.position.x).toBeCloseTo(atOne.camera.position.x, 1)
    expect(player.speed).toBeCloseTo(atOne.player.speed, 2)
  })

  it.each(CASES)('runs through no trunk and stops at a wall (ladder step %i, frames of %f s)', async (steps, dt) => {
    const { player, camera, key } = await setup(() => 100)
    // A trunk just off the line the runner takes, and a building from x = 60.
    const trunk = { x: 40, z: 128.05, radius: 0.15 }
    player.surroundings = {
      speedAt: x => (x >= 60 ? 0 : 1),
      collide: (x, z, radius) => {
        const dx = x - trunk.x
        const dz = z - trunk.z
        const d = Math.hypot(dx, dz)
        const min = trunk.radius + radius
        return d < min ? [trunk.x + (dx / d) * min, trunk.z + (dz / d) * min] : [x, z]
      },
    }
    player.placeAt(20, 128)
    faceEast(camera)
    key('keydown', 'KeyW')
    let nearest = Infinity
    let furthest = 0
    const clock = new GameClock()
    for (let i = 0; i < steps; i++) clock.faster()
    // 16 s at 3.2 m/s reaches the wall 40 m away.
    while (clock.time < 16 - 1e-9) {
      clock.advance(dt, {}, step => {
        player.update(step)
        const p = camera.position
        nearest = Math.min(nearest, Math.hypot(p.x - trunk.x, p.z - trunk.z))
        furthest = Math.max(furthest, p.x)
      })
    }
    // Pushed round the trunk (radius 0.15 m + body 0.3 m), never into it.
    expect(nearest).toBeGreaterThan(0.45 - 1e-6)
    // At the wall, not in it.
    expect(furthest).toBeLessThan(60)
    expect(furthest).toBeGreaterThan(59.5)
  })

  it.each(CASES)('falls from a height as at 1× (ladder step %i, frames of %f s)', async (steps, dt) => {
    /** Game time from dropping 20 m above the eye height until standing on the ground. */
    const fall = async (steps: number, dt: number) => {
      const { player, camera, heights, key } = await setup(() => 100)
      player.placeAt(128, 128)
      key('keydown', 'KeyF')
      camera.position.y += 20
      player.update(DT)
      key('keydown', 'KeyF')
      const { above, times } = play(player, heights, steps, 4, dt)
      expect(above.at(-1)).toBeCloseTo(EYE, 3)
      return times[above.findIndex(a => a < EYE + 0.01)]!
    }
    const time = await fall(steps, dt)
    // A fall of 20 m takes √(2 × 20 / 9.81) = 2.02 s, and the eye then settles on its spring.
    expect(time).toBeGreaterThan(1.95)
    expect(time).toBeLessThan(2.2)
    expect(Math.abs(time - (await fall(0, DT)))).toBeLessThan(0.05)
  })
})
