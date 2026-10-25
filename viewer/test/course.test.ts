import { describe, expect, it, vi } from 'vitest'
import { formatPace } from '../src/course'

// course.ts loads the UI texts, which pick a language from the page's URL.
vi.hoisted(() => vi.stubGlobal('location', { search: '' }))

describe('pace', () => {
  it('shows minutes per kilometre', () => {
    expect(formatPace(3.2)).toBe('5:13')
    expect(formatPace(1000 / 240)).toBe('4:00')
    expect(formatPace(0.5)).toBe('33:20')
  })

  it('shows a dash when standing still', () => {
    expect(formatPace(0)).toBe('–:––')
    expect(formatPace(0.1)).toBe('–:––')
  })
})
