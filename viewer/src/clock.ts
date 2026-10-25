import { formatNumber } from './i18n'

/** The time factors E and Q step through: game seconds per real second. */
export const TIME_FACTORS = [1, 1.5, 2, 3, 4, 6, 8, 10] as const

// Longest step (s of game time) the game moves on by at once. A long frame, as at a high
// time factor, is cut into steps this long, so a runner moves under 20 cm a step: through
// no trunk or wall, and past no control without punching it.
export const MAX_STEP = 1 / 30

/**
 * Game time: the simulated time that passes in the terrain, `time factor` times as fast
 * as real time. Run times and splits are measured in it.
 */
export class GameClock {
  /** Game time in seconds since the clock was made. */
  time = 0
  private index = 0

  /** Game seconds per real second, never below 1. */
  get factor(): number {
    return TIME_FACTORS[this.index]!
  }

  faster() {
    this.index = Math.min(this.index + 1, TIME_FACTORS.length - 1)
  }

  slower() {
    this.index = Math.max(this.index - 1, 0)
  }

  /**
   * Advance by `realDt` seconds of real time and return the game seconds that passed:
   * none while paused, and real time while flying, which the factor does not speed up.
   * `step` is called for each step of at most MAX_STEP, after the clock has moved on by it.
   */
  advance(realDt: number, { paused = false, flying = false } = {}, step: (dt: number) => void = () => {}): number {
    const dt = paused ? 0 : flying ? realDt : realDt * this.factor
    const steps = Math.ceil(dt / MAX_STEP)
    const start = this.time
    for (let i = 1; i <= steps; i++) {
      this.time = start + (dt * i) / steps
      step(dt / steps)
    }
    return dt
  }
}

/** A time factor as shown on screen, such as 2.0×. */
export function formatFactor(factor: number): string {
  return `${formatNumber(factor, 1)}×`
}
