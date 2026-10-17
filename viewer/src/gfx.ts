import * as THREE from 'three'
import { type Models, OModels, type TreeModel } from './vendor/models.js'
import { type GroundKind, OTex, type Textures } from './vendor/textures.js'

// Shared graphics: procedural textures and models (from the vendored Orienteering 3D
// code), vegetation materials with wind and distance dissolve, and tree impostors.

export type Quality = 'high' | 'medium' | 'low'

/** Distances that depend on the quality setting. */
export interface QualitySettings {
  /** Trees nearer than this are full models; farther ones impostors. */
  near: number
  /** Ground cover cards (blueberry, grass …) are drawn this far. */
  cover: number
  /** Cover cards per square metre where cover is densest. */
  coverDensity: number
}

export const QUALITY: Record<Quality, QualitySettings> = {
  high: { near: 110, cover: 40, coverDensity: 1.8 },
  medium: { near: 85, cover: 32, coverDensity: 1.4 },
  low: { near: 60, cover: 22, coverDensity: 1.0 },
}

/** Tree model variants; trees of a species pick one. */
export const VARIANTS = [
  { species: 'spruce', model: 0 }, // grown in the open: branches to the ground
  { species: 'spruce', model: 1 }, // in a stand: lower third bare
  { species: 'spruce', model: 2 }, // dense mature stand: lower half bare
  { species: 'pine', model: 0 },
  { species: 'pine', model: 1 },
  { species: 'birch', model: 0 },
  { species: 'birch', model: 1 },
] as const
export type TreeSpecies = (typeof VARIANTS)[number]['species']

/** Crown radius of each variant's model at height 1. */
export const MODEL_CROWN = [0.2, 0.15, 0.115, 0.19, 0.19, 0.2, 0.2]

// Ground texture layers, in the order of the texture array.
export const GROUND_LAYERS: GroundKind[] = ['forest', 'grass', 'soil', 'gravel', 'rock', 'marsh', 'field', 'asphalt']

const IMPOSTOR_W = 256
const IMPOSTOR_H = 512
// The impostor camera sees x in ±IMPOSTOR_HALF_W and y from -0.02 to 1.02 of the tree.
export const IMPOSTOR_HALF_W = 0.26

interface FadeOptions {
  /** Sway at the top of a unit-height model. */
  wind: number
  /** Leaf flutter along the normal. */
  flutter?: number
  /** Dissolve between these distances: 'out' hides beyond, 'in' hides nearer. */
  fade?: { range: { value: THREE.Vector2 }; dir: 'out' | 'in' }
  /** Alpha-tested foliage: keep its coverage when the texture is minified. */
  keepAlpha?: boolean
}

const time = { value: 0 }

/**
 * Add wind sway and a dithered distance dissolve to an instanced vegetation material.
 * Models are built at unit height, so the sway grows with the square of the height.
 */
