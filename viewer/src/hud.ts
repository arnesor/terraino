import { formatFactor, type GameClock } from './clock'
import { type Course, type CourseRun, encodeCourse, formatPace, formatTime } from './course'
import { describe, drawDescriptionTable, tableRows } from './descriptions/table'
import { formatNumber, renameStoredKey, t, type TextKey } from './i18n'
import { fitRectangle, legIndices } from './mapview'
import type { ImportedCourse } from './ocad/courses'
import type { Player } from './player'
import type { World } from './world'

const PURPLE = 'rgba(190, 40, 160, 0.9)'
// Control circle radius in map millimetres (IOF: 6 mm diameter).
const CIRCLE_MM = 3
// Map zoom limit in screen pixels per metre.
const MAX_ZOOM = 8
const BUTTON_ZOOM = 1.4
const ROTATE_STEP = Math.PI / 12
// Box size of the description panel, in CSS pixels.
const PANEL_BOX = 24
// The leg view: at least this much ground across, and how the map moves to it.
const LEGS_MIN_SPAN_M = 150
const TRANSITION_S = 1
const SMOOTHING_S = 0.3
// Compass in the map's top-right corner, in CSS pixels.
const COMPASS_RADIUS = 34
const COMPASS_INSET = 46
const PREFERENCES_KEY = 'terraino.map'
renameStoredKey('otest.map', PREFERENCES_KEY)

/**
 * What the map window shows: the leg you are on and the next one, the runner at the
 * chosen zoom, or wherever it was dragged.
 */
type MapView = 'legs' | 'follow' | 'free'

interface MapPreferences {
  auto: boolean
  legs: boolean
  position: boolean
}

function loadPreferences(): MapPreferences {
  const defaults = { auto: false, legs: true, position: true }
  try {
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<MapPreferences>
    return { ...defaults, ...stored }
  } catch {
    return defaults
  }
}

