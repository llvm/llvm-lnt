/**
 * The `localStorage` key the client keeps the API token under. It has a module of its own, with no
 * imports, so that the tools and the end-to-end tests can store a token there before a page loads
 * (tools/screenshot.ts, e2e/fixtures.ts) without a second copy of it.
 */
export const TOKEN_STORAGE_KEY = 'lnt-v5-token'