export function vegShader<M extends THREE.Material>(material: M, o: FadeOptions): M {
  const isDepth = (material as unknown as THREE.MeshDepthMaterial).isMeshDepthMaterial === true
  const key = `veg-${o.wind}-${o.flutter ?? 0}-${o.fade?.dir ?? ''}-${o.keepAlpha ? 'a' : ''}-${isDepth ? 'd' : ''}`
  material.onBeforeCompile = shader => {
    shader.uniforms['uTime'] = time
    if (o.fade) shader.uniforms['uFade'] = o.fade.range
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vInstD;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 ipos = vec3(0.0);
        #ifdef USE_INSTANCING
          ipos = instanceMatrix[3].xyz;
        #endif
        float ph = dot(ipos.xz, vec2(0.131, 0.173));
        float hgt = max(position.y, 0.0);
        float gust = 0.6 + 0.4 * sin(uTime * 0.31 + ipos.x * 0.011);
        float sway = (sin(uTime * 1.07 + ph) + 0.45 * sin(uTime * 2.31 + ph * 1.7)) * ${o.wind.toFixed(4)} * gust * hgt * hgt;
        transformed.x += sway;
        transformed.z += sway * 0.55;
        ${
          o.flutter && !isDepth
            ? `transformed += objectNormal * sin(uTime * 6.0 + ph * 3.0 + position.x * 37.0 + position.z * 29.0) * ${o.flutter.toFixed(4)} * hgt;`
            : ''
        }
        vInstD = distance(ipos.xz, cameraPosition.xz);`,
      )
    const test = o.fade
      ? o.fade.dir === 'out'
        ? 'if (smoothstep(uFade.x, uFade.y, vInstD) > vegDither(gl_FragCoord.xy)) discard;'
        : 'if (smoothstep(uFade.x, uFade.y, vInstD) < vegDither(gl_FragCoord.xy)) discard;'
      : ''
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vInstD;
        ${o.fade ? 'uniform vec2 uFade;' : ''}
        float vegDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`,
      )
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${test}`)
    if (o.keepAlpha) {
      // Sparse cards average to a low alpha in the small mipmaps and would vanish with
      // distance; raise the alpha with the mipmap level so the crown keeps its body.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        #ifdef USE_MAP
        {
          vec2 texel = vMapUv * vec2(textureSize(map, 0));
          vec2 d1 = dFdx(texel);
          vec2 d2 = dFdy(texel);
          float lod = 0.5 * log2(max(max(dot(d1, d1), dot(d2, d2)), 1e-8));
          diffuseColor.a *= 1.0 + max(lod, 0.0) * 0.28;
        }
        #endif`,
      )
    }
    if (!isDepth) {
      // Leaves and blades are lit alike from both sides: the back face keeps the
      // normal, which points away from the plant's centre, instead of flipping it.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\nnormal = normalize(vNormal);\nnonPerturbedNormal = normal;',
      )
    }
  }
  material.customProgramCacheKey = () => key
  return material
}

export interface SpeciesMaterials {
  bark: THREE.MeshLambertMaterial
  leaf: THREE.MeshLambertMaterial
  depth: THREE.MeshDepthMaterial
}

/** Everything that is painted or built once and shared. */
export class Gfx {
  readonly textures: Textures
  readonly models: Models
  /** All ground textures in one array, layers in GROUND_LAYERS order. */
  readonly groundArray: THREE.DataArrayTexture
  readonly time = time
  /** Near trees dissolve out and impostors in over this distance range. */
  readonly treeFade = { value: new THREE.Vector2(96, 110) }
  readonly coverFade = { value: new THREE.Vector2(30, 40) }
  readonly bushFade = { value: new THREE.Vector2(80, 95) }
  readonly species: Record<TreeSpecies, SpeciesMaterials>
  readonly bush: THREE.MeshLambertMaterial
  readonly bushDepth: THREE.MeshDepthMaterial
  readonly logBark: THREE.MeshLambertMaterial
  impostorAtlas: THREE.Texture | null = null
  readonly multisampled: boolean

