// All text shown in the user interface, in every language, in one place.
//
// To add a language, add it to LANGS: the type check (npm run typecheck) then lists
// every string that still needs a translation. Texts may hold {name} placeholders,
// filled in by t(key, { name: value }). Keyboard shortcuts are the same in every language.

export const LANGS = { en: 'English', nb: 'Norsk' } as const
export type Lang = keyof typeof LANGS

const STRINGS = {
  // Start screen.
  worldLabel: { en: 'Map', nb: 'Kart' },
  languageLabel: { en: 'Language', nb: 'Språk' },
  courseFileButton: { en: 'Open course file …', nb: 'Åpne løypefil …' },
  courseFileTitle: { en: 'An OCAD course setting file (.ocd)', nb: 'En OCAD-fil med løyper (.ocd)' },
  courseLabel: { en: 'Course', nb: 'Løype' },
  chooseCourse: { en: 'Choose a course', nb: 'Velg løype' },
  startButton: { en: 'Click to start', nb: 'Klikk for å starte' },
  starting: { en: 'Starting …', nb: 'Starter …' },
  keyNameMouse: { en: 'Mouse', nb: 'Mus' },
  keyNameSpace: { en: 'Space', nb: 'Mellomrom' },
  keyMove: { en: 'move', nb: 'gå' },
  keyLook: { en: 'look around', nb: 'se deg rundt' },
  keyRun: { en: 'run (fly fast)', nb: 'løp (fly fort)' },
  keyJump: { en: 'jump (fly up)', nb: 'hopp (fly opp)' },
  keyFly: { en: 'fly on/off · C: fly down', nb: 'fly av/på · C: fly ned' },
  keyMap: { en: 'map: drag, wheel zoom, double click to go there', nb: 'kart: dra, rulle for zoom, dobbeltklikk for å gå dit' },
  keyStart: { en: 'go to the start · R restart the run', nb: 'gå til start · R start løpet på nytt' },
  keyDescriptions: { en: 'control descriptions on/off', nb: 'postbeskrivelse av/på' },
  keyGroundMap: { en: 'orienteering map on the ground on/off', nb: 'o-kartet på bakken av/på' },
  keyQuality: { en: 'graphics quality (shadows)', nb: 'grafikkvalitet (skygger)' },
  keyPause: { en: 'pause', nb: 'pause' },
  resumeHint: {
    en: 'Click the terrain to steer with the mouse · Esc to use the map · W A S D to run',
    nb: 'Klikk i terrenget for å styre med musa · Esc for å bruke kartet · W A S D for å løpe',
  },

  // Loading.
  noWorlds: { en: 'No worlds found. Build one first:\n  uv run otest build <map.ocd>', nb: 'Fant ingen verdener. Bygg en først:\n  uv run otest build <kart.ocd>' },
  loadingWorld: { en: 'Loading {name} …', nb: 'Laster {name} …' },
  loadingTerrain: { en: 'Loading terrain {percent} %', nb: 'Laster terreng {percent} %' },
  paintingTextures: { en: 'Painting textures …', nb: 'Maler teksturer …' },
  preparingTerrain: { en: 'Preparing terrain …', nb: 'Klargjør terrenget …' },
  plantingTrees: { en: 'Planting trees …', nb: 'Planter trær …' },
  error: { en: 'Error: {message}', nb: 'Feil: {message}' },

  // Course files.
  readingCourses: { en: 'Reading {file} …', nb: 'Leser {file} …' },
  coursesFound: { en: '{count} courses in {file}', nb: '{count} løyper i {file}' },
  courseChosen: { en: '{name}: {controls} controls, {length} km', nb: '{name}: {controls} poster, {length} km' },
  notOcad: { en: 'This is not an OCAD file', nb: 'Dette er ikke en OCAD-fil' },
  ocadVersion: {
    en: 'OCAD {version} files are not supported; save the file with OCAD 12 or newer',
    nb: 'OCAD {version}-filer støttes ikke; lagre fila med OCAD 12 eller nyere',
  },
  noCourses: { en: 'The file has no courses', nb: 'Fila har ingen løyper' },
  wrongZone: {
    en: 'The course file is in UTM zone {course}, the map in zone {map}',
    nb: 'Løypefila er i UTM-sone {course}, kartet i sone {map}',
  },
  outsideMap: { en: 'The course "{name}" is outside this map', nb: 'Løypa «{name}» ligger utenfor dette kartet' },

  // Status line and information.
  treesStatus: { en: '{near} near / {total} trees · {quality} quality', nb: '{near} nære / {total} trær · {quality} kvalitet' },
  qualityHigh: { en: 'high', nb: 'høy' },
  qualityMedium: { en: 'medium', nb: 'middels' },
  qualityLow: { en: 'low', nb: 'lav' },
  infoHeight: { en: 'Height {height} m · {speed} m/s', nb: 'Høyde {height} m · {speed} m/s' },
  infoFlying: { en: ' · flying', nb: ' · flyr' },
  infoRunnability: { en: 'Runnability {percent} %', nb: 'Løpbarhet {percent} %' },

  // Compass.
  compassN: { en: 'N', nb: 'N' },
  compassNE: { en: 'NE', nb: 'NØ' },
  compassE: { en: 'E', nb: 'Ø' },
  compassSE: { en: 'SE', nb: 'SØ' },
  compassS: { en: 'S', nb: 'S' },
  compassSW: { en: 'SW', nb: 'SV' },
  compassW: { en: 'W', nb: 'V' },
  compassNW: { en: 'NW', nb: 'NV' },

  // Map window.
  map: { en: 'Map', nb: 'Kart' },
  closeMap: { en: 'Close the map (M)', nb: 'Lukk kartet (M)' },
  rotateLeft: { en: 'Rotate anticlockwise', nb: 'Drei mot klokka' },
  rotateRight: { en: 'Rotate clockwise', nb: 'Drei med klokka' },
  northUp: { en: 'North up', nb: 'Nord opp' },
  auto: { en: 'Auto', nb: 'Auto' },
  autoTitle: { en: 'Turn the map with the direction you are running', nb: 'Snu kartet etter retningen du løper' },
  zoomOut: { en: 'Zoom out (wheel)', nb: 'Zoom ut (rulle)' },
  zoomIn: { en: 'Zoom in (wheel)', nb: 'Zoom inn (rulle)' },
  whole: { en: 'Whole', nb: 'Hele' },
  wholeTitle: { en: 'Show the whole map', nb: 'Vis hele kartet' },
  me: { en: 'Me', nb: 'Meg' },
  meTitle: { en: 'Centre on your position', nb: 'Midtstill på der du er' },
  position: { en: 'Position', nb: 'Posisjon' },
  setCourse: { en: 'Set course', nb: 'Legg løype' },
  setCourseTitle: {
    en: 'Click on the map to place start, controls and finish (E)',
    nb: 'Klikk på kartet for å sette start, poster og mål (E)',
  },
  done: { en: 'Done', nb: 'Ferdig' },
  helpEditing: {
    en: 'Click: add control · Right click / Backspace: remove last · Delete: clear · Drag: move · Wheel: zoom',
    nb: 'Klikk: ny post · Høyreklikk / Backspace: fjern siste · Delete: slett alt · Dra: flytt · Rulle: zoom',
  },
  helpMap: { en: 'Drag: move · Wheel: zoom · Double click: go there', nb: 'Dra: flytt · Rulle: zoom · Dobbeltklikk: gå dit' },
  linkCopied: { en: 'Link to this course copied', nb: 'Lenke til løypa kopiert' },

  // Running a course.
  atStart: { en: 'At the start – run when ready', nb: 'På start – løp når du er klar' },
  goToStart: { en: 'Go to the start △ (T: jump there)', nb: 'Gå til start △ (T: hopp dit)' },
  finish: { en: 'Finish', nb: 'Mål' },
  finishShort: { en: 'F', nb: 'M' },
  controlNumber: { en: 'Control {number}', nb: 'Post {number}' },
  finished: { en: 'Finished {time}  (R: run again)', nb: 'I mål {time}  (R: løp igjen)' },
  running: { en: '{time}  ·  next: {label}', nb: '{time}  ·  neste: {label}' },
  bannerStart: { en: 'START', nb: 'START' },
  bannerFinish: { en: 'FINISH', nb: 'MÅL' },
} satisfies Record<string, Record<Lang, string>>

