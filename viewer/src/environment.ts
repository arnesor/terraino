import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'

const SKY_SCALE = 20000
const FOG_COLOR = new THREE.Color(0xc7d6e2)

import type { Quality } from './gfx'

const SHADOW_SIZE: Record<Quality, number> = { high: 4096, medium: 2048, low: 0 }
// Half-size of the area around the player that gets sun shadows.
const SHADOW_EXTENT = 90

/** Sky dome, sun, ambient light and haze. */
export class Environment {
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
  readonly hemisphere = new THREE.HemisphereLight(0xd6e8ff, 0x5a6a42, 1.7)
  private readonly sky = new Sky()
  private readonly sunDir: THREE.Vector3
  private readonly renderer: THREE.WebGLRenderer
  quality: Quality = 'high'

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    // Afternoon sun from the south-west, as on a typical summer race day in Norway.
    const elevation = THREE.MathUtils.degToRad(38)
    const azimuth = THREE.MathUtils.degToRad(215)
    const sunDir = new THREE.Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      -Math.cos(elevation) * Math.cos(azimuth),
    )

    this.sky.scale.setScalar(SKY_SCALE)
    const u = this.sky.material.uniforms
    u['turbidity']!.value = 4
    u['rayleigh']!.value = 1.2
    u['mieCoefficient']!.value = 0.004
    u['mieDirectionalG']!.value = 0.8
    u['sunPosition']!.value.copy(sunDir)
    scene.add(this.sky)

    this.sunDir = sunDir
    this.sun.position.copy(sunDir).multiplyScalar(1000)
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -SHADOW_EXTENT
    cam.right = cam.top = SHADOW_EXTENT
    cam.near = 1
    cam.far = 800
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.06
    scene.add(this.sun, this.sun.target, this.hemisphere)
    renderer.shadowMap.type = THREE.PCFShadowMap
    this.setQuality(this.quality)

    scene.fog = new THREE.Fog(FOG_COLOR, 400, 6000)
    scene.background = FOG_COLOR
  }

  /** Unit vector towards the sun. */
  get sunDirection(): THREE.Vector3 {
    return this.sunDir.clone()
  }

  setQuality(quality: Quality) {
    this.quality = quality
    const size = SHADOW_SIZE[quality]
    // Switching shadows on or off changes the lights, so three recompiles every lit material
    // on the next render.
    this.renderer.shadowMap.enabled = size > 0
    this.sun.castShadow = size > 0
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
  }

  /** Keep the sky and the shadowed area centred on the camera. */
  update(camera: THREE.Camera) {
    this.sky.position.copy(camera.position)
    // Snap the shadow camera to whole shadow texels to avoid shimmering edges.
    const texel = (2 * SHADOW_EXTENT) / Math.max(this.sun.shadow.mapSize.x, 1)
    const target = camera.position.clone()
    target.x = Math.round(target.x / texel) * texel
    target.z = Math.round(target.z / texel) * texel
    this.sun.target.position.copy(target)
    this.sun.position.copy(target).addScaledVector(this.sunDir, 400)
    this.sun.target.updateMatrixWorld()
  }
}