  constructor(renderer: THREE.WebGLRenderer) {
    this.textures = OTex.build(THREE, renderer)
    this.models = OModels.build(THREE)
    this.groundArray = buildGroundArray(this.textures)
    this.multisampled = renderer.getContext().getContextAttributes()?.antialias === true
    const a2c = this.multisampled
    const t = this.textures
    const bark = (map: THREE.Texture) =>
      vegShader(new THREE.MeshLambertMaterial({ map, vertexColors: true }), {
        wind: 0.004,
        fade: { range: this.treeFade, dir: 'out' },
      })
    const leaf = (map: THREE.Texture, flutter: number) =>
      vegShader(
        new THREE.MeshLambertMaterial({
          map,
          vertexColors: true,
          alphaTest: 0.45,
          side: THREE.DoubleSide,
          alphaToCoverage: a2c,
        }),
        { wind: 0.012, flutter, fade: { range: this.treeFade, dir: 'out' }, keepAlpha: true },
      )
    const depth = (map: THREE.Texture) =>
      vegShader(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.45 }), {
        wind: 0.012,
        keepAlpha: true,
      })
    this.species = {
      spruce: { bark: bark(t.bark.spruce), leaf: leaf(t.foliage.spruce, 0.002), depth: depth(t.foliage.spruce) },
      pine: { bark: bark(t.bark.pine), leaf: leaf(t.foliage.pine, 0.003), depth: depth(t.foliage.pine) },
      birch: { bark: bark(t.bark.birch), leaf: leaf(t.foliage.birch, 0.006), depth: depth(t.foliage.birch) },
    }
    this.bush = vegShader(
      new THREE.MeshLambertMaterial({
        map: t.foliage.bush,
        vertexColors: true,
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        alphaToCoverage: a2c,
      }),
      { wind: 0.05, flutter: 0.01, fade: { range: this.bushFade, dir: 'out' }, keepAlpha: true },
    )
    this.bushDepth = vegShader(
      new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t.foliage.bush, alphaTest: 0.45 }),
      { wind: 0.05 },
    )
    this.logBark = new THREE.MeshLambertMaterial({ map: t.bark.spruce, vertexColors: true })
  }

  setQuality(q: QualitySettings) {
    this.treeFade.value.set(q.near - 14, q.near)
    this.coverFade.value.set(q.cover - 10, q.cover)
    this.bushFade.value.set(q.near - 22, q.near - 8)
  }

  /** Model of a tree variant. */
  treeModel(variant: number): TreeModel {
    const v = VARIANTS[variant]!
    return this.models[v.species][v.model]!
  }

  /** Cover card material for one kind of plant. */
  coverMaterial(map: THREE.Texture): THREE.MeshLambertMaterial {
    return vegShader(
      new THREE.MeshLambertMaterial({
        map,
        vertexColors: true,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        alphaToCoverage: this.multisampled,
      }),
      { wind: 0.08, fade: { range: this.coverFade, dir: 'out' } },
    )
  }

  /**
   * Render every tree variant once, from the side, into one texture with a slot per
   * variant. Distant trees are drawn as camera-facing quads with these pictures.
   */
  buildImpostors(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): THREE.Texture {
    const slots = VARIANTS.length
    const target = new THREE.WebGLRenderTarget(IMPOSTOR_W * 8, IMPOSTOR_H, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    })
    const scene = new THREE.Scene()
    // Lit from the front and a little from the sun's side, so the pictures match the
    // near trees reasonably from all directions.
    const light = new THREE.DirectionalLight(0xfff1dc, 2.6)
    light.position.set(sunDir.x * 0.4, 0.7, 1)
    scene.add(light, new THREE.HemisphereLight(0xd6e8ff, 0x5a6a42, 1.6))
    const camera = new THREE.OrthographicCamera(-IMPOSTOR_HALF_W, IMPOSTOR_HALF_W, 1.02, -0.02, -2, 2)
    camera.position.set(0, 0, 1)
    camera.lookAt(0, 0, 0)

    const saved = this.treeFade.value.clone()
    this.treeFade.value.set(1e6, 1e6 + 1)
    const previousTarget = renderer.getRenderTarget()
    const previousColor = renderer.getClearColor(new THREE.Color())
    const previousAlpha = renderer.getClearAlpha()
    const previousShadows = renderer.shadowMap.enabled
    renderer.shadowMap.enabled = false
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    for (let v = 0; v < slots; v++) {
      const model = this.treeModel(v)
      const mats = this.species[VARIANTS[v]!.species]
      const group = new THREE.Group()
      group.add(new THREE.Mesh(model.trunk, mats.bark), new THREE.Mesh(model.foliage, mats.leaf))
      scene.add(group)
      target.viewport.set(v * IMPOSTOR_W, 0, IMPOSTOR_W, IMPOSTOR_H)
      target.scissor.set(v * IMPOSTOR_W, 0, IMPOSTOR_W, IMPOSTOR_H)
      target.scissorTest = true
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      scene.remove(group)
    }
    target.scissorTest = false
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousColor, previousAlpha)
    renderer.shadowMap.enabled = previousShadows
    this.treeFade.value.copy(saved)
    this.impostorAtlas = target.texture
    return target.texture
  }

  /** Impostor material: camera-facing quads showing a slot of the atlas. */
  impostorMaterial(): THREE.ShaderMaterial {
    if (!this.impostorAtlas) throw new Error('buildImpostors first')
    const material = new THREE.ShaderMaterial({
      fog: true,
      alphaToCoverage: this.multisampled,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { tMap: { value: null }, uLight: { value: 0.8 }, uTallOnly: { value: new THREE.Vector2(650, 8) } },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aSlot;
        uniform vec2 uFade;
        uniform vec2 uTallOnly;
        varying vec2 vUv;
        varying vec3 vTint;
        varying float vD;
        void main() {
          vec3 c = instanceMatrix[3].xyz;
          float hgt = length(instanceMatrix[1].xyz);
          float wid = length(instanceMatrix[0].xyz) * ${(2 * IMPOSTOR_HALF_W).toFixed(3)};
          float flip = instanceMatrix[0][0] < 0.0 ? -1.0 : 1.0;
          vD = distance(c.xz, cameraPosition.xz);
          // Hidden where the full models stand, and far away only the tall trees.
          if (vD < uFade.x - 1.0 || (vD > uTallOnly.x && hgt < uTallOnly.y)) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          vec3 to = cameraPosition - c;
          to.y = 0.0;
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(to + vec3(1e-4))));
          vec3 wp = c + right * position.x * wid + vec3(0.0, position.y * hgt, 0.0);
          float u = flip > 0.0 ? uv.x : 1.0 - uv.x;
          vUv = vec2((aSlot + u) / 8.0, uv.y);
          vTint = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vTint = instanceColor;
          #endif
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform sampler2D tMap;
        uniform vec2 uFade;
        uniform float uLight;
        varying vec2 vUv;
        varying vec3 vTint;
        varying float vD;
        float vegDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
        void main() {
          if (smoothstep(uFade.x, uFade.y, vD) < vegDither(gl_FragCoord.xy)) discard;
          vec4 t = texture2D(tMap, vUv);
          // Sparse foliage averages to a low alpha in the small mipmaps; keep it.
          if (t.a < 0.22) discard;
          gl_FragColor = vec4(t.rgb / max(t.a, 0.001) * vTint * uLight, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    })
    material.uniforms['tMap']!.value = this.impostorAtlas
    material.uniforms['uFade'] = this.treeFade
    return material
  }
}

