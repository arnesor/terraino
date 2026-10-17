import * as THREE from 'three'
import './style.css'
import { loadBuildings } from './buildings'
import { beep, CourseRun, loadCourse } from './course'
import { Environment } from './environment'
import { MapFeatures } from './features'
import { FAR_DISTANCE, Forest } from './forest'
import { Gfx, QUALITY } from './gfx'
import { asLayerTexture } from './groundMaterial'
import { HeightField } from './heightfield'
import { Hud } from './hud'
import { decodePng, LayerStore } from './layers'
import { Player } from './player'
import { Terrain } from './terrain'
import { Tracks } from './tracks'
import { Undergrowth } from './undergrowth'
import { listWorlds, World } from './world'

const app = document.getElementById('app')!
const overlay = document.getElementById('overlay')!
const status = document.getElementById('status')!
const startButton = document.getElementById('start') as HTMLButtonElement
const worldSelect = document.getElementById('world-select') as HTMLSelectElement

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
    location.search = `?world=${encodeURIComponent(worldSelect.value)}`
  })
  const name = fromUrl ?? worlds[0] ?? null
  if (name) worldSelect.value = name
  return name
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
  if (look && look.every(Number.isFinite)) {
    const heading = THREE.MathUtils.degToRad(look[0] ?? 0)
    const pitch = THREE.MathUtils.degToRad(look[1] ?? 0)
    player.camera.rotation.set(pitch, -heading, 0, 'YXZ')
  }
}

async function main() {
  const name = await chooseWorld()
  if (!name) {
    setStatus('No worlds found. Build one first:\n  uv run otest build <map.ocd>')
    return
  }

  setStatus(`Loading ${name} …`)
  const world = await World.load(name)
  const heights = await HeightField.load(world, (done, total) =>
    setStatus(`Loading terrain ${Math.round((100 * done) / total)} %`),
  )
  const overview = await new THREE.TextureLoader().loadAsync(world.url(world.manifest.drape.overview))

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  app.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.25, 30000)
  const environment = new Environment(scene, renderer)
  const quality = new URLSearchParams(location.search).get('quality')
  if (quality === 'high' || quality === 'medium' || quality === 'low') environment.setQuality(quality)
  setStatus('Painting textures …')
  await new Promise(resolve => setTimeout(resolve, 0))
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
  scene.add(terrain.group)

  const tracks = await Tracks.load(world, heights, gfx)
  if (tracks) scene.add(tracks.group)
  const treeInfo = world.manifest.trees
  const forest = treeInfo ? new Forest(world, treeInfo, heights, gfx, QUALITY[environment.quality]) : null
  if (forest) {
    forest.tracks = tracks
    forest.shadows = environment.quality !== 'low'
    scene.add(forest.group)
  }
  const undergrowth = layers ? new Undergrowth(layers, heights, gfx, QUALITY[environment.quality]) : null
  if (undergrowth) undergrowth.tracks = tracks
  if (undergrowth) scene.add(undergrowth.group)
  const buildings = await loadBuildings(world)
  if (buildings) scene.add(buildings)
  const features = await MapFeatures.load(world, heights, gfx)
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
  applyViewParams(player, world)
  const run = new CourseRun(world, heights, loadCourse(world))
  scene.add(run.group)
  run.punchListener = () => beep()
  const hud = new Hud(document.getElementById('hud')!, world, player, run, () => {
    const trees = forest?.drawn ?? { near: 0, total: 0 }
    return `${trees.near.toLocaleString('en')} near / ${trees.total.toLocaleString('en')} trees · ${environment.quality} quality`
  })
  // The map window gets the mouse when it opens. Pressing on the terrain takes it back
  // for steering (the map stays open), and Esc gives it to the map again.
  const resume = document.getElementById('resume')!
  const updateResume = () => {
    resume.hidden = !(hud.mapOpen && !player.controls.isLocked && overlay.hidden)
  }
  hud.onMapToggle = open => {
    player.keysWithoutLock = open
    if (open) player.controls.unlock()
    else player.controls.lock()
    updateResume()
  }
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
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyO') terrain.setMode(terrain.mode === 'ground' ? 'map' : 'ground')
    if (e.code === 'KeyT' && run.course.controls.length) {
      const start = run.scenePosition(0)
      if (player.flying) player.toggleFlying()
      player.placeAt(start.x, start.z)
      run.reset()
    }
    if (e.code === 'KeyR') run.reset()
    if (e.code === 'KeyG') {
      const order = ['high', 'medium', 'low'] as const
      environment.setQuality(order[(order.indexOf(environment.quality) + 1) % order.length]!)
      const settings = QUALITY[environment.quality]
      gfx.setQuality(settings)
      if (forest) forest.shadows = environment.quality !== 'low'
      forest?.setQuality(settings)
      undergrowth?.setQuality(settings)
    }
  })

  setStatus('Preparing terrain …')
  await terrain.prepare(camera.position)
  if (forest) {
    setStatus('Planting trees …')
    await forest.prepare(camera.position)
  }
  undergrowth?.update(camera.position)

  startButton.hidden = false
  if (new URLSearchParams(location.search).has('start')) overlay.hidden = true
  setStatus(
    world.manifest.map.scale ? `${world.manifest.name} · 1:${world.manifest.map.scale}` : world.manifest.name,
  )
  startButton.addEventListener('click', () => player.controls.lock())
  player.controls.addEventListener('lock', () => {
    overlay.hidden = true
    updateResume()
  })
  player.controls.addEventListener('unlock', () => {
    overlay.hidden = hud.mapOpen
    updateResume()
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // For poking at the scene from the browser console while developing.
  if (import.meta.env.DEV) Object.assign(window, { otest: { THREE, renderer, scene, camera, gfx, forest, undergrowth, player } })

  const timer = new THREE.Timer()
  renderer.setAnimationLoop(() => {
    timer.update()
    const dt = Math.min(timer.getDelta(), 0.1)
    gfx.time.value += dt
    player.update(dt)
    terrain.update(camera.position)
    forest?.update(camera.position)
    undergrowth?.update(camera.position)
    if (!player.flying) run.update(camera.position)
    environment.update(camera)
    hud.update(dt)
    renderer.render(scene, camera)
  })
}

main().catch(err => {
  console.error(err)
  setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
})
