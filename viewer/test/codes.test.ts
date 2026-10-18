import { describe, expect, it } from 'vitest'
import { decode, location, symbolId } from '../src/descriptions/codes'

describe('OCAD description codes', () => {
  it('splits references and directions', () => {
    expect(decode('1.009')).toEqual({ ref: '1.9', group: 1, minor: 9 })
    expect(decode('5.011')).toEqual({ ref: '5.11', group: 5, minor: 11 })
    expect(decode('12.105')).toEqual({ ref: '12.1', group: 12, minor: 1, direction: 'NW' })
    expect(decode('12.122')).toEqual({ ref: '12.12', group: 12, minor: 12, direction: 'W' })
    expect(decode('0.206')).toEqual({ ref: '0.2', group: 0, minor: 2, direction: 'SW' })
    expect(decode('2.5')).toBeNull()
    expect(decode(undefined)).toBeNull()
  })

  // The Lang course of trlop_260521.ocd as printed by OCAD (trlop_260521-lang.pdf).
  it.each([
    ['126', { d: '2.004', g: '12.105' }, { d: '2.4', g: '11.1NW' }],
    ['135', { d: '2.001' }, { d: '2.1' }],
    ['136', { c: '0.206', d: '1.003' }, { c: '0.2SW', d: '1.3' }],
    ['137', { d: '1.010', g: '12.102' }, { d: '1.10', g: '11.1W' }],
    ['128', { c: '0.103', d: '2.004', g: '12.101' }, { c: '0.1S', d: '2.4', g: '11.1N' }],
    ['133', { c: '0.104', d: '1.010', g: '12.103' }, { c: '0.1E', d: '1.10', g: '11.1S' }],
    ['142', { d: '1.009', g: '12.122' }, { d: '1.9', g: '11.14W' }],
    ['125', { d: '5.002', e: '5.002', f: '10.002' }, { d: '5.2', e: '5.2', f: '10.2' }],
  ])('draws control %s as printed', (_code, description: Record<string, string>, expected) => {
    const single = !description.e
    const ids = Object.fromEntries(Object.keys(expected).map(c => [c, symbolId(c, description[c], single)]))
    expect(ids).toEqual(expected)
  })

  it('reads the location of the flag', () => {
    expect(location('12.105')).toEqual({ location: 'side', direction: 'NW' })
    expect(location('12.122')).toEqual({ location: 'foot', direction: 'W' })
    expect(location('12.010')).toEqual({ location: 'top' })
    expect(location('2.004')).toBeNull()
  })
})