/** Stack the tileable ground canvases into one texture array. */
function buildGroundArray(textures: Textures): THREE.DataArrayTexture {
  const first = textures.canvases[GROUND_LAYERS[0]!]
  const w = first.width
  const h = first.height
  const data = new Uint8Array(w * h * 4 * GROUND_LAYERS.length)
  GROUND_LAYERS.forEach((kind, i) => {
    const pixels = textures.canvases[kind].getContext('2d')!.getImageData(0, 0, w, h).data
    data.set(pixels, i * w * h * 4)
  })
  const array = new THREE.DataArrayTexture(data, w, h, GROUND_LAYERS.length)
  array.wrapS = array.wrapT = THREE.RepeatWrapping
  array.magFilter = THREE.LinearFilter
  array.minFilter = THREE.LinearMipmapLinearFilter
  array.generateMipmaps = true
  array.anisotropy = 8
  array.colorSpace = THREE.SRGBColorSpace
  array.needsUpdate = true
  return array
}

// Texture layer numbers in GLSL, and a sampler that hides the tiling.
export const GROUND_TEX_GLSL = /* glsl */ `
uniform sampler2DArray groundTex;
#define GT_FOREST 0.0
#define GT_GRASS 1.0
#define GT_SOIL 2.0
#define GT_GRAVEL 3.0
#define GT_ROCK 4.0
#define GT_MARSH 5.0
#define GT_FIELD 6.0
#define GT_ASPHALT 7.0
float gtHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gtNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gtHash(i), gtHash(i + vec2(1, 0)), f.x), mix(gtHash(i + vec2(0, 1)), gtHash(i + vec2(1, 1)), f.x), f.y);
}
// p: world position / 3.2 m. Two differently scaled and turned samples, blended by noise.
vec3 gtx(float layer, vec2 p) {
  vec3 a = texture(groundTex, vec3(p, layer)).rgb;
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p * 0.43 + 0.37;
  vec3 b = texture(groundTex, vec3(q, layer)).rgb;
  return mix(a, b, smoothstep(0.3, 0.7, gtNoise(p * 0.35)));
}
`

