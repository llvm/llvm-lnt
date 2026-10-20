import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSameElements, useSameElementsEach } from './same-elements'

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

describe('useSameElementsEach', () => {
  it('keeps each array it had, and the list of them, while they hold the same elements', () => {
    const first = [['a'], undefined, ['b']]
    const { result, rerender } = renderHook(({ arrays }) => useSameElementsEach(arrays), {
      initialProps: { arrays: first as (string[] | undefined)[] },
    })
    expect(result.current).toBe(first)
    rerender({ arrays: [['a'], undefined, ['b']] })
    expect(result.current).toBe(first)

    const changed = ['c']
    rerender({ arrays: [['a'], changed, ['b']] })
    expect(result.current).not.toBe(first)
    expect(result.current[0]).toBe(first[0])
    expect(result.current[1]).toBe(changed)
    expect(result.current[2]).toBe(first[2])

    rerender({ arrays: [['b']] })
    expect(result.current).toEqual([['b']])
  })
})
