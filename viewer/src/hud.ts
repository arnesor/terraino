import { type Course, type CourseRun, encodeCourse, formatTime } from './course'
import type { Player } from './player'
import type { World } from './world'

const MAP_ZOOMS = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 3, 4]
const PURPLE = 'rgba(190, 40, 160, 0.9)'
// Control circle radius in map millimetres (IOF: 6 mm diameter).
const CIRCLE_MM = 3

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement) {
  const e = document.createElement(tag)
  e.className = className
  parent.appendChild(e)
  return e
}

/** On-screen information: position, compass, map, course editor and timing. */
export class Hud {
  /** True while the map is open in course editing mode (mouse is free). */
  editing = false
  onEditingChange: (editing: boolean) => void = () => {}
  private readonly world: World
  private readonly player: Player
  private readonly run: CourseRun
  private readonly status: () => string
  private readonly info: HTMLDivElement
  private readonly compassStrip: HTMLDivElement
  private readonly compassValue: HTMLDivElement
  private readonly mapPanel: HTMLDivElement
  private readonly mapCanvas: HTMLCanvasElement
  private readonly mapHelp: HTMLDivElement
  private readonly runPanel: HTMLDivElement
  private readonly mapImage = new Image()
  private zoomIndex = 4
  private showPosition = true
  /** Map centre in projected coordinates while editing (null = follow the runner). */
  private centre: [number, number] | null = null
  private drag: { x: number; y: number; centre: [number, number] } | null = null
  private frames = 0
  private fpsTime = 0
  private fps = 0

  constructor(root: HTMLElement, world: World, player: Player, run: CourseRun, status: () => string) {
    this.world = world
    this.player = player
    this.run = run
    this.status = status

    this.info = el('div', 'hud-info', root)

    const compass = el('div', 'hud-compass', root)
    this.compassStrip = el('div', 'hud-compass-strip', compass)
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
    for (let deg = -360; deg <= 720; deg += 15) {
      const tick = el('span', 'hud-compass-tick', this.compassStrip)
      const norm = (deg + 360) % 360
      tick.textContent = labels[norm] ?? (norm % 45 === 0 ? String(norm) : '·')
      if (labels[norm]) tick.classList.add('major')
      tick.style.left = `${deg * 4}px`
    }
    el('div', 'hud-compass-needle', compass)
    this.compassValue = el('div', 'hud-compass-value', compass)

    this.runPanel = el('div', 'hud-run', root)

    this.mapPanel = el('div', 'hud-map', root)
    this.mapPanel.hidden = true
    this.mapCanvas = el('canvas', 'hud-map-canvas', this.mapPanel)
    this.mapHelp = el('div', 'hud-map-help', this.mapPanel)
    this.mapImage.src = world.url(world.manifest.map.image)

    const credits = el('div', 'hud-credits', root)
    credits.textContent = world.manifest.attribution.join(' · ')

    window.addEventListener('keydown', e => this.onKey(e))
    this.mapCanvas.addEventListener('mousedown', e => this.onMouseDown(e))
    window.addEventListener('mousemove', e => this.onMouseMove(e))
    window.addEventListener('mouseup', e => this.onMouseUp(e))
    this.mapCanvas.addEventListener('contextmenu', e => {
      e.preventDefault()
      if (this.editing) this.removeLastControl()
    })
    this.mapCanvas.addEventListener('wheel', e => {
      e.preventDefault()
      this.zoom(e.deltaY < 0 ? 1 : -1)
    })
    this.updateHelp()
  }

  get mapOpen(): boolean {
    return !this.mapPanel.hidden
  }

  private onKey(e: KeyboardEvent) {
    if (e.code === 'KeyM') {
      this.mapPanel.hidden = !this.mapPanel.hidden
      if (this.mapPanel.hidden && this.editing) this.setEditing(false)
    }
    if (e.code === 'KeyP') this.showPosition = !this.showPosition
    if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoom(1)
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoom(-1)
    if (e.code === 'KeyE' && this.mapOpen) this.setEditing(!this.editing)
    if (this.editing && e.code === 'Backspace') this.removeLastControl()
    if (this.editing && e.code === 'Delete') this.setCourse({ controls: [] })
    if (e.code === 'KeyL' && this.run.course.controls.length) {
      const url = new URL(location.href)
      url.searchParams.set('course', encodeCourse(this.run.course))
      void navigator.clipboard?.writeText(url.toString())
      this.flash('Link to this course copied')
    }
    this.updateHelp()
  }

