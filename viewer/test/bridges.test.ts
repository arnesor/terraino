import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type BridgeRecord, Bridges, RAIL_M } from '../src/bridges'
import { Player, standsOnDeck } from '../src/player'
import { CHUNK, syntheticWorld } from './synthetic'

const FPS = 60
const DT = 1 / FPS
const EYE = 1.7

// A road along z = 128 over a valley 6 m deep between x = 40 and 60, on a deck from
// x = 38 to 62 at 100 m; a pillar in the middle of the span.
const DECK: BridgeRecord = {
  kind: 'paved',
  width: 8,
  speed: 1.25,
  points: [
    [38, 128, 100],
    [62, 128, 100],
  ],
  pillars: [12],
}
const valley = (col: number) => (col > 40 && col < 60 ? 94 : 100)

describe('decks', () => {
  const bridges = new Bridges([DECK])

  it('are found only between their ends and rails', () => {
    expect(bridges.heightAt(50, 128)).toBe(100)
    expect(bridges.heightAt(50, 128 + 4 + RAIL_M - 0.1)).toBe(100)
    expect(bridges.heightAt(50, 128 + 4 + RAIL_M + 0.1)).toBeNull()
    expect(bridges.heightAt(36, 128)).toBeNull()
    expect(bridges.speedAt(50, 128)).toBe(1.25)
  })

  it('keep a runner between their rails, but not at their ends', () => {
    const [, z] = bridges.collideOnDeck(50, 128 + 4.6, 0.3)
    expect(z).toBeCloseTo(128 + 4 + RAIL_M - 0.1 - 0.3)
    expect(bridges.collideOnDeck(37, 133, 0.3)).toEqual([37, 133])
  })

  it('push a runner below out of their pillars', () => {
    const [x] = bridges.collideBelow(50.2, 128, 0.3)
    expect(x).toBeCloseTo(50 + 0.4 + 0.3)
    expect(bridges.collideBelow(45, 128, 0.3)).toEqual([45, 128])
  })
})

describe('standing on a deck', () => {
  it('starts at its ends, from the road leading onto it', () => {
    expect(standsOnDeck(100, 100, 100)).toBe(true)
    expect(standsOnDeck(100, 94, 99.8)).toBe(true)
  })

  it('does not start from the ground under it, where there is room to pass', () => {
    expect(standsOnDeck(100, 94, 94)).toBe(false)
  })

  it('starts anywhere on a deck too low to pass under', () => {
    expect(standsOnDeck(100, 98.5, 98.5)).toBe(true)
  })

  it('needs a deck', () => {
    expect(standsOnDeck(null, 100, 100)).toBe(false)
  })
})

afterEach(() => vi.unstubAllGlobals())

/** A player on the valley world with the bridge, and its keyboard. */
async function setup() {
  const { heights } = await syntheticWorld(1, 1, valley)
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
  player.veer = 0
  player.glance = 0
  player.stumble = 0
  player.legs = 0
  const bridges = new Bridges([DECK])
  const speeds: number[] = []
  player.surroundings = {
    // Ground slower than the road, so the speed shows which one the runner is on.
    speedAt: (x, z, onDeck) => {
      const speed = (onDeck ? bridges.speedAt(x, z) : null) ?? 0.5
      speeds.push(speed)
      return speed
    },
    collide: (x, z, r, onDeck) => (onDeck ? bridges.collideOnDeck(x, z, r) : bridges.collideBelow(x, z, r)),
    deckAt: (x, z) => bridges.heightAt(x, z),
  }
  const key = (type: 'keydown' | 'keyup', code: string) => listeners.get(type)?.forEach(l => l({ code }))
  return { player, camera, heights, key, speeds }
}

describe('running over and under a bridge', () => {
  it('crosses on the deck at the road speed', async () => {
    const { player, camera, key, speeds } = await setup()
    player.placeAt(25, 128)
    camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ') // east
    key('keydown', 'KeyW')
    for (let i = 0; i < 40 * FPS && camera.position.x < 70; i++) {
      player.update(DT)
      expect(camera.position.y).toBeGreaterThan(100 + EYE - 0.2)
      if (camera.position.x > 42 && camera.position.x < 58) {
        expect(player.onDeck).toBe(true)
        expect(speeds.at(-1)).toBe(1.25)
      }
    }
    expect(camera.position.x).toBeGreaterThan(62)
  })

  it('passes under the deck on the ground', async () => {
    const { player, camera, key } = await setup()
    player.placeAt(45, 110)
    camera.rotation.set(0, Math.PI, 0, 'YXZ') // south
    key('keydown', 'KeyW')
    for (let i = 0; i < 40 * FPS && camera.position.z < 145; i++) {
      player.update(DT)
      expect(player.onDeck).toBe(false)
      expect(camera.position.y).toBeLessThan(94 + EYE + 0.2)
    }
    expect(camera.position.z).toBeGreaterThan(145)
  })

  it('cannot step off the side of the deck', async () => {
    const { player, camera, key } = await setup()
    player.placeAt(25, 128)
    camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ')
    key('keydown', 'KeyW')
    while (camera.position.x < 50) player.update(DT)
    key('keyup', 'KeyW')
    camera.rotation.set(0, Math.PI, 0, 'YXZ') // south, towards the rail
    key('keydown', 'KeyW')
    for (let i = 0; i < 4 * FPS; i++) player.update(DT)
    expect(player.onDeck).toBe(true)
    expect(camera.position.z).toBeLessThan(128 + 4 + RAIL_M)
    expect(camera.position.y).toBeGreaterThan(100 + EYE - 0.2)
  })
})
