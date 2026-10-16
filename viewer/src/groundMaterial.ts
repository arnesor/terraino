import * as THREE from 'three'

// Ground classes (must match otest.process.symbols.Ground).
const GLSL = /* glsl */ `
uniform sampler2D layerMap;
uniform vec2 layerOrigin;
uniform float layerStep;
uniform vec2 layerSize;
uniform float canopyUnit;
uniform vec2 canopyFade;
varying vec3 vGroundPos;

float gHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float gNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = gHash(i);
  float b = gHash(i + vec2(1.0, 0.0));
  float c = gHash(i + vec2(0.0, 1.0));
  float d = gHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float gFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gNoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}

vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }

// n1: fine detail (decimetres), n2: patches (metres), n3: large variation.
vec3 groundColor(int cls, vec2 p, float n1, float n2, float n3) {
  if (cls == 2) { // open land: grass
    return mix(lin(vec3(0.40, 0.50, 0.21)), lin(vec3(0.55, 0.57, 0.29)), n2) * (0.8 + 0.4 * n1);
  }
  if (cls == 3) { // rough open: heather, long grass, clear-cut
    vec3 heather = mix(lin(vec3(0.38, 0.33, 0.22)), lin(vec3(0.45, 0.36, 0.30)), n1);
    vec3 grass = lin(vec3(0.50, 0.48, 0.28));
    return mix(heather, grass, smoothstep(0.35, 0.65, n2)) * (0.85 + 0.3 * n3);
  }
  if (cls == 4) { // marsh
    vec3 moss = mix(lin(vec3(0.55, 0.52, 0.30)), lin(vec3(0.62, 0.50, 0.32)), n2);
    vec3 wet = lin(vec3(0.24, 0.27, 0.18));
    return mix(moss, wet, smoothstep(0.55, 0.75, n1 * 0.5 + n2 * 0.5));
  }
  if (cls == 5) { // bare rock with lichen
    vec3 rock = mix(lin(vec3(0.42, 0.42, 0.40)), lin(vec3(0.56, 0.56, 0.52)), n1);
    return mix(rock, lin(vec3(0.62, 0.64, 0.55)), smoothstep(0.6, 0.8, n2) * 0.6);
  }
  if (cls == 6) { // cultivated field with rows
    float rows = 0.5 + 0.5 * sin(p.x * 2.4 + n3 * 6.0);
    return mix(lin(vec3(0.50, 0.56, 0.25)), lin(vec3(0.60, 0.62, 0.32)), rows * 0.5 + n2 * 0.5);
  }
  if (cls == 7) { // paved
    return lin(vec3(0.22, 0.22, 0.23)) * (0.9 + 0.2 * n1);
  }
  if (cls == 8) { // gravel road
    return mix(lin(vec3(0.46, 0.42, 0.34)), lin(vec3(0.56, 0.51, 0.42)), n1);
  }
  if (cls == 9) { // dirt path
    return mix(lin(vec3(0.36, 0.29, 0.20)), lin(vec3(0.46, 0.38, 0.27)), n1);
  }
  if (cls == 10) { // water
    return lin(vec3(0.10, 0.17, 0.21)) * (0.9 + 0.2 * n3);
  }
  if (cls == 11) { // lawn and gardens
    return mix(lin(vec3(0.33, 0.50, 0.18)), lin(vec3(0.42, 0.56, 0.22)), n2) * (0.9 + 0.2 * n1);
  }
  if (cls == 12) { // stony ground
    vec3 stones = mix(lin(vec3(0.40, 0.40, 0.36)), lin(vec3(0.55, 0.54, 0.50)), n1);
    return mix(lin(vec3(0.30, 0.33, 0.18)), stones, smoothstep(0.4, 0.6, n1 * 0.7 + n2 * 0.3));
  }
  if (cls == 13) { // sand
    return mix(lin(vec3(0.66, 0.60, 0.45)), lin(vec3(0.74, 0.68, 0.52)), n1);
  }
  if (cls == 14) { // under buildings
    return lin(vec3(0.33, 0.31, 0.29));
  }
  // forest floor: moss, blueberry, needles
  vec3 moss = mix(lin(vec3(0.24, 0.31, 0.13)), lin(vec3(0.32, 0.38, 0.16)), n1);
  vec3 needles = lin(vec3(0.33, 0.27, 0.17));
  vec3 berry = lin(vec3(0.20, 0.27, 0.14));
  vec3 c = mix(moss, needles, smoothstep(0.45, 0.7, n2));
  return mix(c, berry, smoothstep(0.55, 0.75, n3) * 0.6);
}

int layerClass(vec4 t) { return int(t.r * 255.0 + 0.5); }
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

  vec3 c00 = groundColor(layerClass(t00), gp, n1, n2, n3);
  vec3 c10 = groundColor(layerClass(t10), gp, n1, n2, n3);
  vec3 c01 = groundColor(layerClass(t01), gp, n1, n2, n3);
  vec3 c11 = groundColor(layerClass(t11), gp, n1, n2, n3);
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
  groundCol *= mix(1.0, 0.85, smoothstep(2.0, 12.0, canopy));

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
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial()
  const uniforms = {
    layerMap: { value: source.texture },
    layerOrigin: { value: new THREE.Vector2(...source.origin) },
    layerStep: { value: source.step },
    layerSize: { value: new THREE.Vector2(...source.size) },
    canopyUnit: { value: canopyUnit },
    canopyFade: { value: new THREE.Vector2(...canopyFade) },
  }
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <map_fragment>', MAIN)
  }
  // All ground materials share one program; only the uniforms differ.
  material.customProgramCacheKey = () => 'otest-ground'
  return material
}