/**
 * Rock material: the rock texture projected from three sides (no seams on any shape),
 * with moss and lichen on the upward faces when `moss` is set.
 */
export function rockMaterial(gfx: Gfx, moss: boolean): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })
  material.onBeforeCompile = shader => {
    shader.uniforms['groundTex'] = { value: gfx.groundArray }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 rockPos = vec4(transformed, 1.0);
        vec3 rockNormal = objectNormal;
        #ifdef USE_INSTANCING
          rockPos = instanceMatrix * rockPos;
          rockNormal = mat3(instanceMatrix) * rockNormal;
        #endif
        vRockPos = (modelMatrix * rockPos).xyz;
        vRockNormal = normalize(mat3(modelMatrix) * rockNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockNormal;\n${GROUND_TEX_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `vec3 bw = pow(abs(vRockNormal), vec3(4.0));
        bw /= bw.x + bw.y + bw.z;
        vec3 rc = texture(groundTex, vec3(vRockPos.yz * 0.35, GT_ROCK)).rgb * bw.x
          + texture(groundTex, vec3(vRockPos.xz * 0.35, GT_ROCK)).rgb * bw.y
          + texture(groundTex, vec3(vRockPos.xy * 0.35, GT_ROCK)).rgb * bw.z;
        rc *= 0.95 + 0.4 * gtNoise(vRockPos.xz * 0.5);
        // Mute the texture's lichen spots, which repeat on large faces: pull it towards
        // its average colour (the smallest mipmap), most on steep faces.
        float steep = 1.0 - abs(vRockNormal.y);
        vec3 average = textureLod(groundTex, vec3(0.5, 0.5, GT_ROCK), 9.0).rgb;
        rc = mix(rc, average * (0.95 + 0.4 * gtNoise(vRockPos.xz * 0.5)), 0.2 + 0.25 * steep);
        // Steep rock: vertical weathering streaks.
        // Projected from the two level axes, like the texture (stable on curved faces).
        vec2 side = bw.xz / max(bw.x + bw.z, 1e-4);
        float streak = (gtNoise(vec2(vRockPos.z * 0.9, vRockPos.y * 0.15)) * 0.7 + gtNoise(vec2(vRockPos.z * 2.6, vRockPos.y * 0.4)) * 0.3) * side.x
          + (gtNoise(vec2(vRockPos.x * 0.9, vRockPos.y * 0.15)) * 0.7 + gtNoise(vec2(vRockPos.x * 2.6, vRockPos.y * 0.4)) * 0.3) * side.y;
        rc *= mix(1.0, 0.5 + 0.75 * streak, steep);
        ${
          moss
            ? `float m = smoothstep(0.55, 0.9, vRockNormal.y + (gtNoise(vRockPos.xz * 1.3) - 0.5) * 0.5);
        rc = mix(rc, pow(vec3(0.36, 0.42, 0.2), vec3(2.2)) * (0.75 + 0.5 * gtNoise(vRockPos.xz * 4.0)), m * 0.6);`
            : ''
        }
        diffuseColor.rgb *= rc;`,
      )
  }
  material.customProgramCacheKey = () => `otest-rock${moss ? '-moss' : ''}`
  return material
}
