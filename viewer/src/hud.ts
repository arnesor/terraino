import { type Course, type CourseRun, encodeCourse, formatTime } from './course'
import type { Player } from './player'
import type { World } from './world'

const PURPLE = 'rgba(190, 40, 160, 0.9)'
// Control circle radius in map millimetres (IOF: 6 mm diameter).
const CIRCLE_MM = 3
// Map zoom limit in screen pixels per metre.
const MAX_ZOOM = 8
const BUTTON_ZOOM = 1.4
const ROTATE_STEP = Math.PI / 12

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement) {
  const e = document.createElement(tag)
  e.className = className
  parent.appendChild(e)
  return e
}

function button(parent: HTMLElement, label: string, title: string, onClick: () => void) {
  const b = el('button', 'hud-map-button', parent)
  b.textContent = label
  b.title = title
  b.addEventListener('click', e => {
    e.stopPropagation()
    onClick()
  })
  return b
}

/** On-screen information: position, compass, map window, course editor and timing. */
export class Hud {
  /** True while clicks on the map add controls. */
  editing = false
  /** Called when the map window opens or closes. */
  onMapToggle: (open: boolean) => void = () => {}
  /** Called with a projected position when the map is double-clicked. */
  onTeleport: (east: number, north: number) => void = () => {}
  private readonly world: World
  private readonly player: Player
  private readonly run: CourseRun
  private readonly status: () => string
  private readonly info: HTMLDivElement
  private readonly compassStrip: HTMLDivElement
  private readonly compassValue: HTMLDivElement
  private readonly mapWindow: HTMLDivElement
  private readonly mapCanvas: HTMLCanvasElement
  private readonly mapTitle: HTMLSpanElement
  private readonly mapHelp: HTMLDivElement
  private readonly north: HTMLDivElement
  private readonly editButton: HTMLButtonElement
  private readonly autoButton: HTMLButtonElement
  private readonly positionBox: HTMLInputElement
  private readonly runPanel: HTMLDivElement
  private readonly mapImage = new Image()
  /** Map zoom in screen (CSS) pixels per metre; 0 until first shown. */
  private zoom = 0
  /** Map centre in projected coordinates. */
  private centre: [number, number] = [0, 0]
  /** Map rotation in radians, clockwise on screen; 0 = north up. */
  private rotation = 0
  /** Rotate the map so the running direction is up. */
  private auto = false
  /** True while the map centre follows the runner. */
  private follow = true
  private drag: { x: number; y: number; moved: number } | null = null
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

    // The map window: title bar, map with a north arrow, tool bar and help line.
    this.mapWindow = el('div', 'hud-map', root)
    this.mapWindow.hidden = true
    const head = el('div', 'hud-map-head', this.mapWindow)
    this.mapTitle = el('span', 'hud-map-title', head)
    button(head, '✕', 'Close the map (M)', () => this.toggleMap(false)).classList.add('close')
    const body = el('div', 'hud-map-body', this.mapWindow)
    this.mapCanvas = el('canvas', 'hud-map-canvas', body)
    this.north = el('div', 'hud-map-north', body)
    el('span', '', this.north).textContent = 'N'

    const tools = el('div', 'hud-map-tools', this.mapWindow)
    const rotate = el('div', 'hud-map-group', tools)
    button(rotate, '⟲', 'Rotate anticlockwise', () => this.rotate(-ROTATE_STEP))
    button(rotate, '⟳', 'Rotate clockwise', () => this.rotate(ROTATE_STEP))
    button(rotate, 'N↑', 'North up', () => this.rotate(-this.rotation))
    this.autoButton = button(rotate, 'Auto', 'Turn the map with the direction you are running', () =>
      this.setAuto(!this.auto),
    )
    const zoom = el('div', 'hud-map-group', tools)
    button(zoom, '−', 'Zoom out (wheel)', () => this.zoomAt(1 / BUTTON_ZOOM))
    button(zoom, '+', 'Zoom in (wheel)', () => this.zoomAt(BUTTON_ZOOM))
    button(zoom, 'Whole', 'Show the whole map', () => this.showWhole())
    button(zoom, 'Me', 'Centre on your position', () => {
      this.follow = true
    })
    const more = el('div', 'hud-map-group', tools)
    const positionLabel = el('label', 'hud-map-check', more)
    this.positionBox = el('input', '', positionLabel)
    this.positionBox.type = 'checkbox'
    this.positionBox.checked = true
    positionLabel.append(' Position')
    this.editButton = button(more, 'Set course', 'Click on the map to place start, controls and finish (E)', () =>
      this.setEditing(!this.editing),
    )
    this.mapHelp = el('div', 'hud-map-help', this.mapWindow)
    this.mapImage.src = world.url(world.manifest.map.image)
    const scale = world.manifest.map.scale
    this.mapTitle.textContent = scale ? `Map · 1:${scale.toLocaleString('en').replace(/,/g, ' ')}` : 'Map'

