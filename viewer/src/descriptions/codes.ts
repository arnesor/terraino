// OCAD control description codes to IOF symbols.
//
// OCAD writes the IOF 2024 reference with three decimals: "2.004" is 2.4 Boulder,
// "5.011" is 5.11 Building. Symbols that point in a direction carry the direction
// after the reference number: "12.105" is 12.1 Side with variant 05 (north-west),
// "12.122" is 12.12 Foot with variant 2 (west), "0.103" is 0.1 with variant 03 (south).
//
// The drawings come from Purple Pen (symbols.json), which uses the IOF 2004 numbers
// for columns F, G and H and the 2004 ids for a few man-made features.

import data from './symbols.json'

export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

/** Unit vector (east, north) of each direction. */
export const DIRECTION_VECTORS: Record<Direction, [number, number]> = {
  N: [0, 1],
  NE: [Math.SQRT1_2, Math.SQRT1_2],
  E: [1, 0],
  SE: [Math.SQRT1_2, -Math.SQRT1_2],
  S: [0, -1],
  SW: [-Math.SQRT1_2, -Math.SQRT1_2],
  W: [-1, 0],
  NW: [-Math.SQRT1_2, Math.SQRT1_2],
}

// OCAD's direction variants. Seen in course files: 1 N, 2 W, 3 S, 4 E, 5 NW, 6 SW
// (the four main directions turning anticlockwise, then the diagonals);
// 7 SE and 8 NE follow the same pattern but have not been seen yet.
const VARIANTS: Direction[] = ['N', 'W', 'S', 'E', 'NW', 'SW', 'SE', 'NE']

export interface SymbolShapeData {
  kind: string
  names: { en?: string; nb?: string }
  shapes: (string | number)[][]
}

export const SYMBOLS = (data as { symbols: Record<string, SymbolShapeData> }).symbols

/** Column G location of the control flag, as IOF 2024 numbers it (12.x). */
export type Location =
  | 'side'
  | 'edge'
  | 'part'
  | 'insideCorner'
  | 'outsideCorner'
  | 'tip'
  | 'end'
  | 'upperPart'
  | 'lowerPart'
  | 'top'
  | 'foot'
  | 'beneath'
  | 'between'

const LOCATIONS: Record<number, [Location, string]> = {
  1: ['side', '11.1'],
  2: ['edge', '11.2'],
  3: ['part', '11.3'],
  4: ['insideCorner', '11.4'],
  5: ['outsideCorner', '11.5'],
  6: ['tip', '11.6'],
  7: ['end', '11.8'],
  8: ['upperPart', '11.9'],
  9: ['lowerPart', '11.10'],
  10: ['top', '11.11'],
  11: ['foot', '11.13'],
  12: ['foot', '11.14'],
  13: ['beneath', '11.12'],
  14: ['between', '11.15'],
}

// IOF 2024 man-made features renumbered since 2004 (Purple Pen's ids).
const FEATURE_IDS: Record<string, string> = { '5.21': '5.23', '5.22': '5.24', '5.23': '5.25', '5.24': '5.26' }
// Column H: IOF 2024 13.x to Purple Pen's 12.x.
const OTHER_IDS: Record<string, string> = { '13.1': '12.1', '13.2': '12.2', '13.3': '12.4' }

export interface Decoded {
  /** IOF 2024 reference, for example "12.1". */
  ref: string
  group: number
  minor: number
  direction?: Direction
}

/** Split an OCAD code into its IOF reference and direction; null if it is not a code. */
export function decode(code: string | undefined): Decoded | null {
  const m = code?.trim().match(/^(\d+)\.(\d{3})$/)
  if (!m) return null
  const group = Number(m[1])
  const digits = m[2]!
  let minor: number
  let variant = 0
  if (digits[0] === '0') {
    minor = Number(digits)
  } else if (digits[1] === '0') {
    minor = Number(digits[0])
    variant = Number(digits[2])
  } else {
    minor = Number(digits.slice(0, 2))
    variant = Number(digits[2])
  }
  const direction = variant ? VARIANTS[variant - 1] : undefined
  return { ref: `${group}.${minor}`, group, minor, ...(direction ? { direction } : {}) }
}

/** The column G location of the flag, and its direction, if the code is one. */
export function location(code: string | undefined): { location: Location; direction?: Direction } | null {
  const d = decode(code)
  if (!d || d.group !== 12) return null
  const entry = LOCATIONS[d.minor]
  if (!entry) return null
  return { location: entry[0], ...(d.direction ? { direction: d.direction } : {}) }
}

/**
 * Purple Pen symbol id for a description code in `column` (C–H), or null when there is
 * no drawing for it. `single` tells whether column E is empty, for the crossing, junction
 * and between symbols that then refer to two features of the same kind.
 */
export function symbolId(column: string, code: string | undefined, single = false): string | null {
  const d = decode(code)
  if (!d) return null
  let id: string | null = null
  const dir = d.direction
  switch (column) {
    case 'c':
      if (d.minor === 1 || d.minor === 2) {
        if (dir) id = `${dir.length === 1 ? '0.1' : '0.2'}${dir}`
      } else {
        id = d.ref
      }
      break
    case 'd':
      id = FEATURE_IDS[d.ref] ?? d.ref
      break
    case 'e':
      // Column E holds an appearance (8.x) or a second feature (as in column D).
      id = d.group === 8 ? d.ref : (FEATURE_IDS[d.ref] ?? d.ref)
      break
    case 'f':
      if (d.ref === '9.1') id = '9.1high'
      else if (d.ref === '9.3') id = '9.3high'
      else if (d.ref === '10.1' || d.ref === '10.2') id = single ? `${d.ref}single` : d.ref
      else if (d.ref === '11.1') id = '11.7'
      else id = d.ref
      break
    case 'g': {
      const entry = LOCATIONS[d.minor]
      if (d.group !== 12 || !entry) break
      const base = entry[1]
      if (entry[0] === 'between') id = single ? `${base}single` : base
      else if (`${base}N` in SYMBOLS) id = `${base}${dir ?? 'N'}`
      else id = base
      break
    }
    case 'h':
      id = OTHER_IDS[d.ref] ?? null
      break
  }
  return id && id in SYMBOLS ? id : null
}
