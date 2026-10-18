import { describe, expect, it } from 'vitest'
import type { Control } from '../src/course'
import { fitRectangle, legIndices } from '../src/mapview'

const course: Control[] = [
  [0, 0],
  [100, 0],
  [100, 200],
  [300, 200],
  [300, 400],
]
const runner: Control = [50, 10]

/** Screen position (pixels from the window centre) of a point, as the map draws it. */
function screen([e, n]: Control, centre: Control, zoom: number, rotation: number): [number, number] {
  const x = (e - centre[0]) * zoom
  const y = -(n - centre[1]) * zoom
  return [x * Math.cos(rotation) - y * Math.sin(rotation), x * Math.sin(rotation) + y * Math.cos(rotation)]
}

describe('leg controls', () => {
  it('shows the first two legs before the start', () => {
    expect(legIndices(5, 'ready', 0)).toEqual([0, 1, 2])
  })

  it('shows the leg being run and the next one', () => {
    expect(legIndices(5, 'running', 2)).toEqual([1, 2, 3])
    // Running to the finish: there is no leg after it.
    expect(legIndices(5, 'running', 4)).toEqual([3, 4])
  })

  it('shows the whole course after the finish', () => {
    expect(legIndices(5, 'finished', 5)).toEqual([0, 1, 2, 3, 4])
  })

  it('shows nothing without a course', () => {
    expect(legIndices(1, 'ready', 0)).toEqual([])
  })
})

describe('fitting the legs in the map window', () => {
  const points = [...legIndices(course.length, 'running', 2).map(i => course[i]!), runner]
  it.each([
    ['wide, north up', [800, 400], 0],
    ['tall, north up', [400, 800], 0],
    ['wide, turned', [800, 400], 1.1],
    ['tall, turned', [400, 800], -2.5],
  ] as const)('keeps every point inside the margin (%s)', (_name, size, rotation) => {
    const margin = 30
    const { centre, zoom } = fitRectangle(points, rotation, [size[0], size[1]], margin, 150)
    for (const p of points) {
      const [x, y] = screen(p, centre, zoom, rotation)
      expect(Math.abs(x)).toBeLessThanOrEqual(size[0] / 2 - margin * zoom + 1e-6)
      expect(Math.abs(y)).toBeLessThanOrEqual(size[1] / 2 - margin * zoom + 1e-6)
    }
    // It fills the window in one direction: the zoom is not smaller than it has to be.
    const widest = Math.max(...points.map(p => Math.abs(screen(p, centre, zoom, rotation)[0]) / (size[0] / 2)))
    const tallest = Math.max(...points.map(p => Math.abs(screen(p, centre, zoom, rotation)[1]) / (size[1] / 2)))
    expect(Math.max(widest, tallest)).toBeGreaterThan(0.6)
  })

  it('keeps the inset free', () => {
    const size: [number, number] = [600, 500]
    const inset = { top: 90, right: 0, bottom: 0, left: 0 }
    for (const rotation of [0, 0.7]) {
      const { centre, zoom } = fitRectangle(points, rotation, size, 30, 150, inset)
      for (const p of points) {
        const [x, y] = screen(p, centre, zoom, rotation)
        expect(y + size[1] / 2).toBeGreaterThanOrEqual(inset.top - 1e-6)
        expect(Math.abs(x)).toBeLessThanOrEqual(size[0] / 2 + 1e-6)
        expect(y).toBeLessThanOrEqual(size[1] / 2 + 1e-6)
      }
    }
  })

  it('shows at least the minimum span', () => {
    const { centre, zoom } = fitRectangle([[10, 10]], 0, [600, 400], 5, 150)
    expect(centre[0]).toBeCloseTo(10)
    expect(centre[1]).toBeCloseTo(10)
    expect(400 / zoom).toBeGreaterThanOrEqual(150 - 1e-9)
  })
})