    const credits = el('div', 'hud-credits', root)
    credits.textContent = world.manifest.attribution.join(' · ')

    window.addEventListener('keydown', e => this.onKey(e))
    this.mapCanvas.addEventListener('pointerdown', e => this.onPointerDown(e))
    this.mapCanvas.addEventListener('pointermove', e => this.onPointerMove(e))
    this.mapCanvas.addEventListener('pointerup', e => this.onPointerUp(e))
    this.mapCanvas.addEventListener('dblclick', e => this.onDoubleClick(e))
    this.mapCanvas.addEventListener('contextmenu', e => {
      e.preventDefault()
      if (this.editing) this.removeLastControl()
    })
    this.mapCanvas.addEventListener(
      'wheel',
      e => {
        e.preventDefault()
        const [x, y] = this.canvasPoint(e)
        this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)), x, y)
      },
      { passive: false },
    )
    this.updateHelp()
  }

  get mapOpen(): boolean {
    return !this.mapWindow.hidden
  }

  /** Open or close the map window. */
  toggleMap(open = !this.mapOpen) {
    if (open === this.mapOpen) return
    this.mapWindow.hidden = !open
    if (open) {
      this.follow = true
      if (this.zoom === 0) this.zoom = 1
    } else if (this.editing) {
      this.setEditing(false)
    }
    this.onMapToggle(open)
  }

  private onKey(e: KeyboardEvent) {
    if (e.code === 'KeyM') this.toggleMap()
    if (e.code === 'KeyP') this.positionBox.checked = !this.positionBox.checked
    if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoomAt(BUTTON_ZOOM)
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoomAt(1 / BUTTON_ZOOM)
    if (e.code === 'KeyE' && this.mapOpen) this.setEditing(!this.editing)
    if (this.editing && e.code === 'Backspace') this.removeLastControl()
    if (this.editing && e.code === 'Delete') this.setCourse({ controls: [] })
    if (e.code === 'KeyL' && this.run.course.controls.length) {
      const url = new URL(location.href)
      url.searchParams.set('course', encodeCourse(this.run.course))
      void navigator.clipboard?.writeText(url.toString())
      this.flash('Link to this course copied')
    }
  }

  setEditing(editing: boolean) {
    this.editing = editing
    this.mapWindow.classList.toggle('editing', editing)
    this.editButton.classList.toggle('active', editing)
    this.editButton.textContent = editing ? 'Done' : 'Set course'
    this.updateHelp()
  }

  private setAuto(auto: boolean) {
    this.auto = auto
    this.autoButton.classList.toggle('active', auto)
    if (!auto) this.rotation = 0
  }

  private rotate(delta: number) {
    this.setAuto(false)
    this.rotation += delta
  }

  private flash(text: string) {
    this.mapHelp.textContent = text
    setTimeout(() => this.updateHelp(), 1500)
  }

  private updateHelp() {
    this.mapHelp.textContent = this.editing
      ? 'Click: add control · Right click / Backspace: remove last · Delete: clear · Drag: move · Wheel: zoom'
      : 'Drag: move · Wheel: zoom · Double click: go there'
  }

  private setCourse(course: Course) {
    this.run.setCourse(course)
  }

  private removeLastControl() {
    this.setCourse({ controls: this.run.course.controls.slice(0, -1) })
  }

  private runnerPosition(): [number, number] {
    const pos = this.player.camera.position
    return this.world.toProjected(pos.x, pos.z)
  }

  private canvasSize(): [number, number] {
    return [this.mapCanvas.clientWidth, this.mapCanvas.clientHeight]
  }

  /** Smallest zoom: the whole map with a little room around it. */
  private fitZoom(): number {
    const [x0, y0, x1, y1] = this.world.manifest.extent
    const [w, h] = this.canvasSize()
    return Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.9
  }

  private showWhole() {
    const [x0, y0, x1, y1] = this.world.manifest.extent
    this.follow = false
    this.centre = [(x0 + x1) / 2, (y0 + y1) / 2]
    this.zoom = this.fitZoom()
  }

  /** Screen offset (CSS pixels from the canvas centre) to a ground offset (east, north). */
  private screenToGround(dx: number, dy: number): [number, number] {
    const c = Math.cos(-this.rotation)
    const s = Math.sin(-this.rotation)
    const ux = dx * c - dy * s
    const uy = dx * s + dy * c
    return [ux / this.zoom, -uy / this.zoom]
  }

  /** Projected coordinates of a point on the map canvas (CSS pixels). */
  private toProjected(sx: number, sy: number): [number, number] {
    const [w, h] = this.canvasSize()
    const [de, dn] = this.screenToGround(sx - w / 2, sy - h / 2)
    return [this.centre[0] + de, this.centre[1] + dn]
  }

  private canvasPoint(e: MouseEvent): [number, number] {
    const rect = this.mapCanvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  /** Zoom by `factor`, keeping the map point under (sx, sy) in place. */
  private zoomAt(factor: number, sx?: number, sy?: number) {
    const [w, h] = this.canvasSize()
    const x = sx ?? w / 2
    const y = sy ?? h / 2
    const before = this.toProjected(x, y)
    this.zoom = Math.min(Math.max(this.zoom * factor, this.fitZoom()), MAX_ZOOM)
    if (sx !== undefined) this.follow = false
    if (!this.follow) {
      const after = this.toProjected(x, y)
      this.centre = [this.centre[0] + before[0] - after[0], this.centre[1] + before[1] - after[1]]
    }
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    this.mapCanvas.setPointerCapture(e.pointerId)
    this.drag = { x: e.clientX, y: e.clientY, moved: 0 }
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.drag) return
    const dx = e.clientX - this.drag.x
    const dy = e.clientY - this.drag.y
    this.drag.moved += Math.hypot(dx, dy)
    this.drag.x = e.clientX
    this.drag.y = e.clientY
    if (this.drag.moved > 4) {
      this.follow = false
      const [de, dn] = this.screenToGround(dx, dy)
      this.centre = [this.centre[0] - de, this.centre[1] - dn]
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.drag) return
    const click = this.drag.moved <= 4
    this.drag = null
    if (click && this.editing) {
      const point = this.toProjected(...this.canvasPoint(e))
      this.setCourse({ controls: [...this.run.course.controls, point] })
    }
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.editing) return
    const [east, north] = this.toProjected(...this.canvasPoint(e))
    const [x0, y0, x1, y1] = this.world.manifest.extent
    if (east < x0 || east > x1 || north < y0 || north > y1) return
    this.onTeleport(east, north)
    this.follow = true
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
    const [w, h] = this.canvasSize()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx || w === 0 || h === 0) return
    this.zoom = Math.min(Math.max(this.zoom, this.fitZoom()), MAX_ZOOM)
    if (this.follow) this.centre = this.runnerPosition()
    const headingRad = (heading * Math.PI) / 180
    if (this.auto) this.rotation = -headingRad

    const zoom = this.zoom
    const [ce, cn] = this.centre
    // Drawing space: north-up pixels around the map centre; the context rotates it.
    const local = (e: number, n: number): [number, number] => [(e - ce) * zoom, -(n - cn) * zoom]

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#e9e5dc'
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.rotate(this.rotation)

    const [x0, y0, x1, y1] = this.world.manifest.extent
    const [ix, iy] = local(x0, y1)
    ctx.fillStyle = '#fff'
    ctx.fillRect(ix, iy, (x1 - x0) * zoom, (y1 - y0) * zoom)
    if (this.mapImage.complete && this.mapImage.naturalWidth > 0) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(this.mapImage, ix, iy, (x1 - x0) * zoom, (y1 - y0) * zoom)
    }

    this.drawCourse(ctx, local, zoom)

    if (this.positionBox.checked) {
      const [px, py] = local(...this.runnerPosition())
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(headingRad)
      ctx.fillStyle = '#e8222a'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(0, -13)
      ctx.lineTo(8, 9)
      ctx.lineTo(0, 4.5)
      ctx.lineTo(-8, 9)
      ctx.closePath()
      ctx.stroke()
      ctx.fill()
      ctx.restore()
    }
    ctx.restore()

    // Scale bar.
    const metres = [25, 50, 100, 200, 500, 1000, 2000].find(m => m * zoom >= 70) ?? 2000
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
    ctx.fillRect(10, h - 34, metres * zoom + 20, 24)
    ctx.fillStyle = '#26221d'
    ctx.fillRect(20, h - 18, metres * zoom, 4)
    ctx.font = '600 11px system-ui, sans-serif'
    ctx.fillText(`${metres} m`, 20, h - 22)

    this.north.style.transform = `rotate(${this.rotation}rad)`
  }

  private drawCourse(ctx: CanvasRenderingContext2D, local: (e: number, n: number) => [number, number], zoom: number) {
    const controls = this.run.course.controls
    if (!controls.length) return
    const scale = this.world.manifest.map.scale ?? 10000
    const radius = ((CIRCLE_MM * scale) / 1000) * zoom
    const pts = controls.map(([e, n]) => local(e, n))
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
        // Numbers stay upright on screen when the map turns.
        ctx.save()
        ctx.translate(x + radius * 0.9, y - radius * 0.9)
        ctx.rotate(-this.rotation)
        ctx.font = `bold ${Math.max(radius * 0.9, 12)}px system-ui, sans-serif`
        ctx.fillText(String(i), 0, 0)
        ctx.restore()
      }
    })
    ctx.restore()
  }
}