  setEditing(editing: boolean) {
    this.editing = editing
    this.centre = editing ? this.runnerPosition() : null
    this.mapPanel.classList.toggle('editing', editing)
    this.onEditingChange(editing)
    this.updateHelp()
  }

  private flash(text: string) {
    this.mapHelp.textContent = text
    setTimeout(() => this.updateHelp(), 1500)
  }

  private updateHelp() {
    this.mapHelp.textContent = this.editing
      ? 'Click: add control · Right click / Backspace: remove last · Delete: clear · Drag: move · Wheel: zoom · E: done'
      : 'M: close · +/−: zoom · P: show/hide position · E: set a course · L: copy course link'
  }

  private setCourse(course: Course) {
    this.run.setCourse(course)
  }

  private removeLastControl() {
    this.setCourse({ controls: this.run.course.controls.slice(0, -1) })
  }

  private zoom(delta: number) {
    this.zoomIndex = Math.min(Math.max(this.zoomIndex + delta, 0), MAP_ZOOMS.length - 1)
  }

  private runnerPosition(): [number, number] {
    const pos = this.player.camera.position
    return this.world.toProjected(pos.x, pos.z)
  }

  /** Canvas pixels per metre on the ground. */
  private get pixelsPerMetre(): number {
    const [x0, , x1] = this.world.manifest.extent
    return (this.mapImage.naturalWidth / (x1 - x0)) * MAP_ZOOMS[this.zoomIndex]! * (window.devicePixelRatio || 1)
  }

