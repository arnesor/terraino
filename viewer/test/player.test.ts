import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeightField } from '../src/heightfield'
import { Player } from '../src/player'
import { CHUNK, syntheticWorld } from './synthetic'

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
    key('keydown', 'ShiftLeft')
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
    key('keydown', 'ShiftLeft')
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
    key('keydown', 'ShiftLeft')
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
  it('jumps as high as before and lands softly', async () => {
    const { player, heights, key } = await setup(() => 100)
    player.placeAt(128, 128)
    key('keydown', 'Space')
    key('keyup', 'Space')
    const { above } = frames(player, heights, 2)
    // A jump at 3.5 m/s rises 3.5² / (2 × 9.81) = 0.62 m.
    expect(Math.max(...above) - EYE).toBeGreaterThan(0.55)
    expect(Math.max(...above) - EYE).toBeLessThan(0.65)
    expect(Math.min(...above)).toBeGreaterThan(EYE - 0.1)
    expect(above.at(-1)).toBeCloseTo(EYE, 3)
  })

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
    key('keydown', 'ShiftLeft')
    let onDeck = 0
    for (let i = 0; i < 4 * FPS; i++) {
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
    key('keydown', 'Space') // fly up
    frames(player, heights, 0.5)
    key('keyup', 'Space')
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
