// Where a control flag stands, from its control description: the feature in column D
// is looked up among the world's features (boulders, buildings, cliffs, walls …) near
// the centre of the control circle, and column G says on which side of it the flag
// goes ("north side", "west foot", "south-east corner" …). All positions are scene x, z.

import { DIRECTION_VECTORS, decode, location } from './descriptions/codes'
import type { Description } from './ocad/courses'

export type XZ = [number, number]

/** The world's features, as in features.json and buildings.json (scene coordinates). */
export interface PlacementData {
  kinds: string[]
  /** [kind index, x, z, size, angle] */
  points: [number, number, number, number, number][]
  lines: { kind: string; points: XZ[]; poles?: XZ[] }[]
  /** Points are [x, height, z]. */
  cliffs: { top: [number, number, number][]; bottom: [number, number, number][] }[]
  /** Building outlines. */
  buildings: XZ[][]
  heightAt?: (x: number, z: number) => number
}

// How far the flag stands from the edge of its feature.
const CLEARANCE = 0.6
// How far from the circle centre to look for the feature.
const SEARCH_POINT = 12
const SEARCH_AREA = 20
// Flag stand radius, kept clear of rocks and walls.
const STAND_RADIUS = 0.3
// Size of features that are not in the world's data (knolls, depressions …).
const DEFAULT_RADIUS: Record<string, number> = { '1.9': 12, '1.10': 2.5, '1.12': 6, '1.13': 1.5, '1.14': 1.5 }
const FALLBACK_RADIUS = 1

/** Features of column D, as kinds in features.json. */
const POINT_KINDS: Record<string, string[]> = {
  '1.13': ['small_depression'],
  '1.14': ['pit'],
  '2.2': ['boulder'],
  '2.4': ['boulder'],
  '2.6': ['boulder'],
  '3.3': ['waterhole'],
  '5.15': ['tower'],
  '5.17': ['cairn'],
  '5.18': ['fodder_rack'],
}
// Half the base width of an earth wall (EARTH_WALL_WIDTH_M in process/features.py): the
// flag stands on top of it, or at its foot on the side column G names.
const EARTH_WALL_HALF_WIDTH = 2
// Hollows: the flag stands at the bottom, or on the rim in the direction column G names.
const HOLLOWS = new Set(['pit', 'small_depression'])
// Column G locations that keep the flag at the bottom of a hollow, even with a direction.
const BOTTOM = new Set(['part', 'top', 'beneath', 'lowerPart'])
const LINE_KINDS: Record<string, string[]> = {
  '1.6': ['earth_wall'],
  '4.7': ['vegetation_boundary'],
  '5.8': ['stone_wall', 'ruined_wall'],
  '5.9': ['fence', 'ruined_fence'],
  '5.13': ['ruin'],
}
const BUILDING = new Set(['5.11', '5.21'])
const CLIFF = new Set(['2.1', '2.9'])
const PYLON = '5.6'
// Landforms whose foot and top can be found in the terrain.
const LANDFORMS = new Set(['1.2', '1.9', '1.10'])

type Feature =
  | { type: 'circle'; centre: XZ; radius: number; hollow?: boolean }
  | { type: 'polygon'; points: XZ[] }
  | { type: 'line'; points: XZ[]; earthWall?: boolean }
  | { type: 'cliff'; top: XZ[]; bottom: XZ[] }

const sub = (a: XZ, b: XZ): XZ => [a[0] - b[0], a[1] - b[1]]
const add = (a: XZ, b: XZ, k = 1): XZ => [a[0] + b[0] * k, a[1] + b[1] * k]
const dot = (a: XZ, b: XZ) => a[0] * b[0] + a[1] * b[1]
const length = (a: XZ) => Math.hypot(a[0], a[1])
const unit = (a: XZ): XZ => {
  const l = length(a)
  return l > 1e-9 ? [a[0] / l, a[1] / l] : [0, 0]
}

function closestOnSegment(p: XZ, a: XZ, b: XZ): XZ {
  const ab = sub(b, a)
  const t = Math.min(Math.max(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0), 1)
  return add(a, ab, t)
}

function closestOnLine(p: XZ, points: XZ[], closed = false): XZ {
  let best: XZ = points[0] ?? p
  let bestD = Infinity
  const n = points.length
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const q = closestOnSegment(p, points[i]!, points[(i + 1) % n]!)
    const d = length(sub(q, p))
    if (d < bestD) {
      bestD = d
      best = q
    }
  }
  return best
}

function distanceToLine(p: XZ, points: XZ[], closed = false): number {
  return points.length ? length(sub(closestOnLine(p, points, closed), p)) : Infinity
}

export function inside(p: XZ, polygon: XZ[]): boolean {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) result = !result
  }
  return result
}

function centroid(points: XZ[]): XZ {
  const s = points.reduce<XZ>((acc, q) => add(acc, q), [0, 0])
  return [s[0] / points.length, s[1] / points.length]
}

