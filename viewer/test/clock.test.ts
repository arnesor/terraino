import * as THREE from 'three'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { formatFactor, GameClock, MAX_STEP, TIME_FACTORS } from '../src/clock'
import { CourseRun } from '../src/course'
import { syntheticWorld } from './synthetic'

// course.ts loads the UI texts, which pick a language from the page's URL, and draws the
// banners and code plates on canvases, which only need to exist here.
vi.hoisted(() => vi.stubGlobal('location', { search: '' }))
const context = new Proxy({} as Record<string | symbol, unknown>, {
  get: (target, key) => (key in target ? target[key] : () => ({ width: 10 })),
})
vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) })
afterAll(() => vi.unstubAllGlobals())

const FPS = 60
const DT = 1 / FPS

describe('time factor', () => {
  it('steps up and down the ladder, between 1× and 10×', () => {
    const clock = new GameClock()
    expect(clock.factor).toBe(1)
    clock.slower()
    expect(clock.factor).toBe(1)
    const seen = [clock.factor]
    for (let i = 0; i < 10; i++) {
      clock.faster()
      seen.push(clock.factor)
    }
    expect(seen).toEqual([...TIME_FACTORS, 10, 10, 10])
    clock.slower()
    expect(clock.factor).toBe(8)
  })

  it('is shown with one decimal', () => {
    expect(formatFactor(2)).toBe('2.0×')
    expect(formatFactor(1.5)).toBe('1.5×')
  })
})

describe('game time', () => {
  it('runs at the time factor, without drifting over a long run', () => {
    const clock = new GameClock()
    clock.faster()
    clock.faster() // 2×
    for (let i = 0; i < 25 * 60 * FPS; i++) clock.advance(DT)
    // 25 minutes of real time are 50 minutes of game time.
    expect(clock.time).toBeCloseTo(50 * 60, 6)
  })

  it('moves the game on in short steps that add up to the frame', () => {
    const clock = new GameClock()
    for (let i = 0; i < 7; i++) clock.faster() // 10×
    const steps: number[] = []
    let last = 0
    expect(
      clock.advance(0.1, {}, step => {
        steps.push(step)
        // The clock has moved on by the step when it is taken.
        expect(clock.time - last).toBeCloseTo(step, 12)
        last = clock.time
      }),
    ).toBeCloseTo(1, 12)
    expect(steps.length).toBe(30)
    for (const step of steps) expect(step).toBeLessThanOrEqual(MAX_STEP)
    expect(clock.time).toBeCloseTo(1, 12)
  })

  it('stands still while paused, and keeps real time while flying', () => {
    const clock = new GameClock()
    for (let i = 0; i < 7; i++) clock.faster() // 10×
    expect(clock.advance(0.1, { paused: true })).toBe(0)
    expect(clock.advance(0.1, { paused: true, flying: true })).toBe(0)
    expect(clock.advance(0.1, { flying: true })).toBeCloseTo(0.1, 12)
    expect(clock.advance(0.1)).toBeCloseTo(1, 12)
    expect(clock.time).toBeCloseTo(1.1, 12)
  })
})

describe('run time', () => {
  /**
   * Run a course east along z = 128 at 4 m/s of game time, at time factor `steps` up the
   * ladder, with real frames of `dt` and a pause of `pause` real seconds after 10 game
   * seconds. Returns the splits, the real time it took, and each call of the punch listener
   * (the index and the run's state then).
   */
  async function race(steps: number, dt = DT, pause = 0) {
    const { world, heights } = await syntheticWorld(1, 1)
    // Start, control 1 and finish at scene x = 30, 130 and 230 (northing = 256 - z).
    const course = { controls: [30, 130, 230].map((x): [number, number] => [x, 128]) }
    const run = new CourseRun(world, heights, course)
    const punches: [number, string][] = []
    run.punchListener = index => punches.push([index, run.state])
    const clock = new GameClock()
    for (let i = 0; i < steps; i++) clock.faster()
    // From 8 m behind the start, where T puts the runner.
    const pos = new THREE.Vector3(22, 100, 128)
    let real = 0
    let paused = 0
    while (run.state !== 'finished' && real < 1000) {
      const pausing = clock.time >= 10 && paused < pause
      clock.advance(dt, { paused: pausing }, step => {
        pos.x += 4 * step
        run.update(pos, clock.time)
      })
      if (pausing) paused += dt
      real += dt
    }
    return { splits: run.splits, elapsed: run.elapsed(clock.time), real, route: run.route, punches }
  }

  // The clock starts as the runner passes the start at x = 30; it punches 2.5 m before each control.
  const SPLITS = [(127.5 - 30) / 4, (227.5 - 30) / 4]
  // The start and each punch are seen at the end of a step; a punch records whole seconds.
  const expectSplits = (splits: number[]) => {
    expect(splits).toHaveLength(2)
    for (const [i, split] of splits.entries()) {
      expect(Number.isInteger(split)).toBe(true)
      expect(split).toBeGreaterThan(SPLITS[i]! - MAX_STEP - 1)
      expect(split).toBeLessThanOrEqual(SPLITS[i]! + MAX_STEP)
    }
  }

  it.each([
    [0, DT],
    [6, DT],
    [7, DT],
    [0, 0.1],
    [6, 0.1],
    [7, 0.1],
  ])('is the same at any factor and frame rate (ladder step %i, frames of %f s)', async (steps, dt) => {
    const factor = TIME_FACTORS[steps]!
    const { splits, elapsed, real } = await race(steps, dt)
    expectSplits(splits)
    expect(elapsed).toBe(splits.at(-1))
    // The 51.4 s from x = 22 to the finish take a tenth of that in real time at 10×.
    expect(Math.abs(real - (SPLITS[1]! + 8 / 4) / factor)).toBeLessThanOrEqual(dt)
  })

  it('records the route, a point per second of game time, at any factor', async () => {
    for (const [steps, dt] of [
      [0, DT],
      [7, 0.1],
    ] as const) {
      const { route } = await race(steps, dt)
      // The start, one point a second, and the finish.
      expect(route.length).toBe(Math.ceil(SPLITS[1]!) + 1)
      // Projected positions along the line z = 128 (northing 128), at 4 m/s from x = 30.
      expect(route[0]![0]).toBeCloseTo(30, 0)
      expect(route[10]![0]).toBeCloseTo(30 + 40, 0)
      expect(route.at(-1)![0]).toBeCloseTo(227.5, 0)
      for (const [, n] of route) expect(n).toBeCloseTo(128, 6)
    }
  })

  it('tells the punch listener (which beeps) at the start and at each punch', async () => {
    const { punches } = await race(0)
    expect(punches).toEqual([
      [0, 'running'],
      [1, 'running'],
      [2, 'finished'],
    ])
  })

  it('starts only under the start banner, not when running past beside it', async () => {
    const { world, heights } = await syntheticWorld(1, 1)
    const run = new CourseRun(world, heights, { controls: [30, 130, 230].map((x): [number, number] => [x, 128]) })
    // Banner 3 m wide across x = 30: 6 m to the side of its middle is past it.
    for (const [z, state] of [
      [134, 'ready'],
      [130, 'running'],
    ] as const) {
      run.reset()
      for (let x = 22; x < 40; x += 0.1) run.update(new THREE.Vector3(x, 100, z), x)
      expect(run.state).toBe(state)
    }
  })

  it('does not count a pause, even at 10× with long frames', async () => {
    const { splits, real } = await race(7, 0.1, 30)
    expectSplits(splits)
    expect(real).toBeGreaterThan(30)
  })
})
