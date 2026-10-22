import { ApiError } from './client'

/** What a response cut short at the transport level (I2) is reported as, which may be retried. */
const CUT_SHORT = 'The connection to the server was lost before all the data arrived.'

/**
 * Every line of a response of newline-delimited JSON (I2), parsed, once the whole body has
 * arrived. The lines are parsed as the body arrives, so that it is never held whole as text.
 *
 * A missing body is an empty response. A body that fails or ends in the middle of a line was cut
 * short, which is reported as a failure with no response (status 0), as the API client reports a
 * request that got none: it may succeed if sent again.
 *
 * Reading stops once `signal` is aborted, with the signal's reason, even if the body itself does
 * not follow the signal. The reader is read in a loop rather than by iterating over the stream,
 * which not every browser supports.
 */
export async function readNdjson<T>(
  body: ReadableStream<Uint8Array> | null | undefined,
  signal: AbortSignal,
): Promise<T[]> {
  signal.throwIfAborted()
  const lines: T[] = []
  if (!body) return lines
  const reader = body.getReader()
  // Cancelling the reader settles the read in progress, as done.
  const cancel = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let partial = ''
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        signal.throwIfAborted()
        throw new ApiError(0, null, CUT_SHORT)
      }
      signal.throwIfAborted()
      if (chunk.done) break
      const text = partial + decoder.decode(chunk.value, { stream: true })
      const end = text.lastIndexOf('\n')
      partial = text.slice(end + 1)
      if (end >= 0) for (const line of text.slice(0, end).split('\n')) lines.push(JSON.parse(line))
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  if (partial + decoder.decode() !== '') throw new ApiError(0, null, CUT_SHORT)
  return lines
}
