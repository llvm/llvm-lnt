import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { readNdjson } from './ndjson'

const encoder = new TextEncoder()

/** A body made of `parts`, each a read of its own, ending normally or, with `cut`, failing. */
function bodyOf(parts: (string | Uint8Array)[], { cut = false } = {}) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part)
      }
      if (cut) controller.error(new TypeError('terminated'))
      else controller.close()
    },
  })
}

const signal = () => new AbortController().signal

describe('readNdjson', () => {
  it('parses every line, whichever reads they span', async () => {
    const body = bodyOf(['{"a":1}\n{"a"', ':2}\n', '{"a":3}\n'])

    expect(await readNdjson(body, signal())).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('decodes a character split between two reads', async () => {
    const bytes = encoder.encode('{"test":"é"}\n')
    const split = bytes.indexOf(0xc3) + 1

    const lines = await readNdjson(bodyOf([bytes.slice(0, split), bytes.slice(split)]), signal())

    expect(lines).toEqual([{ test: 'é' }])
  })

  it('reads an empty or missing body as no lines', async () => {
    expect(await readNdjson(bodyOf([]), signal())).toEqual([])
    expect(await readNdjson(null, signal())).toEqual([])
    expect(await readNdjson(undefined, signal())).toEqual([])
  })

  it('reports a body cut short as a failure with no response, which may be retried', async () => {
    const failed = readNdjson(bodyOf(['{"a":1}\n'], { cut: true }), signal())
    await expect(failed).rejects.toBeInstanceOf(ApiError)
    await expect(failed).rejects.toMatchObject({ status: 0, code: null })

    // A body that ends in the middle of a line did not end where the server meant it to (I2).
    await expect(readNdjson(bodyOf(['{"a":1}\n{"a"']), signal())).rejects.toMatchObject({
      status: 0,
    })
  })

  it('stops reading once aborted, even if the body never ends, with the reason', async () => {
    const controller = new AbortController()
    let cancelled: unknown
    const endless = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode('{"a":1}\n'))
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    const reading = readNdjson(endless, controller.signal)

    const reason = new DOMException('Deselected', 'AbortError')
    controller.abort(reason)

    await expect(reading).rejects.toBe(reason)
    expect(cancelled).toBe(reason)
  })

  it('reads nothing once already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(readNdjson(bodyOf(['{"a":1}\n']), controller.signal)).rejects.toBe(
      controller.signal.reason,
    )
  })
})
