import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { NO_CREDENTIALS, setCredentials } from './api/client'
import { server } from './test/server'

// MSW's own 'error' strategy only logs an unhandled request and fails it as a network error, which
// the code under test may well handle -- as an `ApiError(0, ...)` -- so that the test passes for the
// wrong reason. Recording them is what lets one fail the test itself.
const unhandled: string[] = []

beforeAll(() =>
  server.listen({
    onUnhandledRequest(request, print) {
      unhandled.push(`${request.method} ${request.url}`)
      // Fail the request too, rather than let it through to whatever listens on that port.
      print.error()
    },
  }),
)
afterEach(() => {
  cleanup()
  server.resetHandlers()
  // What the test's token store left behind: the token, and the API client's use of it.
  localStorage.clear()
  setCredentials(NO_CREDENTIALS)
  const requests = unhandled.splice(0)
  if (requests.length > 0) {
    throw new Error(`Requests no mock handler matched:\n${requests.join('\n')}`)
  }
})
afterAll(() => server.close())