/** Where a ray from inside a polygon leaves it. */
function rayExit(from: XZ, dir: XZ, polygon: XZ[]): XZ {
  let best = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    const e = sub(b, a)
    const denom = dir[0] * e[1] - dir[1] * e[0]
    if (Math.abs(denom) < 1e-9) continue
    const w = sub(a, from)
    const t = (w[0] * e[1] - w[1] * e[0]) / denom
    const u = (w[0] * dir[1] - w[1] * dir[0]) / denom
    if (t > best && u >= 0 && u <= 1) best = t
  }
  return add(from, dir, best)
}

const flat = (pts: [number, number, number][]): XZ[] => pts.map(([x, , z]) => [x, z])

function findFeature(ref: string | undefined, centre: XZ, data: PlacementData): Feature | null {
  if (!ref) return null
  const kinds = POINT_KINDS[ref]
  if (kinds) {
    let best: Feature | null = null
    let bestD = SEARCH_POINT
    for (const [k, x, z, size] of data.points) {
      if (!kinds.includes(data.kinds[k] ?? '')) continue
      const d = Math.hypot(x - centre[0], z - centre[1])
      if (d < bestD) {
        bestD = d
        // Boulders are drawn about 1.3–1.7 times as wide as they are high.
        const kind = data.kinds[k] ?? ''
        const radius = kind === 'boulder' ? size * 0.8 : Math.max(size / 2, 0.5)
        best = { type: 'circle', centre: [x, z], radius, hollow: HOLLOWS.has(kind) }
      }
    }
    return best
  }
  if (ref === PYLON) {
    let best: XZ | null = null
    for (const line of data.lines) {
      for (const p of line.poles ?? []) {
        if (length(sub(p, centre)) < SEARCH_POINT && (!best || length(sub(p, centre)) < length(sub(best, centre)))) {
          best = p
        }
      }
    }
    return best ? { type: 'circle', centre: best, radius: 0.5 } : null
  }
  const lineKinds = LINE_KINDS[ref]
  if (lineKinds) {
    let best: Feature | null = null
    let bestD = SEARCH_AREA
    for (const line of data.lines) {
      if (!lineKinds.includes(line.kind)) continue
      const d = distanceToLine(centre, line.points)
      if (d < bestD) {
        bestD = d
        const closed = line.points.length > 3 && length(sub(line.points[0]!, line.points.at(-1)!)) < 0.5
        if (line.kind === 'earth_wall') best = { type: 'line', points: line.points, earthWall: true }
        else if (closed) best = { type: 'polygon', points: line.points }
        else best = { type: 'line', points: line.points }
      }
    }
    return best
  }
  if (BUILDING.has(ref)) {
    let best: XZ[] | null = null
    let bestD = SEARCH_AREA
    for (const outline of data.buildings) {
      const d = inside(centre, outline) ? 0 : distanceToLine(centre, outline, true)
      if (d < bestD) {
        bestD = d
        best = outline
      }
    }
    return best ? { type: 'polygon', points: best } : null
  }
  if (CLIFF.has(ref)) {
    let best: Feature | null = null
    let bestD = SEARCH_POINT
    for (const cliff of data.cliffs) {
      const top = flat(cliff.top)
      const bottom = flat(cliff.bottom)
      const d = Math.min(distanceToLine(centre, top), distanceToLine(centre, bottom))
      if (d < bestD) {
        bestD = d
        best = { type: 'cliff', top, bottom }
      }
    }
    return best
  }
  return null
}

/** Walk from `from` along `dir` until the ground stops falling: the foot of a slope. */
function terrainFoot(from: XZ, dir: XZ, heightAt: (x: number, z: number) => number, maxDistance: number): XZ | null {
  const h0 = heightAt(...from)
  let previous = h0
  for (let s = 1; s <= maxDistance; s++) {
    const p = add(from, dir, s)
    const h = heightAt(...p)
    if (h0 - h > 0.8 && previous - h < 0.08) return p
    previous = h
  }
  return null
}

/** The highest ground within `radius` of `centre`. */
function terrainTop(centre: XZ, heightAt: (x: number, z: number) => number, radius: number): XZ {
  let best = centre
  let bestH = heightAt(...centre)
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue
      const p: XZ = [centre[0] + dx, centre[1] + dz]
      const h = heightAt(...p)
      if (h > bestH) {
        bestH = h
        best = p
      }
    }
  }
  return best
}

/** The polygon corner furthest in direction `dir`. */
function cornerToward(points: XZ[], dir: XZ): XZ {
  return points.reduce((best, p) => (dot(p, dir) > dot(best, dir) ? p : best), points[0]!)
}

/** True if something solid (a building or a boulder) stands within `margin` of `p`. */
export function blocked(data: PlacementData, p: XZ, margin = 0.4): boolean {
  for (const outline of data.buildings) {
    if (outline.length < 3) continue
    if (inside(p, outline) || distanceToLine(p, outline, true) < margin) return true
  }
  for (const [k, x, z, size] of data.points) {
    if (data.kinds[k] === 'boulder' && Math.hypot(p[0] - x, p[1] - z) < size * 0.8 + margin) return true
  }
  return false
}

