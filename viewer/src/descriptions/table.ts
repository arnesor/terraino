// The IOF control description table of a course, drawn on a 2D canvas.

import { formatNumber, lang } from '../i18n'
import type { ImportedCourse } from '../ocad/courses'
import { SYMBOLS, symbolId } from './codes'

const COLUMNS = 8
const INK = '#111'
const HIGHLIGHT = '#ffe680'
// Symbol drawings use a 200 x 200 box (y up); instruction lines are 1600 wide.
const SYMBOL_BOX = 200
const FINISH_SYMBOLS = { taped: '14.1', funnel: '14.2', navigate: '14.3' }

/** Rows of the table: title, course, start, controls and (if there is one) finish. */
export function tableRows(course: ImportedCourse): number {
  return 2 + course.controls.length
}

/** Distance from the last control to the finish, rounded to 10 m as on the printed sheet. */
export function finishDistance(course: ImportedCourse): number | null {
  const n = course.controls.length
  const finish = course.controls[n - 1]
  const last = course.controls[n - 2]
  if (!finish || !last || finish.kind !== 'finish') return null
  const d = Math.hypot(finish.position[0] - last.position[0], finish.position[1] - last.position[1])
  return Math.round(d / 10) * 10
}

/** Draw a Purple Pen symbol centred at (cx, cy), `size` pixels per 200 units. */
export function drawSymbol(ctx: CanvasRenderingContext2D, id: string, cx: number, cy: number, size: number) {
  const symbol = SYMBOLS[id]
  if (!symbol) return
  ctx.save()
  ctx.translate(cx, cy)
  const s = size / SYMBOL_BOX
  ctx.scale(s, -s)
  ctx.fillStyle = INK
  ctx.strokeStyle = INK
  for (const shape of symbol.shapes) {
    const [tag, ...rest] = shape as [string, ...number[]]
    const path = (pts: number[], close: boolean, bezier = false) => {
      ctx.beginPath()
      ctx.moveTo(pts[0]!, pts[1]!)
      if (bezier) {
        for (let i = 2; i + 5 < pts.length; i += 6) {
          ctx.bezierCurveTo(pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!, pts[i + 4]!, pts[i + 5]!)
        }
      } else {
        for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!)
      }
      if (close) ctx.closePath()
    }
    switch (tag) {
      case 'lines': {
        const [thickness, roundEnds, roundCorners, ...pts] = rest
        ctx.lineWidth = thickness!
        ctx.lineCap = roundEnds ? 'round' : 'butt'
        ctx.lineJoin = roundCorners ? 'round' : 'miter'
        path(pts, false)
        ctx.stroke()
        break
      }
      case 'polygon': {
        const [thickness, roundCorners, ...pts] = rest
        ctx.lineWidth = thickness!
        ctx.lineJoin = roundCorners ? 'round' : 'miter'
        path(pts, true)
        ctx.stroke()
        break
      }
      case 'filled-polygon':
        path(rest, true)
        ctx.fill()
        break
      case 'circle': {
        const [thickness, radius, x, y] = rest
        ctx.lineWidth = thickness!
        ctx.beginPath()
        ctx.arc(x!, y!, radius!, 0, Math.PI * 2)
        ctx.stroke()
        break
      }
      case 'filled-circle': {
        const [radius, x, y] = rest
        ctx.beginPath()
        ctx.arc(x!, y!, radius!, 0, Math.PI * 2)
        ctx.fill()
        break
      }
      case 'beziers': {
        const [thickness, roundEnds, ...pts] = rest
        ctx.lineWidth = thickness!
        ctx.lineCap = roundEnds ? 'round' : 'butt'
        path(pts, false, true)
        ctx.stroke()
        break
      }
      case 'filled-beziers':
        path(rest, true, true)
        ctx.fill()
        break
    }
  }
  ctx.restore()
}

function text(ctx: CanvasRenderingContext2D, value: string, cx: number, cy: number, size: number, maxWidth?: number) {
  ctx.font = `600 ${size}px system-ui, 'Segoe UI', sans-serif`
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(value, cx, cy, maxWidth)
}

