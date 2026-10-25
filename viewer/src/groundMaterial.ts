import * as THREE from 'three'
import { GROUND_TEX_GLSL } from './gfx'

// Ground classes (must match terraino.process.symbols.Ground).
const GLSL = /* glsl */ `
uniform sampler2D layerMap;
uniform vec2 layerOrigin;
uniform float layerStep;
uniform vec2 layerSize;
uniform float canopyUnit;
uniform vec2 canopyFade;
varying vec3 vGroundPos;
varying vec3 vGroundNormal;
${GROUND_TEX_GLSL}
float gNoise(vec2 p) { return gtNoise(p); }
float gFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gtNoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}

vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }

// Ground texture of a class. uv: position / 3.2 m; n1..n3 as below. Grain is drawn
// on top near the player (grain.ts), so its ground differs with the layer's step.
vec3 groundColor(int cls, vec2 uv, float n1, float n2, float n3) {
  if (cls == 2) return gtx(GT_GRASS, uv); // open land
  if (cls == 3) { // rough open: heather, long grass, clear-cut
    return mix(gtx(GT_GRASS, uv) * vec3(1.08, 1.0, 0.82), gtx(GT_FOREST, uv), 0.35 + 0.3 * n2);
  }
  if (cls == 4) return gtx(GT_MARSH, uv);
  if (cls == 5) return mix(gtx(GT_GRAVEL, uv), gtx(GT_ROCK, uv * 0.5), 0.7); // bare rock
  if (cls == 6) return mix(gtx(GT_GRASS, uv) * vec3(1.05, 1.05, 0.85), gtx(GT_FIELD, uv), 0.25); // ley and verges
  if (cls == 7) return gtx(GT_ASPHALT, uv);
  if (cls == 8 || cls == 14) return gtx(GT_GRAVEL, uv * 2.4);
  if (cls == 9) return gtx(GT_SOIL, uv);
  if (cls == 10) return gtx(GT_MARSH, uv) * 0.6; // lake bed
  if (cls == 11) return gtx(GT_GRASS, uv) * vec3(0.88, 0.95, 0.8); // lawn
  if (cls == 12) { // stony ground
    return mix(gtx(GT_FOREST, uv), gtx(GT_GRAVEL, uv * 0.8), smoothstep(0.35, 0.65, n1 * 0.6 + n2 * 0.4));
  }
  if (cls == 13) return gtx(GT_SOIL, uv) * vec3(1.5, 1.4, 1.2); // sand
  if (cls == 15) { // grain
    // Near, where the grain stands on the ground: soil and old stubble between the stalks.
    // Far (the coarse layers), the colour of the ripe ears seen from above.
    if (layerStep < 1.5) return mix(gtx(GT_SOIL, uv), gtx(GT_FIELD, uv), 0.4) * 0.7;
    return gtx(GT_FIELD, uv) * vec3(1.3, 1.12, 0.72) * (0.9 + 0.2 * n3);
  }
  // Forest floor: moss, blueberry, needles.
  return gtx(GT_FOREST, uv);
}

// Ground class, the low four bits of red.
int layerClass(vec4 t) { return int(t.r * 255.0 + 0.5) & 15; }
// Undergrowth level, the high four bits of red.
float shrubLevel(vec4 t) { return floor(t.r * 255.0 / 16.0 + 0.01); }
`

