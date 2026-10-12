import { describe, expect, it } from 'vitest'
import { RequestSlots } from './request-slots'

/** A request that settles when told to, and records whether it was sent. */
function held() {
  const request = { sent: false, resolve: () => {}, reject: (() => {}) as (error: Error) => void }
  const send = () =>
    new Promise<void>((resolve, reject) => {
      request.sent = true
      request.resolve = resolve
      request.reject = reject
    })
  return { request, send }
}

const signal = () => new AbortController().signal

/** Once every promise settled so far has run its callbacks. */
const settled = () => new Promise((resolve) => setTimeout(resolve))

describe('RequestSlots', () => {
  it('sends as many requests at once as it has slots, and the next once one settles', async () => {
    const slots = new RequestSlots(2)
    const [a, b, c] = [held(), held(), held()]
    const done = [a, b, c].map(({ send }) => slots.run(signal(), send))
    await settled()
    expect([a, b, c].map(({ request }) => request.sent)).toEqual([true, true, false])

    a.request.resolve()
    await done[0]
    await settled()
    expect(c.request.sent).toBe(true)
  })

  it('frees the slot of a request that fails', async () => {
    const slots = new RequestSlots(1)
    const [a, b] = [held(), held()]
    const failed = slots.run(signal(), a.send)
    void slots.run(signal(), b.send)
    await settled()

    a.request.reject(new Error('The request failed.'))
    await expect(failed).rejects.toThrow('The request failed.')
    await settled()
    expect(b.request.sent).toBe(true)
  })

  it('gives up waiting once aborted, and leaves its place to the next request', async () => {
    const slots = new RequestSlots(1)
    const [a, b, c] = [held(), held(), held()]
    const abort = new AbortController()
    void slots.run(signal(), a.send)
    const given = slots.run(abort.signal, b.send)
    void slots.run(signal(), c.send)

    abort.abort(new Error('Not wanted any more.'))
    await expect(given).rejects.toThrow('Not wanted any more.')
    a.request.resolve()
    await settled()
    expect(b.request.sent).toBe(false)
    expect(c.request.sent).toBe(true)
  })

  it('sends nothing for a request aborted before it asks', async () => {
    const slots = new RequestSlots(1)
    const abort = new AbortController()
    abort.abort(new Error('Not wanted any more.'))
    const { request, send } = held()

    await expect(slots.run(abort.signal, send)).rejects.toThrow('Not wanted any more.')
    expect(request.sent).toBe(false)
  })
})