const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)

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
  /** Called when the start screen is asked for from the map's title bar. */
  onStartScreen: () => void = () => {}
  /** Called with a projected position when the map is double-clicked. */
  onTeleport: (east: number, north: number) => void = () => {}
  private readonly world: World
  private readonly player: Player
  private readonly run: CourseRun
  private readonly clock: GameClock
  private readonly status: () => string
  private readonly info: HTMLDivElement
  private readonly compassStrip: HTMLDivElement
  private readonly compassValue: HTMLDivElement
  private readonly clockTime: HTMLSpanElement
  private readonly clockFactor: HTMLSpanElement
  private readonly mapWindow: HTMLDivElement
  private readonly mapCanvas: HTMLCanvasElement
  private readonly mapTitle: HTMLSpanElement
  private readonly mapHelp: HTMLDivElement
  private readonly editButton: HTMLButtonElement
  private readonly autoButton: HTMLButtonElement
  private readonly legsButton: HTMLButtonElement
  private readonly positionBox: HTMLInputElement
  private readonly runPanel: HTMLDivElement
  private readonly descriptions: HTMLDivElement
  private readonly descriptionCanvas: HTMLCanvasElement
  private readonly descriptionText: HTMLDivElement
  /** What the description panel shows now, to redraw it only when that changes. */
  private descriptionKey = ''
  private descriptionsShown = false
  private readonly mapImage = new Image()
  /** Map zoom in screen (CSS) pixels per metre; 0 until first shown. */
  private zoom = 0
  /** Map centre in projected coordinates. */
  private centre: [number, number] = [0, 0]
  /** Map rotation in radians, clockwise on screen; 0 = north up. */
  private rotation = 0
  /** Rotate the map so the running direction is up. */
  private auto = false
  private view: MapView = 'follow'
  /** Show the legs when a course is set or the map opens (the Legs button's choice). */
  private legsWanted = true
  /** The leg points last shown, to glide to new ones when a control is punched. */
  private legKey = ''
  /** A glide from `from` to the leg view, `k` running from 0 to 1. */
  private transition: { centre: [number, number]; zoom: number; k: number } | null = null
  /** Jump straight to the leg view on the next frame (the map was hidden). */
  private snap = false
  private shownCourse: Course | null = null
  private drag: { x: number; y: number; moved: number } | null = null
  private frames = 0
  private fpsTime = 0
  private fps = 0

  constructor(
    root: HTMLElement,
    world: World,
    player: Player,
    run: CourseRun,
    clock: GameClock,
    status: () => string,
  ) {
    this.world = world
    this.player = player
    this.run = run
    this.clock = clock
    this.status = status

    this.info = el('div', 'hud-info', root)

    const compass = el('div', 'hud-compass', root)
    this.compassStrip = el('div', 'hud-compass-strip', compass)
    const compassKeys: Record<number, TextKey> = {
      0: 'compassN',
      45: 'compassNE',
      90: 'compassE',
      135: 'compassSE',
      180: 'compassS',
      225: 'compassSW',
      270: 'compassW',
      315: 'compassNW',
    }
    const labels = Object.fromEntries(Object.entries(compassKeys).map(([deg, key]) => [deg, t(key)])) as Record<
      number,
      string
    >
    for (let deg = -360; deg <= 720; deg += 15) {
      const tick = el('span', 'hud-compass-tick', this.compassStrip)
      const norm = (deg + 360) % 360
      tick.textContent = labels[norm] ?? (norm % 45 === 0 ? String(norm) : '·')
      if (labels[norm]) tick.classList.add('major')
      tick.style.left = `${deg * 4}px`
    }
    el('div', 'hud-compass-needle', compass)
    this.compassValue = el('div', 'hud-compass-value', compass)

    // Run time and time factor, under the compass.
    const clockPanel = el('div', 'hud-clock', root)
    this.clockTime = el('span', 'hud-clock-time', clockPanel)
    this.clockFactor = el('span', 'hud-clock-factor', clockPanel)

    this.runPanel = el('div', 'hud-run', root)

    // Control descriptions, as carried while running (K).
    this.descriptions = el('div', 'hud-descriptions', root)
    this.descriptions.hidden = true
    this.descriptionCanvas = el('canvas', 'hud-descriptions-table', this.descriptions)
    this.descriptionText = el('div', 'hud-descriptions-text', this.descriptions)

    // The map window: title bar, map with a compass, tool bar and help line.
    this.mapWindow = el('div', 'hud-map', root)
    this.mapWindow.hidden = true
    const head = el('div', 'hud-map-head', this.mapWindow)
    this.mapTitle = el('span', 'hud-map-title', head)
    button(head, '⌂', t('startScreen'), () => this.onStartScreen()).classList.add('close')
    button(head, '✕', t('closeMap'), () => this.toggleMap(false)).classList.add('close')
    const body = el('div', 'hud-map-body', this.mapWindow)
    this.mapCanvas = el('canvas', 'hud-map-canvas', body)

    const tools = el('div', 'hud-map-tools', this.mapWindow)
    const rotate = el('div', 'hud-map-group', tools)
    button(rotate, '⟲', t('rotateLeft'), () => this.rotate(-ROTATE_STEP))
    button(rotate, '⟳', t('rotateRight'), () => this.rotate(ROTATE_STEP))
    button(rotate, `${t('compassN')}↑`, t('northUp'), () => this.rotate(-this.rotation))
    this.autoButton = button(rotate, t('auto'), t('autoTitle'), () => this.setAuto(!this.auto))
    const zoom = el('div', 'hud-map-group', tools)
    button(zoom, '−', t('zoomOut'), () => this.zoomAt(1 / BUTTON_ZOOM))
    button(zoom, '+', t('zoomIn'), () => this.zoomAt(BUTTON_ZOOM))
    button(zoom, t('whole'), t('wholeTitle'), () => this.showWhole())
    button(zoom, t('me'), t('meTitle'), () => this.setView('follow'))
    this.legsButton = button(zoom, t('legs'), t('legsTitle'), () => {
      this.legsWanted = this.view !== 'legs'
      this.setView(this.legsWanted ? 'legs' : 'follow')
      this.savePreferences()
    })
    const more = el('div', 'hud-map-group', tools)
    const positionLabel = el('label', 'hud-map-check', more)
    this.positionBox = el('input', '', positionLabel)
    this.positionBox.type = 'checkbox'
    this.positionBox.checked = true
    positionLabel.append(` ${t('position')}`)
    this.positionBox.addEventListener('change', () => this.savePreferences())
    this.editButton = button(more, t('setCourse'), t('setCourseTitle'), () => this.setEditing(!this.editing))
    this.mapHelp = el('div', 'hud-map-help', this.mapWindow)
    this.mapImage.src = world.url(world.manifest.map.image)
    const scale = world.manifest.map.scale
    this.mapTitle.textContent = scale ? `${t('map')} · 1:${formatNumber(scale).replace(/[\s,.]/g, ' ')}` : t('map')

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

    const preferences = loadPreferences()
    this.legsWanted = preferences.legs
    this.positionBox.checked = preferences.position
    this.setAuto(preferences.auto)
  }

  get mapOpen(): boolean {
    return !this.mapWindow.hidden
  }

  /** Open or close the map window. */
  toggleMap(open = !this.mapOpen) {
    if (open === this.mapOpen) return
    this.mapWindow.hidden = !open
    if (open) {
      if (this.zoom === 0) this.zoom = 1
      this.setView(this.legsWanted && this.hasCourse ? 'legs' : 'follow')
      this.snap = true
    } else if (this.editing) {
      this.setEditing(false)
    }
    this.onMapToggle(open)
  }

  private onKey(e: KeyboardEvent) {
    if (e.code === 'KeyM') this.toggleMap()
    if (e.code === 'KeyP') {
      this.positionBox.checked = !this.positionBox.checked
      this.savePreferences()
    }
    if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoomAt(BUTTON_ZOOM)
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoomAt(1 / BUTTON_ZOOM)
    if (e.code === 'KeyN' && this.mapOpen) this.setEditing(!this.editing)
    if (e.code === 'KeyK') this.showDescriptions(!this.descriptionsShown)
    if (this.editing && e.code === 'Backspace') this.removeLastControl()
    if (this.editing && e.code === 'Delete') this.setCourse({ controls: [] })
    if (e.code === 'KeyL' && this.run.course.controls.length) {
      const url = new URL(location.href)
      url.searchParams.set('course', encodeCourse(this.run.course))
      void navigator.clipboard?.writeText(url.toString())
      this.flash(t('linkCopied'))
    }
  }

  setEditing(editing: boolean) {
    this.editing = editing
    this.mapWindow.classList.toggle('editing', editing)
    this.editButton.classList.toggle('active', editing)
    this.editButton.textContent = editing ? t('done') : t('setCourse')
    this.updateHelp()
  }

  /** Show or hide the control descriptions of an imported course. */
  showDescriptions(show: boolean) {
    this.descriptionsShown = show
    this.descriptions.hidden = !show || !this.run.course.imported
    this.descriptionKey = ''
  }

  private setAuto(auto: boolean) {
    this.auto = auto
    this.autoButton.classList.toggle('active', auto)
    if (!auto) this.rotation = 0
    this.savePreferences()
  }

  /** Turn the map by hand; it keeps the turn it had (also from Auto) and adds to it. */
  private rotate(delta: number) {
    const current = this.rotation
    this.setAuto(false)
    this.rotation = current + delta
  }

  private get hasCourse(): boolean {
    return this.run.course.controls.length >= 2
  }

  /** Switch what the map shows; the leg view is reached by gliding there. */
  private setView(view: MapView) {
    if (view === 'legs' && this.view !== 'legs') {
      this.transition = { centre: [...this.centre], zoom: this.zoom, k: 0 }
      this.legKey = this.currentLegKey()
    }
    if (view !== 'legs') this.transition = null
    this.view = view
    this.legsButton.classList.toggle('active', view === 'legs')
  }

  private savePreferences() {
    try {
      const preferences: MapPreferences = { auto: this.auto, legs: this.legsWanted, position: this.positionBox.checked }
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Not remembered; the map still works.
    }
  }

  /** Changes when the leg points change: a punch, the start or a new course. */
  private currentLegKey(): string {
    return `${this.run.state}\t${this.run.next}\t${this.run.course.controls.length}`
  }

  /**
   * Points the leg view must show: the controls of the current and the next leg with their
   * numbers, and the runner while running.
   */
  private legView(): [number, number][] {
    const course = this.run.course
    const points: [number, number][] = []
    for (const i of legIndices(course.controls.length, this.run.state, this.run.next)) {
      points.push(course.controls[i]!)
      const number = course.imported?.controls[i]?.numberAt
      if (number) {
        // The number's text box, from its anchor (bottom left) up and to the right.
        const size = course.imported!.numberSizeM
        points.push(number, [number[0] + String(i).length * size * 0.6, number[1] + size * 0.75])
      }
    }
    if (this.run.state === 'running') points.push(this.runnerPosition())
    return points
  }

  /** Move the map toward the leg view: a glide after a punch, light smoothing otherwise. */
  private updateLegs(dt: number) {
    const size = this.canvasSize()
    const scale = this.world.manifest.map.scale ?? 10000
    const points = this.legView()
    // Keep the compass corner free: a band along the top or a column on the right,
    // whichever leaves the legs larger.
    const free = 2 * COMPASS_INSET
    const fit = (top: number, right: number) =>
      fitRectangle(points, this.rotation, size, (CIRCLE_MM * scale) / 1000, LEGS_MIN_SPAN_M, {
        top,
        right,
        bottom: 0,
        left: 0,
      })
    const [byTop, byRight] = [fit(free, 0), fit(0, free)]
    const target = byTop.zoom >= byRight.zoom ? byTop : byRight
    const targetZoom = Math.min(Math.max(target.zoom, this.fitZoom()), MAX_ZOOM)
    const key = this.currentLegKey()
    if (this.snap) {
      this.snap = false
      this.transition = null
      this.legKey = key
      this.centre = target.centre
      this.zoom = targetZoom
      return
    }
    if (key !== this.legKey) {
      this.legKey = key
      this.transition = { centre: [...this.centre], zoom: this.zoom, k: 0 }
    }
    let from: [number, number] = this.centre
    let fromZoom = this.zoom
    let k: number
    if (this.transition) {
      this.transition.k = Math.min(this.transition.k + dt / TRANSITION_S, 1)
      from = this.transition.centre
      fromZoom = this.transition.zoom
      k = easeInOut(this.transition.k)
      if (this.transition.k >= 1) this.transition = null
    } else {
      k = 1 - Math.exp(-dt / SMOOTHING_S)
    }
    // Zoom moves evenly in scale (log space), the centre in metres.
    this.centre = [from[0] + (target.centre[0] - from[0]) * k, from[1] + (target.centre[1] - from[1]) * k]
    this.zoom = Math.exp(Math.log(fromZoom) + (Math.log(targetZoom) - Math.log(fromZoom)) * k)
  }

  private flash(text: string) {
    this.mapHelp.textContent = text
    setTimeout(() => this.updateHelp(), 1500)
  }

  private updateHelp() {
    this.mapHelp.textContent = this.editing ? t('helpEditing') : t('helpMap')
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
    this.setView('free')
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
    if (sx !== undefined || this.view === 'legs') this.setView('free')
    if (this.view === 'free') {
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
      this.setView('free')
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
    if (this.view === 'free') this.setView('follow')
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
      t('infoHeight', { height: formatNumber(pos.y - 1.7, 1), pace: formatPace(this.player.speed) }) +
        (this.player.flying ? t('infoFlying') : ''),
      t('infoRunnability', { percent: Math.round(this.player.runnability * 100) }),
      `${this.fps} fps · ${this.status()}`,
    ].join('\n')

    this.compassStrip.style.transform = `translateX(${-heading * 4}px)`
    this.compassValue.textContent = `${Math.round(heading).toString().padStart(3, '0')}°`

    this.updateClock()
    this.updateRunPanel()
    this.updateDescriptions()
    this.legsButton.disabled = !this.hasCourse
    if (this.mapOpen) this.drawMap(heading, dt)
  }

  /** The run time (when a course is set) and the time factor, greyed out while flying. */
  private updateClock() {
    const timed = this.run.course.controls.length >= 2
    this.clockTime.hidden = !timed
    if (timed) this.clockTime.textContent = `${formatTime(this.run.elapsed(this.clock.time))} · `
    this.clockFactor.textContent = formatFactor(this.clock.factor)
    this.clockFactor.classList.toggle('off', this.player.flying)
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
      lines.push(run.next === 1 ? t('atStart') : t('goToStart'))
    } else {
      const label = run.next >= n - 1 ? t('finish') : t('controlNumber', { number: run.next })
      lines.push(
        run.state === 'finished'
          ? t('finished', { time: formatTime(run.elapsed(this.clock.time)) })
          : t('running', { time: formatTime(run.elapsed(this.clock.time)), label }),
      )
      run.splits.forEach((time, i) => {
        const leg = i === 0 ? time : time - run.splits[i - 1]!
        const name = i + 1 === n - 1 ? t('finishShort') : String(i + 1)
        lines.push(`${name.padStart(2)}  ${formatTime(time)}  (+${formatTime(leg)})`)
      })
    }
    this.runPanel.textContent = lines.join('\n')
  }

  /** Redraw the description panel when the course or the next control changes. */
  private updateDescriptions() {
    const course = this.run.course.imported
    this.descriptions.hidden = !this.descriptionsShown || !course
    if (!this.descriptionsShown || !course) return
    const next = this.run.state === 'finished' ? -1 : this.run.state === 'ready' ? 0 : this.run.next
    const key = `${course.name}\t${course.controls.length}\t${next}`
    if (key === this.descriptionKey) return
    this.descriptionKey = key
    const canvas = this.descriptionCanvas
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = 8 * PANEL_BOX
    const height = tableRows(course) * PANEL_BOX
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawDescriptionTable(ctx, course, PANEL_BOX, next >= 0 ? { highlight: next } : {})
    this.descriptionText.textContent = next > 0 ? describe(course, next) : ''
  }

  private drawMap(heading: number, dt: number) {
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
    const headingRad = (heading * Math.PI) / 180
    if (this.auto) this.rotation = -headingRad
    // A new course (opened or set by hand) is shown leg by leg, if that is wanted.
    if (this.run.course !== this.shownCourse) {
      this.shownCourse = this.run.course
      // Glide to the new course's legs even if they look like the old ones.
      this.legKey = ''
      if (this.legsWanted && this.hasCourse) this.setView('legs')
    }
    if (this.view === 'legs' && this.hasCourse) this.updateLegs(dt)
    else if (this.view !== 'free') this.centre = this.runnerPosition()

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

    this.drawCompass(ctx, w - COMPASS_INSET, COMPASS_INSET, headingRad)
  }

  /**
   * A compass at (cx, cy), held as you look: the needle points north in the terrain, so it
   * turns as you turn (looking due west, it points to the right). The dial turns with the map,
   * so its N points to map north. Turning the map until the dial's N and the meridians lie
   * along the needle orients the map to the terrain; Auto keeps it oriented.
   */
  private drawCompass(ctx: CanvasRenderingContext2D, cx: number, cy: number, headingRad: number) {
    const r = COMPASS_RADIUS
    ctx.save()
    ctx.translate(cx, cy)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.strokeStyle = '#26221d'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // Screen position at `radius` in compass direction `deg` (clockwise from north on the dial).
    const at = (deg: number, radius: number): [number, number] => {
      const a = (deg * Math.PI) / 180 + this.rotation
      return [Math.sin(a) * radius, -Math.cos(a) * radius]
    }
    ctx.lineWidth = 1
    for (let deg = 0; deg < 360; deg += 10) {
      const length = deg % 30 === 0 ? 6 : 3
      ctx.beginPath()
      ctx.moveTo(...at(deg, r - 2))
      ctx.lineTo(...at(deg, r - 2 - length))
      ctx.stroke()
    }
    ctx.font = '700 11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const letters: [number, TextKey][] = [
      [0, 'compassN'],
      [90, 'compassE'],
      [180, 'compassS'],
      [270, 'compassW'],
    ]
    for (const [deg, key] of letters) {
      ctx.fillStyle = deg === 0 ? '#c21b1b' : '#26221d'
      ctx.fillText(t(key), ...at(deg, r - 16))
    }

    // The needle: red toward north in the terrain, seen with the view direction up.
    ctx.rotate(-headingRad)
    const length = r - 6
    ctx.fillStyle = '#e8222a'
    ctx.beginPath()
    ctx.moveTo(0, -length)
    ctx.lineTo(4, 0)
    ctx.lineTo(-4, 0)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#b9b4aa'
    ctx.beginPath()
    ctx.moveTo(0, length)
    ctx.lineTo(4, 0)
    ctx.lineTo(-4, 0)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#26221d'
    ctx.beginPath()
    ctx.arc(0, 0, 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private drawCourse(ctx: CanvasRenderingContext2D, local: (e: number, n: number) => [number, number], zoom: number) {
    const controls = this.run.course.controls
    if (!controls.length) return
    const imported = this.run.course.imported
    if (imported) this.drawTable(ctx, imported, local, zoom)
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
        // Numbers stay upright on screen when the map turns; OCAD courses have them
        // where the course setter put them.
        const at = imported?.controls[i]?.numberAt
        const size = imported ? imported.numberSizeM * zoom : radius * 0.9
        ctx.save()
        if (at) ctx.translate(...local(...at))
        else ctx.translate(x + radius * 0.9, y - radius * 0.9)
        ctx.rotate(-this.rotation)
        ctx.font = `bold ${Math.max(size, 12)}px system-ui, sans-serif`
        ctx.fillText(String(i), 0, 0)
        ctx.restore()
      }
    })
    ctx.restore()
  }

  /** The description table on the map, where the course setter placed it (or beside the course). */
  private drawTable(
    ctx: CanvasRenderingContext2D,
    course: ImportedCourse,
    local: (e: number, n: number) => [number, number],
    zoom: number,
  ) {
    let topLeft = course.table?.topLeft
    const boxM = course.table?.boxM ?? (6 * (this.world.manifest.map.scale ?? 10000)) / 1000
    if (!topLeft) {
      const es = course.controls.map(c => c.position[0])
      const ns = course.controls.map(c => c.position[1])
      topLeft = [Math.max(...es) + boxM, Math.max(...ns)]
    }
    ctx.save()
    ctx.translate(...local(...topLeft))
    drawDescriptionTable(ctx, course, boxM * zoom)
    ctx.restore()
  }
}