/** Names of a control's description symbols in the current language, for a text line. */
export function describe(course: ImportedCourse, index: number): string {
  const control = course.controls[index]
  if (!control) return ''
  const d = control.description
  const single = !d.e
  const names: string[] = []
  for (const column of ['c', 'd', 'e', 'f', 'g', 'h'] as const) {
    const id = symbolId(column, d[column], single)
    const name = id ? SYMBOLS[id]?.names[lang()] ?? SYMBOLS[id]?.names.en : undefined
    if (name) names.push(name)
    else if (d[column] && !id) names.push(d[column])
  }
  return names.join(' · ')
}

export interface TableOptions {
  /** Index in course.controls of the row to highlight (0 = start). */
  highlight?: number
}

/**
 * Draw the table with its top-left corner at (0, 0) of the current transform,
 * with boxes `box` pixels square. It is 8 boxes wide and tableRows(course) boxes high.
 */
export function drawDescriptionTable(
  ctx: CanvasRenderingContext2D,
  course: ImportedCourse,
  box: number,
  options: TableOptions = {},
) {
  const rows = tableRows(course)
  const width = COLUMNS * box
  const height = rows * box
  const thin = Math.max(box * 0.025, 0.5)
  const thick = Math.max(box * 0.06, 1.2)
  ctx.save()
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)

  const controls = course.controls
  const hasFinish = controls.at(-1)?.kind === 'finish'
  const rowOf = (i: number) => 2 + i
  if (options.highlight !== undefined && controls[options.highlight]) {
    ctx.fillStyle = HIGHLIGHT
    ctx.fillRect(0, rowOf(options.highlight) * box, width, box)
  }

  // Heading: event title, then course name, length and climb.
  text(ctx, course.event, width / 2, box / 2, box * 0.5, width - box * 0.3)
  text(ctx, course.name, 1.5 * box, 1.5 * box, box * 0.5, 2.8 * box)
  text(ctx, `${formatNumber(course.lengthM / 1000, 1)} km`, 4.5 * box, 1.5 * box, box * 0.5, 2.8 * box)
  if (course.climbM) text(ctx, `${Math.round(course.climbM / 5) * 5} m`, 7 * box, 1.5 * box, box * 0.5, 1.8 * box)

  let number = 0
  controls.forEach((control, i) => {
    const y = rowOf(i) * box
    const cy = y + box / 2
    if (control.kind === 'finish') {
      const distance = finishDistance(course)
      drawSymbol(ctx, FINISH_SYMBOLS.navigate, width / 2, cy, box)
      if (distance !== null) text(ctx, `${distance} m`, width / 2, cy, box * 0.45)
      return
    }
    if (control.kind === 'start') {
      drawSymbol(ctx, 'start', box / 2, cy, box)
    } else {
      number++
      text(ctx, String(number), box / 2, cy, box * 0.55)
      text(ctx, control.code, 1.5 * box, cy, box * 0.5, box * 0.92)
    }
    const d = control.description
    const single = !d.e
    ;(['c', 'd', 'e', 'f', 'g', 'h'] as const).forEach((column, k) => {
      const code = d[column]
      if (!code) return
      const cx = (2.5 + k) * box
      const id = symbolId(column, code, single)
      if (id) drawSymbol(ctx, id, cx, cy, box)
      else text(ctx, code, cx, cy, box * 0.32, box * 0.92)
    })
  })

  // Grid: thin lines between boxes, thick ones around the table, under the heading,
  // after every third control, around the finish line, and after columns C and F.
  const line = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
  ctx.strokeStyle = INK
  ctx.lineCap = 'square'
  const lastBody = hasFinish ? rows - 1 : rows
  for (let r = 1; r < rows; r++) {
    const controlRow = r - 2
    const isThick = r === 2 || r === lastBody || (controlRow > 0 && controlRow % 3 === 0 && r < lastBody)
    line(0, r * box, width, r * box, isThick ? thick : thin)
  }
  // Column lines run through the control rows only; the heading has its own splits.
  for (let c = 1; c < COLUMNS; c++) {
    const isThick = c === 3 || c === 6
    line(c * box, 2 * box, c * box, lastBody * box, isThick ? thick : thin)
  }
  line(3 * box, box, 3 * box, 2 * box, thin)
  line(6 * box, box, 6 * box, 2 * box, thin)
  ctx.lineWidth = thick
  ctx.strokeRect(0, 0, width, height)
  ctx.restore()
}
