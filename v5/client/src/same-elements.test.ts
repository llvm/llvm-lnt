import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSameElements } from './same-elements'

describe('useSameElements', () => {
  it('keeps the array it had while a new one holds the same elements', () => {
    const first = ['a', 'b']
    const { result, rerender } = renderHook(({ array }) => useSameElements(array), {
      initialProps: { array: first as string[] | undefined },
    })
    expect(result.current).toBe(first)
    rerender({ array: ['a', 'b'] })
    expect(result.current).toBe(first)

    const other = ['a', 'c']
    rerender({ array: other })
    expect(result.current).toBe(other)
    rerender({ array: ['a', 'c', 'd'] })
    expect(result.current).toEqual(['a', 'c', 'd'])
  })

  it('passes undefined through, and an array that follows it', () => {
    const { result, rerender } = renderHook(({ array }) => useSameElements(array), {
      initialProps: { array: undefined as string[] | undefined },
    })
    expect(result.current).toBeUndefined()
    const array = ['a']
    rerender({ array })
    expect(result.current).toBe(array)
    rerender({ array: undefined })
    expect(result.current).toBeUndefined()
  })
})
