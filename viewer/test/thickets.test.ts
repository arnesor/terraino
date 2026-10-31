import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { IMPOSTOR_HALF_W } from '../src/gfx'
import { deciduousThicket, spruceThicket, THICKET_CROWN } from '../src/thickets'
import { OModels } from '../src/vendor/models.js'

const models = OModels.build(THREE)

describe.each([
  ['spruce', spruceThicket(models)],
  ['deciduous', deciduousThicket(models)],
])('%s thicket model', (_, thicket) => {
  const box = new THREE.Box3().setFromBufferAttribute(
    thicket.foliage.getAttribute('position') as THREE.BufferAttribute,
  )

  it('stands at unit height and fits the impostor picture', () => {
    expect(box.min.y).toBeLessThan(0.08)
    expect(box.max.y).toBeGreaterThan(0.85)
    expect(box.max.y).toBeLessThan(1.02)
    for (const v of [box.min.x, box.max.x, box.min.z, box.max.z]) {
      expect(Math.abs(v)).toBeLessThan(IMPOSTOR_HALF_W)
    }
    expect(Math.max(box.max.x, box.max.z, -box.min.x, -box.min.z)).toBeGreaterThan(THICKET_CROWN * 0.8)
  })

  it('has foliage all the way up', () => {
    // Foliage in every tenth of the height up to 0.8: no bare stems to look between.
    const pos = thicket.foliage.getAttribute('position')
    const layers = new Set<number>()
    for (let i = 0; i < pos.count; i++) layers.add(Math.floor(pos.getY(i) * 10))
    for (let k = 0; k < 8; k++) expect(layers.has(k)).toBe(true)
  })
})
