import { type CourseRun, formatTime } from './course'
import type { Hud } from './hud'
import { formatNumber, t } from './i18n'
import {
  courseKey,
  deleteResult,
  fetchResults,
  MAX_NAME_LENGTH,
  type Result,
  type ResultsFile,
  resultsCourse,
  resultsTable,
  runTime,
  type Sort,
  saveResult,
} from './results'

// The Finished panel (a name for the result, in competition mode) and the results list
// window: a WinSplits-like table of the course's results, with each route on the map.

const NAME_KEY = 'terraino.name'
// The run that is not on the list (not saved) is shown with this id.
const UNSAVED = 'unsaved'
const ROUTE_COLORS = ['#d7263d', '#1b78e0', '#f08a24', '#2e933c', '#8e44ad', '#e84393', '#138d75', '#6d6875']

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text?: string) {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  parent.appendChild(e)
  return e
}

function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

/** A result id: unique enough for one results list. */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class ResultsView {
  /** Called when the Finished panel opens or closes; the game pauses while it is open. */
  onFinishPanel: (open: boolean) => void = () => {}
  private readonly map: string
  private readonly run: CourseRun
  private readonly hud: Hud
  private readonly panel: HTMLDivElement
  private readonly window: HTMLDivElement
  private readonly title: HTMLSpanElement
  private readonly status: HTMLDivElement
  private readonly table: HTMLTableElement
  private readonly allRunsBox: HTMLInputElement
  private file: ResultsFile | null = null
  /** The last run, when it is not on the list. */
  private unsaved: Result | null = null
  /** The result just saved, highlighted. */
  private mine: string | null = null
  private sort: Sort = { by: 'time' }
  /** Results whose routes are on the map, in the order they were ticked. */
  private routes: string[] = []

  constructor(root: HTMLElement, map: string, run: CourseRun, hud: Hud) {
    this.map = map
    this.run = run
    this.hud = hud

    this.panel = el('div', 'finish-panel', root)
    this.panel.hidden = true

    this.window = el('div', 'results-window', root)
    this.window.hidden = true
    const head = el('div', 'hud-map-head', this.window)
    this.title = el('span', 'hud-map-title', head)
    const close = el('button', 'hud-map-button close', head, '✕')
    close.title = t('close')
    close.addEventListener('click', () => (this.window.hidden = true))
    const tools = el('div', 'results-tools', this.window)
    const allRuns = el('label', 'hud-map-check', tools)
    this.allRunsBox = el('input', '', allRuns)
    this.allRunsBox.type = 'checkbox'
    allRuns.append(` ${t('allRuns')}`)
    this.allRunsBox.addEventListener('change', () => this.render())
    this.status = el('div', 'results-status', tools)
    const body = el('div', 'results-body', this.window)
    this.table = el('table', 'results-table', body)
  }

  get finishOpen(): boolean {
    return !this.panel.hidden
  }

  /** A new course: its list is another one; forget the last run and its routes. */
  courseChanged() {
    this.file = null
    this.unsaved = null
    this.mine = null
    this.routes = []
    this.sort = { by: 'time' }
    this.showRoutes()
    this.window.hidden = true
  }

  /** The run has just finished: show the run time, and ask for a name if it can be saved. */
  finished() {
    const route = this.run.route.map(([e, n]): [number, number] => [Math.round(e * 10) / 10, Math.round(n * 10) / 10])
    const result: Result = { id: newId(), name: '', date: new Date().toISOString(), splits: [...this.run.splits], route }
    this.panel.replaceChildren()
    el('h2', '', this.panel, t('finishTitle', { time: formatTime(runTime(result)) }))
    const buttons = () => el('div', 'finish-buttons', this.panel)
    if (!this.run.competitionRun) {
      el('p', 'finish-note', this.panel, t('notSaved'))
      const row = buttons()
      this.button(row, t('showResults'), true, () => this.closeFinish(result))
      this.button(row, t('close'), false, () => this.closeFinish(null, result))
    } else {
      const form = el('form', 'finish-form', this.panel)
      const label = el('label', '', form, t('yourName'))
      const input = el('input', '', label)
      input.type = 'text'
      input.maxLength = MAX_NAME_LENGTH
      input.value = storedName()
      input.autocomplete = 'name'
      const error = el('p', 'finish-error', this.panel)
      const row = buttons()
      const save = this.button(row, t('saveResult'), true, () => form.requestSubmit())
      this.button(row, t('dontSave'), false, () => this.closeFinish(result))
      form.addEventListener('submit', e => {
        e.preventDefault()
        const name = input.value.trim()
        if (!name) {
          error.textContent = t('nameMissing')
          input.focus()
          return
        }
        save.disabled = true
        void this.save({ ...result, name }).then(
          () => this.closeFinish(null),
          (err: unknown) => {
            save.disabled = false
            error.textContent = t('saveFailed', { message: err instanceof Error ? err.message : String(err) })
          },
        )
      })
      setTimeout(() => input.select(), 0)
    }
    this.panel.hidden = false
    this.onFinishPanel(true)
  }

  private button(parent: HTMLElement, text: string, primary: boolean, onClick: () => void) {
    const b = el('button', primary ? '' : 'secondary', parent, text)
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }

  /**
   * Close the Finished panel and open the results list, with `unsaved` as a run that is
   * not on it; `keep` is a run kept for its route without opening the list.
   */
  private closeFinish(unsaved: Result | null, keep: Result | null = null) {
    this.panel.hidden = true
    this.onFinishPanel(false)
    const run = unsaved ?? keep
    if (run) {
      this.unsaved = { ...run, id: UNSAVED, name: t('notOnList') }
      this.mine = UNSAVED
      this.routes = [UNSAVED]
      this.showRoutes()
    }
    if (unsaved || !keep) void this.open()
  }

  private async save(result: Result) {
    try {
      localStorage.setItem(NAME_KEY, result.name)
    } catch {
      // The name is not remembered; the result is still saved.
    }
    this.file = await saveResult(this.map, courseKey(this.run.course), resultsCourse(this.run.course), result)
    this.unsaved = null
    this.mine = result.id
    this.routes = [result.id]
    this.showRoutes()
  }

  /** Open the results list of the course being run. */
  async open() {
    if (this.run.course.controls.length < 2) return
    this.window.hidden = false
    this.title.textContent = this.courseTitle()
    this.status.textContent = ''
    try {
      this.file = await fetchResults(this.map, courseKey(this.run.course))
    } catch (err) {
      this.status.textContent = t('resultsFailed', { message: err instanceof Error ? err.message : String(err) })
    }
    this.render()
  }

  private courseTitle(): string {
    const course = this.run.course
    if (course.imported) return `${t('results')} · ${course.imported.name}`
    let metres = 0
    for (let i = 1; i < course.controls.length; i++) {
      const [e0, n0] = course.controls[i - 1]!
      const [e1, n1] = course.controls[i]!
      metres += Math.hypot(e1 - e0, n1 - n0)
    }
    const km = metres / 1000
    const controls = course.controls.length - 2
    return `${t('results')} · ${t(controls === 1 ? 'handSetCourseOne' : 'handSetCourse', {
      controls,
      length: formatNumber(km, km < 1 ? 2 : 1),
    })}`
  }

  private allResults(): Result[] {
    return [...(this.file?.results ?? []), ...(this.unsaved ? [this.unsaved] : [])]
  }

  /** Put the ticked routes on the map, each in its colour. */
  private showRoutes() {
    const byId = new Map(this.allResults().map(r => [r.id, r]))
    this.routes = this.routes.filter(id => byId.has(id))
    this.hud.routes = this.routes.map((id, i) => ({ points: byId.get(id)!.route, color: ROUTE_COLORS[i % ROUTE_COLORS.length]! }))
  }

  private render() {
    if (this.status.textContent === t('noResults')) this.status.textContent = ''
    const results = this.file?.results ?? []
    const rows = resultsTable(results, { allRuns: this.allRunsBox.checked, extra: this.unsaved, sort: this.sort })
    this.table.replaceChildren()
    if (!rows.length) {
      this.status.textContent ||= t('noResults')
      return
    }
    const n = this.run.course.controls.length
    const codes = this.file?.course.codes ?? resultsCourse(this.run.course).codes
    const head = el('tr', '', el('thead', '', this.table))
    el('th', '', head)
    el('th', 'place', head, '#')
    el('th', 'name', head, t('nameHeader'))
    for (let i = 0; i < n - 1; i++) {
      const to = i === n - 2 ? t('finishShort') : String(i + 1)
      const code = i < n - 2 ? codes?.[i + 1] : undefined
      const th = el('th', 'leg sortable', head, `${i === 0 ? 'S' : i}-${to}${code ? ` (${code})` : ''}`)
      th.title = t('sortHint')
      if (this.sort.by !== 'time' && this.sort.index === i) th.classList.add(`sorted-${this.sort.by}`)
      th.addEventListener('click', () => {
        // Leg time, then split time, then back to the run time.
        const same = this.sort.by !== 'time' && this.sort.index === i
        this.sort = !same ? { by: 'leg', index: i } : this.sort.by === 'leg' ? { by: 'split', index: i } : { by: 'time' }
        this.render()
      })
    }
    el('th', '', head)

    const body = el('tbody', '', this.table)
    const colorOf = (id: string) => {
      const i = this.routes.indexOf(id)
      return i < 0 ? null : ROUTE_COLORS[i % ROUTE_COLORS.length]!
    }
    for (const row of rows) {
      const id = row.result.id
      const mine = id === this.mine ? ' mine' : ''
      const legs = el('tr', `legs${mine}`, body)
      const splits = el('tr', `splits${mine}`, body)

      const routeCell = el('td', 'route', legs)
      routeCell.rowSpan = 2
      const box = el('input', '', routeCell)
      box.type = 'checkbox'
      box.title = t('showRoute')
      box.checked = this.routes.includes(id)
      const color = colorOf(id)
      if (color) box.style.accentColor = color
      box.addEventListener('change', () => {
        this.routes = box.checked ? [...this.routes, id] : this.routes.filter(r => r !== id)
        this.showRoutes()
        this.render()
      })

      el('td', 'place', legs, row.place === null ? '' : String(row.place))
      el('td', 'name', legs, row.label)
      el('td', 'place', splits)
      el('td', 'name behind', splits, row.place === null ? '' : `+${formatTime(row.behind)}`)
      row.legs.forEach((time, i) => {
        const cell = el('td', `time${row.bestLegs[i] ? ' best' : ''}`, legs, formatTime(time))
        if (row.legPlaces[i] !== null) el('span', 'rank', cell, ` (${row.legPlaces[i]})`)
        const split = el('td', `time${row.bestSplits[i] ? ' best' : ''}`, splits, formatTime(row.result.splits[i]!))
        if (row.splitPlaces[i] !== null) el('span', 'rank', split, ` (${row.splitPlaces[i]})`)
      })

      const deleteCell = el('td', 'delete', legs)
      deleteCell.rowSpan = 2
      if (id !== UNSAVED) {
        const remove = el('button', 'hud-map-button', deleteCell, '✕')
        remove.title = t('deleteResult')
        remove.addEventListener('click', () => void this.remove(row.result))
      }
    }
  }

  private async remove(result: Result) {
    if (!confirm(t('confirmDelete', { name: result.name, time: formatTime(runTime(result)) }))) return
    try {
      this.file = await deleteResult(this.map, courseKey(this.run.course), result.id)
      this.showRoutes()
      this.render()
    } catch (err) {
      this.status.textContent = t('resultsFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }
}
