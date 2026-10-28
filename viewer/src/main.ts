import * as THREE from 'three'
import './style.css'
import { loadBuildings } from './buildings'
import { GameClock } from './clock'
import { beep, type Control, type Course, CourseRun, loadCourse } from './course'
import { Environment } from './environment'
import { MapFeatures } from './features'
import { FAR_DISTANCE, Forest } from './forest'
import { Gfx, QUALITY } from './gfx'
import { GrainFields } from './grain'
import { asLayerTexture } from './groundMaterial'
import { HeightField } from './heightfield'
import { Hud } from './hud'
import { applyTranslations, formatNumber, setupLanguageFlags, t, type TextKey } from './i18n'
import { decodePng, LayerStore } from './layers'
import { type CourseControl, type CourseFile, type ImportedCourse, readCourseFile } from './ocad/courses'
import { OcadError } from './ocad/reader'
import { blocked, type PlacementData, placeFlag } from './placement'
import { isTyping } from './keyboard'
import { Player } from './player'
import { courseFileProblem, fetchRaceFile, listRaces, outsideMap, type Race } from './races'
import { takeAdminKey } from './results'
import { ResultsView } from './resultsView'
import { Terrain } from './terrain'
import { Tracks } from './tracks'
import { Undergrowth } from './undergrowth'
import { listWorlds, World } from './world'

const app = document.getElementById('app')!
const overlay = document.getElementById('overlay')!
const status = document.getElementById('status')!
const startButton = document.getElementById('start') as HTMLButtonElement
const worldSelect = document.getElementById('world-select') as HTMLSelectElement
const langFlags = document.getElementById('lang-flags')!
const raceLabel = document.getElementById('race-label')!
const raceSelect = document.getElementById('race-select') as HTMLSelectElement
const courseFileButton = document.getElementById('course-file-button') as HTMLButtonElement
const resultsButton = document.getElementById('results-button') as HTMLButtonElement
const courseFile = document.getElementById('course-file') as HTMLInputElement
const courseLabel = document.getElementById('course-label')!
const courseSelect = document.getElementById('course-select') as HTMLSelectElement

takeAdminKey()
applyTranslations()
setupLanguageFlags(langFlags)

