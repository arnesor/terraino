// What the map window shows while running a course: the leg you are on and the next one.

import type { Control, RunState } from './course'

/** Share of the points' extent added on each side, besides the margin. */
const PADDING = 0.1

/** Pixels kept free along each edge of the map window (for the compass and the like). */
export interface Inset {
  top: number
  right: number
  bottom: number
  left: number
}

const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * Indices of the controls the map should show: before the start the first two legs,
 * while running the last punched control and the next two, after the finish the course.
 */
export function legIndices(count: number, state: RunState, next: number): number[] {
  if (count < 2) return []
  const all = [...Array(count).keys()]
  if (state === 'ready') return all.slice(0, 3)
  if (state === 'finished') return all
  return [next - 1, next, next + 1].filter(i => i >= 0 && i < count)
}

/**
 * Centre and zoom (screen pixels per metre) that fit `points` in a window of `size` pixels,
 * less `inset`, with the map turned by `rotation` (radians, clockwise on screen),
 * `marginM` metres around them and at least `minSpanM` metres across in both directions.
 */
export function fitRectangle(
  points: Control[],
  rotation: number,
  size: [number, number],
  marginM: number,
  minSpanM: number,
  inset: Inset = NO_INSET,
): { centre: Control; zoom: number } {
  const w = Math.max(size[0] - inset.left - inset.right, 1)
  const h = Math.max(size[1] - inset.top - inset.bottom, 1)
  const origin = points[0] ?? [0, 0]
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  // Screen directions (x right, y down) of each point, in metres from the first one.
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [e, n] of points) {
    const de = e - origin[0]
    const dn = n - origin[1]
    const x = de * c + dn * s
    const y = de * s - dn * c
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  const width = Math.max((x1 - x0) * (1 + 2 * PADDING) + 2 * marginM, minSpanM)
  const height = Math.max((y1 - y0) * (1 + 2 * PADDING) + 2 * marginM, minSpanM)
  const zoom = Math.min(w / width, h / height)
  // The middle of the box goes to the middle of the free part of the window, which lies
  // this far (in metres on screen) from the window's centre, where the map centre is drawn.
  const mx = (x0 + x1) / 2 - (inset.left - inset.right) / 2 / zoom
  const my = (y0 + y1) / 2 - (inset.top - inset.bottom) / 2 / zoom
  // Back from screen directions to east and north.
  const centre: Control = [origin[0] + mx * c + my * s, origin[1] + mx * s - my * c]
  return { centre, zoom }
}

/**
 * Screen position (pixels right and down from the window centre) of the map point
 * `[east, north]`, with `centre` in the middle of the window, `zoom` screen pixels per metre
 * and the map turned by `rotation` (radians, clockwise on screen).
 */
export function toScreen([e, n]: Control, centre: Control, zoom: number, rotation: number): [number, number] {
  const x = (e - centre[0]) * zoom
  const y = -(n - centre[1]) * zoom
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  return [x * c - y * s, x * s + y * c]
}

/** The map point at a screen position (pixels from the window centre); undoes toScreen. */
export function fromScreen([x, y]: [number, number], centre: Control, zoom: number, rotation: number): Control {
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  const ux = x * c + y * s
  const uy = -x * s + y * c
  return [centre[0] + ux / zoom, centre[1] - uy / zoom]
}

/**
 * The map centre that keeps `pivot` where it is on screen when the map, now turned by
 * `rotation`, turns on by `delta`.
 */
export function turnAround(pivot: Control, centre: Control, zoom: number, rotation: number, delta: number): Control {
  const after = fromScreen(toScreen(pivot, centre, zoom, rotation), centre, zoom, rotation + delta)
  return [centre[0] + pivot[0] - after[0], centre[1] + pivot[1] - after[1]]
}