/** Move `p` out of rocks and buildings, so the stand does not end up inside one. */
function clearOf(p: XZ, data: PlacementData): XZ {
  let q = p
  for (const outline of data.buildings) {
    if (outline.length < 3 || distanceToLine(q, outline, true) > SEARCH_AREA) continue
    if (inside(q, outline)) {
      const edge = closestOnLine(q, outline, true)
      q = add(edge, unit(sub(edge, centroid(outline))), CLEARANCE)
    }
  }
  for (const [k, x, z, size] of data.points) {
    if (data.kinds[k] !== 'boulder') continue
    const away = sub(q, [x, z])
    const min = size * 0.8 + STAND_RADIUS
    const d = length(away)
    if (d < min) q = d > 1e-6 ? add([x, z], away, min / d) : [x + min, z]
  }
  return q
}

/**
 * Scene position of a control flag. `centre` is the centre of the control circle,
 * `previous` where the runner comes from (the side used when column G is empty).
 */
export function placeFlag(description: Description, centre: XZ, data: PlacementData, previous?: XZ): XZ {
  const ref = decode(description.d)?.ref
  const g = location(description.g)
  // Directions are east/north; scene z points south.
  const dir: XZ | null = g?.direction
    ? [DIRECTION_VECTORS[g.direction][0], -DIRECTION_VECTORS[g.direction][1]]
    : null
  const toward = previous && length(sub(previous, centre)) > 1 ? unit(sub(previous, centre)) : ([0, 1] as XZ)
  const feature = findFeature(ref, centre, data)
  const heightAt = data.heightAt
  const loc = g?.location
  const side = dir ?? toward

  let p: XZ = centre
  if (feature?.type === 'circle' && feature.hollow) {
    p = dir && !BOTTOM.has(loc ?? '') ? add(feature.centre, dir, feature.radius) : feature.centre
  } else if (feature?.type === 'circle') {
    p = loc === 'top' || loc === 'beneath' ? feature.centre : add(feature.centre, side, feature.radius + CLEARANCE)
  } else if (feature?.type === 'polygon') {
    const c = centroid(feature.points)
    if (loc === 'insideCorner' || loc === 'outsideCorner' || loc === 'tip') {
      p = add(cornerToward(feature.points, side), side, CLEARANCE)
    } else if (loc === 'part') {
      p = add(c, sub(rayExit(c, side, feature.points), c), 0.5)
    } else if (dir) {
      p = add(rayExit(c, dir, feature.points), dir, CLEARANCE)
    } else {
      // Beside the feature, on the side the runner comes from.
      p = add(rayExit(c, toward, feature.points), toward, CLEARANCE)
    }
  } else if (feature?.type === 'line' && feature.earthWall) {
    const ends = [feature.points[0]!, feature.points.at(-1)!]
    if (loc === 'end' && dir) {
      p = add(cornerToward(ends, dir), dir, EARTH_WALL_HALF_WIDTH)
    } else if (loc === 'end') {
      p = cornerToward(ends, sub(centre, centroid(ends)))
    } else if (dir && loc !== 'top' && loc !== 'part') {
      p = add(closestOnLine(centre, feature.points), dir, EARTH_WALL_HALF_WIDTH)
    } else {
      p = closestOnLine(centre, feature.points)
    }
  } else if (feature?.type === 'line') {
    if (loc === 'end' || loc === 'tip') {
      const ends = [feature.points[0]!, feature.points.at(-1)!]
      p = add(cornerToward(ends, side), side, CLEARANCE)
    } else if (loc === 'insideCorner' || loc === 'outsideCorner') {
      p = add(cornerToward(feature.points, side), side, CLEARANCE)
    } else {
      p = add(closestOnLine(centre, feature.points), side, CLEARANCE)
    }
  } else if (feature?.type === 'cliff') {
    if (loc === 'top') {
      const top = closestOnLine(centre, feature.top)
      p = add(top, unit(sub(top, closestOnLine(top, feature.bottom))), CLEARANCE)
    } else {
      // The foot is where a flag on a cliff goes unless the description says otherwise.
      const from = dir ? cornerToward(feature.bottom, dir) : closestOnLine(centre, feature.bottom)
      const bottom = dir ? from : closestOnLine(from, feature.bottom)
      const away = unit(sub(bottom, closestOnLine(bottom, feature.top)))
      p = add(bottom, length(away) ? away : side, CLEARANCE)
    }
  } else if (ref && LANDFORMS.has(ref) && heightAt) {
    const radius = DEFAULT_RADIUS[ref] ?? FALLBACK_RADIUS
    const top = terrainTop(centre, heightAt, Math.min(radius, 6))
    if (loc === 'foot' || loc === 'side') {
      p = terrainFoot(top, side, heightAt, radius * 3) ?? add(top, side, radius)
    } else {
      p = top
    }
  } else if (dir && ref) {
    p = add(centre, dir, (DEFAULT_RADIUS[ref] ?? FALLBACK_RADIUS) + CLEARANCE)
  }
  return clearOf(p, data)
}