export type TextKey = keyof typeof STRINGS

const STORAGE_KEY = 'otest.lang'
const LOCALES: Record<Lang, string> = { en: 'en-GB', nb: 'nb-NO' }

function isLang(value: string | null | undefined): value is Lang {
  return value != null && Object.hasOwn(LANGS, value)
}

/** The language from the URL (?lang=), the last choice, or the browser; English otherwise. */
function detectLang(): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang')
  if (isLang(fromUrl)) return fromUrl
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLang(stored)) return stored
  } catch {
    // Storage can be unavailable (private mode).
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0]
    if (base === 'nb' || base === 'nn' || base === 'no') return 'nb'
    if (isLang(base)) return base
  }
  return 'en'
}

let current: Lang = detectLang()

export function lang(): Lang {
  return current
}

/** Remember a language and reload the page in it, keeping the other URL parameters. */
export function switchLang(next: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Not remembered, but the URL carries it.
  }
  current = next
  const params = new URLSearchParams(location.search)
  params.set('lang', next)
  location.search = params.toString()
}

/** The text for `key` in the current language, with {placeholders} filled in. */
export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  return STRINGS[key][current].replace(/\{(\w+)\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all,
  )
}

/** A number in the current language's format, for example 4,0 in Norwegian. */
export function formatNumber(value: number, decimals = 0): string {
  return value.toLocaleString(LOCALES[current], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Fill in elements marked with data-i18n (text) and data-i18n-title (tooltip).
 * Unknown keys are left as they are in the HTML.
 */
export function applyTranslations(root: ParentNode = document) {
  document.documentElement.lang = current
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n
    if (key && key in STRINGS) el.textContent = t(key as TextKey)
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = el.dataset.i18nTitle
    if (key && key in STRINGS) el.title = t(key as TextKey)
  }
}

/** Fill a <select> with the languages and switch when another is chosen. */
export function setupLanguageSelect(select: HTMLSelectElement) {
  for (const [code, name] of Object.entries(LANGS)) {
    const option = document.createElement('option')
    option.value = code
    option.textContent = name
    select.appendChild(option)
  }
  select.value = current
  select.addEventListener('change', () => {
    if (isLang(select.value)) switchLang(select.value)
  })
}
