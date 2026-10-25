import * as THREE from 'three'
import { type Gfx, vegShader } from './gfx'

// Materials of standing grain (grain.ts): the cards near the player and the surface
// farther out. Gfx makes them; this module must not import the ground layers, which
// would import gfx.ts again before it is ready.

/** Seeded random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Paint a card of grain stalks with nodding, awned ears; the bottom of the canvas is the ground. */
export function paintGrainCard(): HTMLCanvasElement {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const c = cv.getContext('2d')!
  const R = rng(412)
  const rgb = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`
  // A few leaves low down, drying from the tip.
  for (let i = 0; i < 14; i++) {
    const x0 = 20 + R() * (S - 40)
    const lean = (R() - 0.5) * 120
    const top = S * (0.45 + R() * 0.3)
    c.fillStyle = rgb(150 + R() * 40, 140 + R() * 30, 70 + R() * 20)
    c.beginPath()
    c.moveTo(x0 - 2, S)
    c.quadraticCurveTo(x0 + lean * 0.3, S * 0.8, x0 + lean, top)
    c.quadraticCurveTo(x0 + lean * 0.3 + 2, S * 0.8, x0 + 2, S)
    c.fill()
  }
  for (let i = 0; i < 46; i++) {
    const x0 = 12 + R() * (S - 24)
    const lean = (R() - 0.5) * 30
    // Grain stands even: the ears reach 8-22 % below the top of the card.
    const y1 = S * (0.08 + R() * 0.14)
    const x1 = x0 + lean
    const straw = 0.85 + R() * 0.3
    c.strokeStyle = rgb(196 * straw, 165 * straw, 92 * straw)
    c.lineWidth = 1.6
    c.beginPath()
    c.moveTo(x0, S)
    c.quadraticCurveTo(x0 + lean * 0.2, S * 0.5, x1, y1)
    c.stroke()
    // The ear nods to one side: two rows of kernels, each with an awn standing up.
    const nod = (R() < 0.5 ? -1 : 1) * (0.25 + R() * 0.5)
    const len = 18 + R() * 8
    const ex = x1 + Math.sin(nod) * len
    const ey = y1 - Math.cos(nod) * len * 0.6
    const along = Math.atan2(ey - y1, ex - x1)
    const ear = 0.85 + R() * 0.3
    for (let k = 0; k < 10; k++) {
      const t = k / 9
      const side = k % 2 ? 1 : -1
      const kx = x1 + (ex - x1) * t - Math.sin(along) * side * 1.4
      const ky = y1 + (ey - y1) * t + Math.cos(along) * side * 1.4
      c.strokeStyle = rgb(232 * ear, 204 * ear, 128 * ear)
      c.lineWidth = 0.9
      c.beginPath()
      c.moveTo(kx, ky)
      c.lineTo(kx + Math.sin(nod) * 10 + side * 3 + (R() - 0.5) * 5, ky - 20 - R() * 12)
      c.stroke()
      c.save()
      c.translate(kx, ky)
      c.rotate(along + side * 0.5)
      c.fillStyle = rgb(205 * ear, 165 * ear, 82 * ear)
      c.strokeStyle = rgb(150 * ear, 112 * ear, 50 * ear)
      c.lineWidth = 0.6
      c.beginPath()
      c.ellipse(0, 0, 3.4, 1.9, 0, 0, Math.PI * 2)
      c.fill()
      c.stroke()
      c.restore()
    }
  }
  return cv
}

/** Material for the grain cards: they sway, and dissolve with the other ground cover. */
export function grainCardMaterial(gfx: Gfx, map: THREE.Texture): THREE.MeshLambertMaterial {
  return vegShader(
    new THREE.MeshLambertMaterial({
      map,
      vertexColors: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      alphaToCoverage: gfx.multisampled,
    }),
    { wind: 0.1, fade: { range: gfx.coverFade, dir: 'out' }, keepAlpha: true },
  )
}

const SURFACE_VERTEX = /* glsl */ `
attribute vec2 aGrain;
uniform float uTime;
varying vec3 vGrainPos;
varying vec2 vGrain;
`
// The same travelling wave as the sway of the cards (gfx.ts vegShader).
const WAVE = /* glsl */ `
float grainWave(vec2 p, float t) {
  float ph = dot(p, vec2(0.131, 0.173));
  float gust = 0.6 + 0.4 * sin(t * 0.31 + p.x * 0.011);
  return (sin(t * 1.07 + ph) + 0.45 * sin(t * 2.31 + ph * 1.7)) * gust;
}
`
const SURFACE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uFade;
varying vec3 vGrainPos;
varying vec2 vGrain;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
}
float vegDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
${WAVE}
`
const SURFACE_COLOR = /* glsl */ `
  float dist = distance(vGrainPos, cameraPosition);
  // The cards stand near the player; the surface takes over farther out.
  if (smoothstep(uFade.x, uFade.y, dist) < vegDither(gl_FragCoord.xy)) discard;
  vec2 gp = vGrainPos.xz;
  // Each scale of detail fades out before it would flicker: single ears up close, tufts
  // and the shadows between them farther out.
  float detail = 1.0 - smoothstep(15.0, 70.0, dist);
  float mid = 1.0 - smoothstep(60.0, 450.0, dist);
  float ears = mix(0.5, gNoise(gp * 9.0) * 0.6 + gNoise(gp * 23.0) * 0.4, detail);
  float tufts = mix(0.5, gNoise(gp * 1.4 + 3.0) * 0.6 + gNoise(gp * 3.3) * 0.4, mid);
  vec3 ripe = pow(vec3(0.76, 0.60, 0.31), vec3(2.2));
  vec3 pale = pow(vec3(0.90, 0.79, 0.50), vec3(2.2));
  vec3 col = mix(ripe, pale, ears * 0.55 + tufts * 0.45);
  col *= 0.72 + 0.4 * tufts;
  // Patches that ripen later, greener and darker.
  col = mix(col, pow(vec3(0.62, 0.60, 0.33), vec3(2.2)), smoothstep(0.55, 0.85, gNoise(gp * 0.045 + 13.0)) * 0.45);
  col *= 0.85 + 0.3 * gNoise(gp * 0.2 + 5.0);
  // Gusts bend the ears and show their paler sides.
  col *= 1.0 + 0.11 * grainWave(gp, uTime);
  if (vGrain.x > 0.5) {
    // The side of a field: stalks, darker towards the ground.
    float along = vGrainPos.x * 0.7 + vGrainPos.z * 0.7;
    float stalks = mix(0.5, gNoise(vec2(along * 14.0, vGrain.y * 3.0)), detail);
    col *= mix(0.32, 1.0, pow(vGrain.y, 0.8)) * (0.8 + 0.4 * stalks);
  }
  diffuseColor.rgb = col;
`

/** The material of the grain surface; `fade` is the distance range where it appears. */
export function grainSurfaceMaterial(gfx: Gfx, fade: { value: THREE.Vector2 }): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
  material.onBeforeCompile = shader => {
    shader.uniforms['uTime'] = gfx.time
    shader.uniforms['uFade'] = fade
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SURFACE_VERTEX}\n${WAVE}`)
      .replace(
        '#include <begin_vertex>',
        // The ears rise and fall a little with the wave; the foot of the walls stays.
        `#include <begin_vertex>
        vGrain = aGrain;
        vec3 grainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        transformed.y += 0.04 * grainWave(grainWorld.xz, uTime) * aGrain.y;
        vGrainPos = grainWorld;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_FRAGMENT}`)
      .replace('#include <map_fragment>', SURFACE_COLOR)
  }
  material.customProgramCacheKey = () => 'terraino-grain'
  return material
}