  private canvasToProjected(cx: number, cy: number): [number, number] {
    const [e0, n0] = this.centre ?? this.runnerPosition()
    const dpr = window.devicePixelRatio || 1
    const ppm = this.pixelsPerMetre
    return [e0 + (cx * dpr - this.mapCanvas.width / 2) / ppm, n0 - (cy * dpr - this.mapCanvas.height / 2) / ppm]
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.editing || e.button !== 0) return
    this.drag = { x: e.clientX, y: e.clientY, centre: this.centre ?? this.runnerPosition() }
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.drag) return
    const ppm = this.pixelsPerMetre / (window.devicePixelRatio || 1)
    this.centre = [
      this.drag.centre[0] - (e.clientX - this.drag.x) / ppm,
      this.drag.centre[1] + (e.clientY - this.drag.y) / ppm,
    ]
  }

  private onMouseUp(e: MouseEvent) {
    if (!this.drag) return
    const moved = Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y)
    this.drag = null
    if (moved < 4) {
      const rect = this.mapCanvas.getBoundingClientRect()
      const point = this.canvasToProjected(e.clientX - rect.left, e.clientY - rect.top)
      this.setCourse({ controls: [...this.run.course.controls, point] })
    }
  }

  update(dt: number) {
    this.frames++
    this.fpsTime += dt
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTime)
      this.frames = 0
      this.fpsTime = 0
    }

    const pos = this.player.camera.position
    const [east, north] = this.world.toProjected(pos.x, pos.z)
    const heading = this.player.heading
    this.info.textContent = [
      this.world.manifest.name,
      `${this.world.manifest.crs}  E ${east.toFixed(0)}  N ${north.toFixed(0)}`,
      `Height ${(pos.y - 1.7).toFixed(1)} m · ${this.player.speed.toFixed(1)} m/s${this.player.flying ? ' · flying' : ''}`,
      `Runnability ${Math.round(this.player.runnability * 100)} %`,
      `${this.fps} fps · ${this.status()}`,
    ].join('\n')

    this.compassStrip.style.transform = `translateX(${-heading * 4}px)`
    this.compassValue.textContent = `${Math.round(heading).toString().padStart(3, '0')}°`

    this.updateRunPanel()
    if (this.mapOpen) this.drawMap(heading)
  }

  private updateRunPanel() {
    const run = this.run
    const n = run.course.controls.length
    if (n < 2) {
      this.runPanel.hidden = true
      return
    }
    this.runPanel.hidden = false
    const lines: string[] = []
    if (run.state === 'ready') {
      lines.push(run.next === 1 ? 'At the start – run when ready' : 'Go to the start △ (T: jump there)')
    } else {
      const label = run.next >= n - 1 ? 'Finish' : `Control ${run.next}`
      lines.push(
        run.state === 'finished'
          ? `Finished ${formatTime(run.elapsed())}  (R: run again)`
          : `${formatTime(run.elapsed())}  ·  next: ${label}`,
      )
      run.splits.forEach((t, i) => {
        const leg = i === 0 ? t : t - run.splits[i - 1]!
        const name = i + 1 === n - 1 ? 'F' : String(i + 1)
        lines.push(`${name.padStart(2)}  ${formatTime(t)}  (+${formatTime(leg)})`)
      })
    }
    this.runPanel.textContent = lines.join('\n')
  }

  private drawMap(heading: number) {
    const canvas = this.mapCanvas
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx || !this.mapImage.complete || this.mapImage.naturalWidth === 0) return

    const [x0, , x1, y1] = this.world.manifest.extent
    const ppm = this.pixelsPerMetre
    const [ce, cn] = this.centre ?? this.runnerPosition()
    const toCanvas = (e: number, n: number): [number, number] => [
      canvas.width / 2 + (e - ce) * ppm,
      canvas.height / 2 - (n - cn) * ppm,
    ]

    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const imgPerMetre = this.mapImage.naturalWidth / (x1 - x0)
    const [ix, iy] = toCanvas(x0, y1)
    ctx.imageSmoothingQuality = 'high'
    const k = ppm / imgPerMetre
    ctx.drawImage(this.mapImage, ix, iy, this.mapImage.naturalWidth * k, this.mapImage.naturalHeight * k)

    this.drawCourse(ctx, toCanvas, ppm)

    if (this.showPosition) {
      const [px, py] = toCanvas(...this.runnerPosition())
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate((heading * Math.PI) / 180)
      ctx.fillStyle = 'rgba(220, 0, 120, 0.9)'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      ctx.moveTo(0, -14 * dpr)
      ctx.lineTo(8 * dpr, 10 * dpr)
      ctx.lineTo(0, 5 * dpr)
      ctx.lineTo(-8 * dpr, 10 * dpr)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawCourse(ctx: CanvasRenderingContext2D, toCanvas: (e: number, n: number) => [number, number], ppm: number) {
    const controls = this.run.course.controls
    if (!controls.length) return
    const scale = this.world.manifest.map.scale ?? 10000
    const radius = ((CIRCLE_MM * scale) / 1000) * ppm
    const pts = controls.map(([e, n]) => toCanvas(e, n))
    ctx.save()
    ctx.strokeStyle = PURPLE
    ctx.fillStyle = PURPLE
    ctx.lineWidth = Math.max(radius * 0.08, 1.5)

    // Lines between controls stop at the circles.
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!
      const [bx, by] = pts[i + 1]!
      const d = Math.hypot(bx - ax, by - ay)
      if (d < radius * 2.2) continue
      const ux = (bx - ax) / d
      const uy = (by - ay) / d
      ctx.beginPath()
      ctx.moveTo(ax + ux * radius * 1.1, ay + uy * radius * 1.1)
      ctx.lineTo(bx - ux * radius * 1.1, by - uy * radius * 1.1)
      ctx.stroke()
    }

    pts.forEach(([x, y], i) => {
      ctx.beginPath()
      if (i === 0) {
        // Start triangle pointing to the first control.
        const [nx, ny] = pts[1] ?? [x, y - 1]
        const a = Math.atan2(ny - y, nx - x)
        for (let k = 0; k < 3; k++) {
          const ang = a + (k * 2 * Math.PI) / 3
          const px = x + Math.cos(ang) * radius * 1.15
          const py = y + Math.sin(ang) * radius * 1.15
          if (k === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.stroke()
      } else if (i === pts.length - 1 && pts.length > 1) {
        ctx.arc(x, y, radius * 0.8, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(x, y, radius * 1.1, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.stroke()
        ctx.font = `bold ${Math.max(radius * 0.9, 12)}px system-ui, sans-serif`
        ctx.fillText(String(i), x + radius * 0.9, y - radius * 0.9)
      }
    })
    ctx.restore()
  }
}
