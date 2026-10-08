import { describe, expect, it, vi } from 'vitest'
import { changeInAnotherTab } from '../test/auth'
import { TOKEN_STORAGE_KEY } from './storage-key'
import { TokenStore } from './token-store'

describe('TokenStore', () => {
  it('starts with the token persisted by an earlier visit', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'persisted')

    expect(new TokenStore().get().token).toBe('persisted')
  })

  it('persists the token it is given, without any whitespace', () => {
    const tokens = new TokenStore()

    tokens.set('  ab\nc\td \n')
    expect(tokens.get().token).toBe('abcd')
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('abcd')
  })

  it('forgets the token when cleared, or given only whitespace', () => {
    const tokens = new TokenStore()
    tokens.set('abc')

    tokens.set(null)
    expect(tokens.get().token).toBeNull()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()

    tokens.set('abc')
    tokens.set('   ')
    expect(tokens.get().token).toBeNull()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('counts every change as a new generation, even to the same token', () => {
    const tokens = new TokenStore()
    const listener = vi.fn()
    tokens.subscribe(listener)

    tokens.set('abc')
    const first = tokens.get()
    tokens.set('abc')
    const second = tokens.get()
    tokens.recheck()
    const third = tokens.get()

    expect([first.token, second.token, third.token]).toEqual(['abc', 'abc', 'abc'])
    expect(new Set([first.generation, second.generation, third.generation]).size).toBe(3)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('takes up a token another tab stores or clears', () => {
    const tokens = new TokenStore()
    const listener = vi.fn()
    tokens.subscribe(listener)

    changeInAnotherTab(TOKEN_STORAGE_KEY, 'from-elsewhere')
    expect(tokens.get().token).toBe('from-elsewhere')

    changeInAnotherTab(TOKEN_STORAGE_KEY, null)
    expect(tokens.get().token).toBeNull()

    tokens.set('abc')
    changeInAnotherTab(null, null)
    expect(tokens.get().token).toBeNull()
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('ignores the changes another tab makes to anything else', () => {
    const tokens = new TokenStore()
    tokens.set('abc')
    const listener = vi.fn()
    tokens.subscribe(listener)

    changeInAnotherTab('something-else', 'value')
    expect(tokens.get().token).toBe('abc')
    expect(listener).not.toHaveBeenCalled()
  })
})