const MAIN = /* glsl */ `
  vec2 gp = vGroundPos.xz;
  float n1 = gFbm(gp * 1.7);
  float n2 = gFbm(gp * 0.35 + 31.0);
  float n3 = gFbm(gp * 0.06 + 71.0);

  vec2 f = (gp - layerOrigin) / layerStep;
  vec2 b = floor(f);
  vec2 w = f - b;
  // Wobbly class borders look natural instead of following the 1 m grid.
  w = clamp(w + (vec2(n1, gFbm(gp * 1.7 + 9.0)) - 0.5) * 0.9, 0.0, 1.0);
  w = smoothstep(0.25, 0.75, w);
  ivec2 i0 = ivec2(b);
  ivec2 maxI = ivec2(layerSize) - 1;
  vec4 t00 = texelFetch(layerMap, clamp(i0, ivec2(0), maxI), 0);
  vec4 t10 = texelFetch(layerMap, clamp(i0 + ivec2(1, 0), ivec2(0), maxI), 0);
  vec4 t01 = texelFetch(layerMap, clamp(i0 + ivec2(0, 1), ivec2(0), maxI), 0);
  vec4 t11 = texelFetch(layerMap, clamp(i0 + ivec2(1, 1), ivec2(0), maxI), 0);

  vec2 uv = gp / 3.2;
  int k00 = layerClass(t00);
  int k10 = layerClass(t10);
  int k01 = layerClass(t01);
  int k11 = layerClass(t11);
  // Most pixels have one class at all four corners; texture it once.
  vec3 c00 = groundColor(k00, uv, n1, n2, n3);
  vec3 c10 = k10 == k00 ? c00 : groundColor(k10, uv, n1, n2, n3);
  vec3 c01 = k01 == k00 ? c00 : k01 == k10 ? c10 : groundColor(k01, uv, n1, n2, n3);
  vec3 c11 = k11 == k00 ? c00 : k11 == k10 ? c10 : k11 == k01 ? c01 : groundColor(k11, uv, n1, n2, n3);
  vec3 groundCol = mix(mix(c00, c10, w.x), mix(c01, c11, w.x), w.y);

  // Water reflects the sky, more so at grazing angles; small ripples break it up.
  float water = mix(
    mix(float(layerClass(t00) == 10), float(layerClass(t10) == 10), w.x),
    mix(float(layerClass(t01) == 10), float(layerClass(t11) == 10), w.x),
    w.y);
  if (water > 0.0) {
    vec3 viewDir = normalize(cameraPosition - vGroundPos);
    vec2 ripple = (vec2(gNoise(gp * 3.0), gNoise(gp * 3.0 + 5.0)) - 0.5) * 0.08;
    vec3 n = normalize(vec3(ripple.x, 1.0, ripple.y));
    float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(viewDir, n), 0.0), 5.0);
    vec3 sky = mix(lin(vec3(0.62, 0.74, 0.86)), lin(vec3(0.36, 0.52, 0.72)), clamp(viewDir.y * 3.0, 0.0, 1.0));
    groundCol = mix(groundCol, lin(vec3(0.06, 0.11, 0.12)), water);
    totalEmissiveRadiance += sky * fresnel * water * 0.9;
  }

  float canopy = mix(mix(t00.g, t10.g, w.x), mix(t01.g, t11.g, w.x), w.y) * 255.0 * canopyUnit;
  groundCol *= mix(1.0, 0.8, smoothstep(2.0, 12.0, canopy));
  // Undergrowth: greener, lusher floor.
  float shrubs = mix(mix(shrubLevel(t00), shrubLevel(t10), w.x), mix(shrubLevel(t01), shrubLevel(t11), w.x), w.y);
  groundCol = mix(groundCol, groundCol * vec3(0.85, 1.05, 0.75), smoothstep(3.0, 9.0, shrubs) * 0.5);
  // Steep ground shows bare rock.
  float steep = 1.0 - smoothstep(0.66, 0.84, normalize(vGroundNormal).y);
  groundCol = mix(groundCol, gtx(GT_ROCK, uv * 0.6) * 0.95, steep * 0.85);
  // Large-scale variation.
  groundCol *= (0.82 + 0.36 * gtNoise(gp * 0.017)) * (0.9 + 0.2 * gtNoise(gp * 0.11 + 3.0));

  // Beyond the distance where trees are drawn, paint the forest canopy instead.
  float dist = length(vGroundPos - cameraPosition);
  float far = smoothstep(canopyFade.x, canopyFade.y, dist) * smoothstep(2.0, 6.0, canopy);
  vec3 canopyCol = mix(lin(vec3(0.13, 0.20, 0.10)), lin(vec3(0.19, 0.27, 0.12)), n3);
  groundCol = mix(groundCol, canopyCol, far);

  diffuseColor.rgb = groundCol;
`

export interface GroundLayerSource {
  texture: THREE.Texture
  origin: [number, number]
  step: number
  size: [number, number]
}

/** Configure a texture holding encoded layer data (exact values, no filtering). */
export function asLayerTexture(texture: THREE.Texture): THREE.Texture {
  texture.flipY = false
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return texture
}

/** A terrain material that paints the ground from layer data. */
export function createGroundMaterial(
  source: GroundLayerSource,
  canopyUnit: number,
  canopyFade: [number, number],
  groundTex: THREE.Texture,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial()
  const uniforms = {
    layerMap: { value: source.texture },
    layerOrigin: { value: new THREE.Vector2(...source.origin) },
    layerStep: { value: source.step },
    layerSize: { value: new THREE.Vector2(...source.size) },
    canopyUnit: { value: canopyUnit },
    canopyFade: { value: new THREE.Vector2(...canopyFade) },
    groundTex: { value: groundTex },
  }
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;\nvarying vec3 vGroundNormal;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' +
          'vGroundNormal = normalize(mat3(modelMatrix) * objectNormal);',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <map_fragment>', MAIN)
  }
  // All ground materials share one program; only the uniforms differ.
  material.customProgramCacheKey = () => 'terraino-ground-v2'
  return material
}
