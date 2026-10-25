// The competition mode tutorial: a window of steps, opened from the map window.

import { t, type TextKey } from './i18n'

/** The steps, each a title and a text (see `render` for the text's few marks). */
const STEPS: [TextKey, TextKey][] = [
  ['tutorialAboutTitle', 'tutorialAbout'],
  ['tutorialBeforeTitle', 'tutorialBefore'],
  ['tutorialSteeringTitle', 'tutorialSteering'],
  ['tutorialSettingTitle', 'tutorialSetting'],
  ['tutorialThumbTitle', 'tutorialThumb'],
  ['tutorialLegTitle', 'tutorialLeg'],
  ['tutorialControlTitle', 'tutorialControl'],
  ['tutorialFinishTitle', 'tutorialFinish'],
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text?: string) {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  parent.appendChild(e)
  return e
}

/**
 * Add `text` to `parent`: a paragraph per line, a list item for each line that starts with
 * "- ", and **bold** for keys and buttons.
 */
function render(parent: HTMLElement, text: string) {
  let list: HTMLUListElement | null = null
  for (const line of text.split('\n')) {
    const item = line.startsWith('- ')
    if (!item) list = null
    else list ??= el('ul', '', parent)
    const block = list ? el('li', '', list) : el('p', '', parent)
    ;(item ? line.slice(2) : line).split(/\*\*(.+?)\*\*/).forEach((part, i) => {
      if (i % 2) el('strong', '', block, part)
      else block.append(part)
    })
  }
}

/** The tutorial window; it remembers its step while closed. */
export class Tutorial {
  private readonly window: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly count: HTMLSpanElement
  private readonly back: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private step = 0

  constructor(root: HTMLElement) {
    this.window = el('div', 'tutorial-window', root)
    this.window.hidden = true
    const head = el('div', 'hud-map-head', this.window)
    el('span', 'hud-map-title', head, t('tutorialWindow'))
    const close = el('button', 'hud-map-button close', head, '✕')
    close.title = t('close')
    close.addEventListener('click', () => this.toggle(false))
    this.body = el('div', 'tutorial-body', this.window)
    const tools = el('div', 'tutorial-tools', this.window)
    this.back = el('button', 'hud-map-button', tools, t('tutorialBack'))
    this.back.addEventListener('click', () => this.show(this.step - 1))
    this.count = el('span', 'tutorial-count', tools)
    this.next = el('button', 'hud-map-button', tools)
    this.next.addEventListener('click', () => {
      if (this.step < STEPS.length - 1) this.show(this.step + 1)
      else this.toggle(false)
    })
  }

  /** Open or close the tutorial, at the step it was on. */
  toggle(open = this.window.hidden) {
    this.window.hidden = !open
    if (open) this.show(this.step)
  }

  private show(step: number) {
    this.step = Math.min(Math.max(step, 0), STEPS.length - 1)
    const [title, text] = STEPS[this.step]!
    this.body.replaceChildren()
    el('h3', '', this.body, t(title))
    render(this.body, t(text))
    this.body.scrollTop = 0
    this.count.textContent = t('tutorialCount', { step: this.step + 1, count: STEPS.length })
    this.back.disabled = this.step === 0
    this.next.textContent = this.step < STEPS.length - 1 ? t('tutorialNext') : t('close')
  }
}