/** Let the browser draw and handle input between heavy startup steps. */
function pause(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function setStatus(text: string) {
  status.textContent = text
}

async function chooseWorld(): Promise<string | null> {
  const fromUrl = new URLSearchParams(location.search).get('world')
  const worlds = await listWorlds()
  for (const name of worlds) {
    const option = document.createElement('option')
    option.value = option.textContent = name
    worldSelect.appendChild(option)
  }
  worldSelect.addEventListener('change', () => {
    const params = new URLSearchParams()
    params.set('world', worldSelect.value)
    const lang = new URLSearchParams(location.search).get('lang')
    if (lang) params.set('lang', lang)
    location.search = params.toString()
  })
  const name = fromUrl ?? worlds[0] ?? null
  if (name) worldSelect.value = name
  return name
}

/** Look towards a heading (degrees clockwise from north), tilted up or down by a pitch. */
function face(player: Player, headingDeg: number, pitchDeg = 0) {
  player.camera.rotation.set(THREE.MathUtils.degToRad(pitchDeg), -THREE.MathUtils.degToRad(headingDeg), 0, 'YXZ')
}

/**
 * Viewpoint from the URL, for sharing a spot or for screenshots:
 * at=E,N[,heightAboveGround] in the world's CRS, look=headingDeg[,pitchDeg].
 */
function applyViewParams(player: Player, world: World) {
  const params = new URLSearchParams(location.search)
  const at = params.get('at')?.split(',').map(Number)
  if (at && at.length >= 2 && at.every(Number.isFinite)) {
    const [x, z] = world.toScene(at[0]!, at[1]!)
    player.placeAt(x, z)
    if (at[2] !== undefined && at[2] > 0) {
      player.toggleFlying()
      player.camera.position.y += at[2]
    }
  }
  const look = params.get('look')?.split(',').map(Number)
  if (look && look.every(Number.isFinite)) face(player, look[0] ?? 0, look[1] ?? 0)
}

/**
 * A course from an OCAD file, with each flag placed by its control description, and the
 * file's other controls (`all`), which stand in the terrain too.
 */
function courseFrom(imported: ImportedCourse, all: CourseControl[], world: World, placement: PlacementData): Course {
  const controls = imported.controls.map(c => c.position)
  const flag = (c: CourseControl, previous?: Control): Control =>
    world.toProjected(
      ...placeFlag(c.description, world.toScene(...c.position), placement, previous && world.toScene(...previous)),
    )
  const flags = imported.controls.map((c, i): Control => (c.kind === 'control' ? flag(c, controls[i - 1]) : c.position))
  const onCourse = new Set(imported.controls.map(c => c.code))
  const others = all
    .filter(c => !onCourse.has(c.code))
    .map(c => ({ code: c.code, position: c.position, flag: flag(c) }))
  return { controls, imported, flags, others }
}

function ocadMessage(err: unknown): string {
  if (err instanceof OcadError) {
    return err.reason === 'version' ? t('ocadVersion', { version: err.version }) : t('notOcad')
  }
  return t('error', { message: err instanceof Error ? err.message : String(err) })
}

/** Race list, course file button and course list on the start screen. */
function setupCourseImport(name: string, world: World, placement: PlacementData, choose: (course: Course) => void) {
  let courses: ImportedCourse[] = []
  let allControls: CourseControl[] = []
  /** Offer the courses of a course file, from a race or opened by the runner. */
  const offer = (read: CourseFile, label: string) => {
    const problem = courseFileProblem(read, world.manifest)
    if (problem) throw new Error(t(problem.kind, problem))
    courses = read.courses
    allControls = read.controls
    courseSelect.replaceChildren(new Option(t('chooseCourse'), ''))
    courses.forEach((c, i) => courseSelect.add(new Option(c.name, String(i))))
    courseLabel.hidden = false
    setStatus(t('coursesFound', { count: courses.length, file: label }))
  }
  const read = async (label: string, buffer: () => Promise<ArrayBuffer>) => {
    setStatus(t('readingCourses', { file: label }))
    try {
      offer(readCourseFile(await buffer(), world.manifest.map.offset ?? [0, 0]), label)
    } catch (err) {
      setStatus(err instanceof OcadError ? ocadMessage(err) : err instanceof Error ? err.message : String(err))
    }
  }

  let races: Race[] = []
  listRaces(name).then(
    list => {
      races = list
      raceSelect.replaceChildren(new Option(t('chooseRace'), ''))
      races.forEach((r, i) => raceSelect.add(new Option(`${r.date} · ${r.name}`, String(i))))
      raceLabel.hidden = !races.length
    },
    (err: unknown) => console.warn('No races:', err),
  )
  raceSelect.addEventListener('change', () => {
    const race = races[Number(raceSelect.value)]
    if (raceSelect.value && race) void read(race.name, () => fetchRaceFile(name, race))
  })

  courseFileButton.disabled = false
  courseFileButton.addEventListener('click', () => courseFile.click())
  courseFile.addEventListener('change', () => {
    const file = courseFile.files?.[0]
    courseFile.value = ''
    if (!file) return
    raceSelect.value = ''
    void read(file.name, () => file.arrayBuffer())
  })
  courseSelect.addEventListener('change', () => {
    const imported = courses[Number(courseSelect.value)]
    if (!courseSelect.value || !imported) return
    if (outsideMap(imported, world.manifest)) {
      setStatus(t('outsideMap', { name: imported.name }))
      return
    }
    choose(courseFrom(imported, allControls, world, placement))
    setStatus(
      t('courseChosen', {
        name: imported.name,
        controls: imported.controls.filter(c => c.kind === 'control').length,
        length: formatNumber(imported.lengthM / 1000, 1),
      }),
    )
  })
}

async function main() {
  const name = await chooseWorld()
  if (!name) {
    setStatus(t('noWorlds'))
    return
  }

  setStatus(t('loadingWorld', { name }))
  const world = await World.load(name)
  const heights = await HeightField.load(world, (done, total) =>
    setStatus(t('loadingTerrain', { percent: Math.round((100 * done) / total) })),
  )
  const overview = await new THREE.TextureLoader().loadAsync(world.url(world.manifest.drape.overview))

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  // Reading every shader's log makes the browser wait for each compile; keep that for development.
  if (import.meta.env.PROD) renderer.debug.checkShaderErrors = false
  app.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.25, 30000)
  // Follow the window from the start: it can change size (or move to another screen)
  // while the world loads, and the canvas must still fill it afterwards.
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
  })
  const environment = new Environment(scene, renderer)
  const quality = new URLSearchParams(location.search).get('quality')
  if (quality === 'high' || quality === 'medium' || quality === 'low') environment.setQuality(quality)
  setStatus(t('paintingTextures'))
  await pause()
  const gfx = new Gfx(renderer)
  gfx.setQuality(QUALITY[environment.quality])
  gfx.buildImpostors(renderer, environment.sunDirection)

  const layerInfo = world.manifest.layers
  const layers = layerInfo ? new LayerStore(world, layerInfo) : undefined
  let layerOverview: { texture: THREE.Texture; size: [number, number] } | undefined
  if (layerInfo) {
    const { bitmap } = await decodePng(world.url(layerInfo.overview))
    layerOverview = { texture: asLayerTexture(new THREE.Texture(bitmap)), size: [bitmap.width, bitmap.height] }
  }
  const terrain = new Terrain(world, heights, {
    overviewDrape: overview,
    layers,
    layerOverview,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    canopyFade: [FAR_DISTANCE * 0.7, FAR_DISTANCE],
    groundTex: gfx.groundArray,
  })
  terrain.setQuality(QUALITY[environment.quality])
  scene.add(terrain.group)

  setStatus(t('buildingWorld'))
  await pause()
  const tracks = await Tracks.load(world, heights, gfx)
  tracks?.setQuality(QUALITY[environment.quality])
  if (tracks) scene.add(tracks.group)
  const treeInfo = world.manifest.trees
  const forest = treeInfo ? new Forest(world, treeInfo, heights, gfx, QUALITY[environment.quality]) : null
  if (forest) {
    forest.tracks = tracks
    forest.shadows = environment.quality !== 'low'
    scene.add(forest.group)
  }
  const undergrowth = layers
    ? new Undergrowth(layers, heights, gfx, QUALITY[environment.quality], layerInfo?.undergrowth === 'lidar')
    : null
  if (undergrowth) undergrowth.tracks = tracks
  if (undergrowth) scene.add(undergrowth.group)
  const grain = layers ? new GrainFields(layers, heights, gfx.grainSurface) : null
  if (grain) scene.add(grain.group)
  await pause()
  const buildings = await loadBuildings(world, gfx)
  if (buildings) scene.add(buildings.group)
  await pause()
  const features = await MapFeatures.load(world, heights, gfx, QUALITY[environment.quality], tracks)
  if (features && undergrowth) undergrowth.setStumps(features.stumps)
  if (features) scene.add(features.group)

  const player = new Player(camera, renderer.domElement, heights, world.sceneSize)
  const n = heights.chunk
  player.surroundings = {
    speedAt: (x, z) => {
      const cx = Math.floor(x / n)
      const cy = Math.floor(z / n)
      return layers?.get(cx, cy)?.sample(x - cx * n, z - cy * n).speed ?? null
    },
    collide: (x, z, r) => {
      let p: [number, number] = [x, z]
      if (forest) p = forest.collide(p[0], p[1], r)
      if (features) p = features.collide(p[0], p[1], r)
      return p
    },
    deckAt: (x, z) => tracks?.deckAt(x, z) ?? null,
  }
  const [sx, sz] = world.toScene(...world.manifest.spawn)
  player.placeAt(sx, sz)
  face(player, world.manifest.spawnHeading ?? 0)
  applyViewParams(player, world)
  const placement: PlacementData = {
    ...(features?.data ?? { kinds: [], points: [], lines: [], cliffs: [] }),
    buildings: buildings?.outlines ?? [],
    heightAt: (x, z) => heights.heightAt(x, z),
  }
  const run = new CourseRun(world, heights, loadCourse(world), (x, z) => blocked(placement, [x, z]))
  scene.add(run.group)
  const qualityNames: Record<typeof environment.quality, TextKey> = {
    high: 'qualityHigh',
    medium: 'qualityMedium',
    low: 'qualityLow',
  }
  const clock = new GameClock()
  const hud = new Hud(document.getElementById('hud')!, world, player, run, clock, () => {
    const trees = forest?.drawn ?? { near: 0, total: 0 }
    return t('treesStatus', {
      near: formatNumber(trees.near),
      total: formatNumber(trees.total),
      quality: t(qualityNames[environment.quality]),
    })
  })
  hud.showDescriptions(true)
  // Results lists are kept per world folder (the map's name may differ between builds).
  const resultsView = new ResultsView(document.getElementById('hud')!, name, run, hud)
  run.punchListener = () => {
    beep()
    if (run.state === 'finished') resultsView.finished()
  }
  resultsButton.addEventListener('click', () => void resultsView.open())
  // The map window gets the mouse when it opens. Pressing on the terrain takes it back
  // for steering (the map stays open), and Esc gives it to the map again.
  const resume = document.getElementById('resume')!
  const updateResume = () => {
    resume.hidden = !(hud.mapOpen && !player.controls.isLocked && overlay.hidden && !resultsView.finishOpen)
  }
  resultsView.onFinishPanel = open => {
    if (open) player.controls.unlock()
    updateResume()
  }
  hud.onMapToggle = open => {
    player.keysWithoutLock = open
    if (open) player.controls.unlock()
    else if (overlay.hidden) player.controls.lock()
    updateResume()
  }
  // Whether Start should open the map again: it was open when the start screen was shown.
  let mapWasOpen = false
  // When the mouse was last let go. The Esc that lets it go (the browser's) may also reach
  // the page; it must not pause the game as well.
  let unlockedAt = -Infinity
  /** Back to the start screen (H), to choose another map or course; game time stands still there. */
  const showStartScreen = () => {
    if (!overlay.hidden) return
    mapWasOpen = hud.mapOpen
    // Shown first, so that closing the map does not take the mouse for steering.
    overlay.hidden = false
    hud.toggleMap(false)
    player.controls.unlock()
    updateResume()
  }
  hud.onStartScreen = showStartScreen
  let dragLook: { x: number; y: number } | null = null
  renderer.domElement.addEventListener('pointerdown', e => {
    if (!overlay.hidden || player.controls.isLocked) return
    dragLook = { x: e.clientX, y: e.clientY }
    if (e.pointerType === 'mouse') player.controls.lock()
  })
  window.addEventListener('pointermove', e => {
    if (!dragLook || player.controls.isLocked) return
    player.look(e.clientX - dragLook.x, e.clientY - dragLook.y)
    dragLook = { x: e.clientX, y: e.clientY }
  })
  window.addEventListener('pointerup', () => (dragLook = null))
  hud.onTeleport = (east, north) => {
    const [x, z] = world.toScene(east, north)
    if (player.flying) player.toggleFlying()
    player.placeAt(x, z)
  }
  document.addEventListener('pointerlockerror', () => {
    if (!hud.mapOpen) overlay.hidden = false
    updateResume()
  })
  /**
   * Put the runner at the start, ready to run: a few metres behind the start banner, looking
   * at it and the start control, as when a course is opened (T does the same).
   */
  const goToStart = () => {
    if (!run.course.controls.length) return
    if (player.flying) player.toggleFlying()
    run.reset()
    const view = run.startView()
    if (view) {
      player.placeAt(view.x, view.z)
      player.camera.rotation.set(THREE.MathUtils.degToRad(-4), -view.heading, 0, 'YXZ')
    } else {
      const start = run.scenePosition(0)
      player.placeAt(start.x, start.z)
    }
  }
  player.canFly = () => player.flying || hud.allow()
  window.addEventListener('keydown', e => {
    if (isTyping(e)) return
    if (e.code === 'KeyO' && hud.allow()) {
      terrain.setMode(terrain.mode === 'ground' ? 'map' : 'ground')
      // The grain surface would hide the map's fields.
      if (grain) grain.group.visible = terrain.mode === 'ground'
    }
    // The time factor, in steps; not while paused behind the overlay.
    if (overlay.hidden && !e.repeat) {
      if (e.code === 'KeyE') clock.faster()
      if (e.code === 'KeyQ') clock.slower()
    }
    // H pauses on the start screen; so does Esc once the mouse is free (the first Esc
    // while steering only gives the mouse to the map).
    if (e.code === 'KeyH') showStartScreen()
    if (e.code === 'Escape' && !player.controls.isLocked && performance.now() - unlockedAt > 300) {
      showStartScreen()
    }
    if (e.code === 'KeyT') goToStart()
    if (e.code === 'KeyR') run.reset()
    if (e.code === 'KeyG') {
      const order = ['high', 'medium', 'low'] as const
      environment.setQuality(order[(order.indexOf(environment.quality) + 1) % order.length]!)
      const settings = QUALITY[environment.quality]
      gfx.setQuality(settings)
      if (forest) forest.shadows = environment.quality !== 'low'
      forest?.setQuality(settings)
      undergrowth?.setQuality(settings)
      features?.setQuality(settings)
      terrain.setQuality(settings)
      tracks?.setQuality(settings)
    }
  })

  setStatus(t('preparingTerrain'))
  await terrain.prepare(camera.position)
  if (forest) {
    setStatus(t('plantingTrees'))
    await forest.prepare(camera.position)
  }
  undergrowth?.update(camera.position)
  grain?.fill()
  // Compile the shaders now, in parallel where the browser can, instead of all at once
  // (and waiting for each) when the first frame is drawn.
  setStatus(t('compilingShaders'))
  await pause()
  await renderer.compileAsync(scene, camera)

  setupCourseImport(name, world, placement, course => {
    run.setCourse(course)
    hud.showDescriptions(true)
    goToStart()
  })
  startButton.hidden = false
  if (new URLSearchParams(location.search).has('start')) overlay.hidden = true
  setStatus(
    world.manifest.map.scale ? `${world.manifest.name} · 1:${world.manifest.map.scale}` : world.manifest.name,
  )
  // The first start opens the map, with the mouse free for it; clicking the terrain
  // then takes the mouse for steering. Later Start resumes as before the pause: with the
  // map open again if it was open when H showed the start screen, else steering.
  let started = false
  startButton.addEventListener('click', () => {
    hud.readyToRun()
    if ((started && !mapWasOpen) || hud.mapOpen) {
      player.controls.lock()
      return
    }
    started = true
    mapWasOpen = false
    overlay.hidden = true
    hud.toggleMap(true)
    updateResume()
  })
  player.controls.addEventListener('lock', () => {
    overlay.hidden = true
    updateResume()
  })
  player.controls.addEventListener('unlock', () => {
    unlockedAt = performance.now()
    // The Finished panel takes the mouse for the name; the game is paused under it.
    overlay.hidden = hud.mapOpen || resultsView.finishOpen
    updateResume()
  })

  // For poking at the scene from the browser console while developing.
  if (import.meta.env.DEV) {
    Object.assign(window, { terraino: { THREE, renderer, scene, camera, gfx, forest, undergrowth, grain, player, run, hud, clock } })
  }

  // A hidden tab gets no frames; the timer then starts afresh instead of counting the time away.
  const timer = new THREE.Timer()
  timer.connect(document)
  let shownCourse: Course | null = null
  renderer.setAnimationLoop(() => {
    timer.update()
    const dt = Math.min(timer.getDelta(), 0.1)
    // The wind keeps real time; the runner and the run clock go by game time, which stands
    // still while the overlay covers the game (Esc).
    gfx.time.value += dt
    // A new course has a results list of its own.
    if (run.course !== shownCourse) {
      shownCourse = run.course
      resultsView.courseChanged()
      resultsButton.disabled = run.course.controls.length < 2
    }
    clock.advance(dt, { paused: !overlay.hidden || resultsView.finishOpen, flying: player.flying }, step => {
      player.update(step)
      if (!player.flying) run.update(camera.position, clock.time)
    })
    terrain.update(camera.position)
    forest?.update(camera.position)
    undergrowth?.update(camera.position)
    features?.update(camera.position)
    tracks?.update(camera.position)
    grain?.update()
    environment.update(camera)
    hud.update(dt)
    renderer.render(scene, camera)
  })
}

main().catch(err => {
  console.error(err)
  setStatus(t('error', { message: err instanceof Error ? err.message : String(err) }))
})
