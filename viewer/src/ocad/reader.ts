// A small reader for OCAD files (version 12 and newer), written from OCAD's published
// file format description. It reads only what course setting needs: the parameter
// strings (courses, georeferencing, settings) and the course setting objects.
//
// Layout: a file header points to chains of index blocks. Each string index block holds
// 256 entries (position, length, record type, object); each object index block holds
// 256 entries of 40 bytes pointing to the objects. Coordinates are in 1/100 mm on paper,
// stored as 32-bit values whose lowest 8 bits are flags.

export class OcadError extends Error {
  /** Why reading failed, for a translated message: not OCAD, or an unsupported version. */
  readonly reason: 'not-ocad' | 'version'
  readonly version: number

  constructor(reason: 'not-ocad' | 'version', version = 0) {
    super(reason === 'not-ocad' ? 'Not an OCAD file' : `OCAD version ${version} is not supported`)
    this.reason = reason
    this.version = version
  }
}

/** A parameter string: `first\tXvalue\tYvalue…`, with the values of each code letter. */
export interface ParameterString {
  type: number
  first: string
  values: Map<string, string[]>
  /** The code-value pairs in file order (courses interleave start, controls and finish). */
  pairs: [string, string][]
}

export interface OcadObject {
  /** Symbol number as OCAD shows it, for example "703.0". */
  symbol: string
  /** Object type: 1 point, 2 line, 3 area, 4 unformatted text, 5 formatted text … */
  type: number
  /** Coordinates on paper, in 1/100 mm (x east, y north). */
  points: [number, number][]
  text: string
  /** Extra data; for course setting objects, the control's code and description. */
  objectString: string
}

export interface OcadFile {
  version: number
  subVersion: number
  strings: ParameterString[]
  objects: OcadObject[]
}

const OCAD_MARK = 0x0cad
const MIN_VERSION = 12
const INDEX_ENTRIES = 256
const OBJECT_INDEX_BYTES = 40
const OBJECT_HEADER_BYTES = 56
// Text and object strings are stored in units of one coordinate: 8 bytes.
const TEXT_UNIT_BYTES = 8
// Object status in the index: 1 normal, 2 hidden, 3 deleted.
const STATUS_DELETED = 3

/** Value of a parameter string code, or `fallback`. */
export function param(s: ParameterString | undefined, code: string, fallback = ''): string {
  return s?.values.get(code)?.[0] ?? fallback
}

export function parseParameterString(type: number, text: string): ParameterString {
  const [first = '', ...rest] = text.split('\t')
  const values = new Map<string, string[]>()
  const pairs: [string, string][] = []
  for (const field of rest) {
    if (!field) continue
    const code = field[0]!
    const value = field.slice(1)
    pairs.push([code, value])
    const list = values.get(code)
    if (list) list.push(value)
    else values.set(code, [value])
  }
  return { type, first, values, pairs }
}

function symbolNumber(sym: number): string {
  return `${Math.trunc(sym / 1000)}.${sym % 1000}`
}

/** A coordinate value without its flag bits. */
function coordinate(raw: number): number {
  return raw >> 8
}

export function readOcad(buffer: ArrayBuffer, wantSymbol: (symbol: number) => boolean = () => true): OcadFile {
  const view = new DataView(buffer)
  if (buffer.byteLength < 48 || view.getUint16(0, true) !== OCAD_MARK) throw new OcadError('not-ocad')
  const version = view.getInt16(4, true)
  const subVersion = view.getUint8(6)
  if (version < MIN_VERSION) throw new OcadError('version', version)

  const utf8 = new TextDecoder('utf-8')
  const utf16 = new TextDecoder('utf-16le')
  const inFile = (pos: number, len = 0) => pos > 0 && pos + len <= buffer.byteLength

  // Parameter strings: null-terminated UTF-8.
  const strings: ParameterString[] = []
  const seenBlocks = new Set<number>()
  for (let block = view.getInt32(32, true); inFile(block, 4 + INDEX_ENTRIES * 16); ) {
    if (seenBlocks.has(block)) break
    seenBlocks.add(block)
    for (let i = 0; i < INDEX_ENTRIES; i++) {
      const entry = block + 4 + i * 16
      const pos = view.getInt32(entry, true)
      const len = view.getInt32(entry + 4, true)
      const type = view.getInt32(entry + 8, true)
      if (type <= 0 || len <= 0 || !inFile(pos, 1)) continue
      const bytes = new Uint8Array(buffer, pos, Math.min(len, buffer.byteLength - pos))
      const end = bytes.indexOf(0)
      strings.push(parseParameterString(type, utf8.decode(end >= 0 ? bytes.subarray(0, end) : bytes)))
    }
    block = view.getInt32(block, true)
  }

  // Objects.
  const objects: OcadObject[] = []
  const readText = (pos: number, units: number): [string, number] => {
    const len = Math.min(units * TEXT_UNIT_BYTES, buffer.byteLength - pos)
    if (len <= 0) return ['', pos]
    const text = utf16.decode(new Uint8Array(buffer, pos, len - (len % 2)))
    const end = text.indexOf('\0')
    return [(end >= 0 ? text.slice(0, end) : text).replace(/\r/g, ''), pos + units * TEXT_UNIT_BYTES]
  }
  seenBlocks.clear()
  for (let block = view.getInt32(12, true); inFile(block, 4 + INDEX_ENTRIES * OBJECT_INDEX_BYTES); ) {
    if (seenBlocks.has(block)) break
    seenBlocks.add(block)
    for (let i = 0; i < INDEX_ENTRIES; i++) {
      const entry = block + 4 + i * OBJECT_INDEX_BYTES
      const pos = view.getInt32(entry + 16, true)
      const sym = view.getInt32(entry + 24, true)
      const status = view.getUint8(entry + 30)
      if (!inFile(pos, OBJECT_HEADER_BYTES) || status === 0 || status === STATUS_DELETED || !wantSymbol(sym)) continue
      const type = view.getUint8(pos + 4)
      const nItem = view.getUint32(pos + 44, true)
      const nText = view.getUint16(pos + 48, true)
      const nObjectString = view.getUint16(pos + 50, true)
      let p = pos + OBJECT_HEADER_BYTES
      if (!inFile(p, nItem * 8)) continue
      const points: [number, number][] = []
      for (let k = 0; k < nItem; k++, p += 8) {
        points.push([coordinate(view.getInt32(p, true)), coordinate(view.getInt32(p + 4, true))])
      }
      const [text, afterText] = readText(p, nText)
      const [objectString] = readText(afterText, nObjectString)
      objects.push({ symbol: symbolNumber(sym), type, points, text, objectString })
    }
    block = view.getInt32(block, true)
  }
  return { version, subVersion, strings, objects }
}
