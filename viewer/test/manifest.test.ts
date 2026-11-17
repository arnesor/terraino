import { describe, expect, it } from 'vitest'
import { type Manifest, upgradeManifest } from '../src/world'

describe('manifests of older formats', () => {
  it('get a core area and an orienteering map', () => {
    const area: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 0]]
    const old = { format: 8, mapArea: area, map: { image: 'map.jpg', size: [10, 10], scale: 10000 } }
    const manifest = upgradeManifest(old as unknown as Manifest)
    expect(manifest.coreArea).toEqual(area)
    expect(manifest.map.kind).toBe('orienteering')
    expect(manifest.map.scale).toBe(10000)
    expect('mapArea' in manifest).toBe(false)
  })

  it('of the current format are kept as they are', () => {
    const current = { format: 9, coreArea: [], map: { kind: 'topographic' } } as unknown as Manifest
    expect(upgradeManifest(current)).toBe(current)
  })
})
