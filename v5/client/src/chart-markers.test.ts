import { describe, expect, it } from 'vitest'
import { markerOf } from './chart-markers'

describe('markerOf', () => {
  it('gives each trace its own marker, starting over once all are taken', () => {
    expect(markerOf(0).symbol).toBe('circle')
    expect(markerOf(1)).toEqual({ symbol: 'triangle-up', char: '▲' })
    expect(markerOf(8)).toBe(markerOf(0))
  })
})
