/**
 * Takes a screenshot of a page of a running LNT v5 web UI.
 *
 *     node tools/screenshot.ts <path> [--out FILE] [--url BASE] [--width W] [--height H]
 *                              [--full-page] [--wait-for SELECTOR] [--token TOKEN]
 *
 * `<path>` is the page's path and query, e.g. `/suites/libcxx?tab=machines`. `--url` defaults to
 * the Vite dev server, http://localhost:5173, which `npm run dev` starts. The page is captured once
 * the network has been idle for a moment, and, with `--wait-for`, once SELECTOR is visible. Errors
 * the page reports are printed, so that a blank screenshot comes with its reason. `--token` is not
 * supported yet (see below).
 */

import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: path.join(tmpdir(), 'lnt-screenshot.png') },
    url: { type: 'string', default: 'http://localhost:5173' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    'full-page': { type: 'boolean', default: false },
    'wait-for': { type: 'string' },
    token: { type: 'string' },
  },
})

function fail(message: string): never {
  console.error(`screenshot: ${message}`)
  process.exit(1)
}

if (positionals.length !== 1) fail('expected exactly one page path, e.g. /suites/libcxx')
// The hook for pages that need a token. The client does not keep one anywhere yet; once it keeps it
// in localStorage, import the key it uses from the client and store the token under it, before the
// page loads: `context.addInitScript(([key, token]) => localStorage.setItem(key, token), [...])`.
if (values.token !== undefined) fail('--token is not supported yet: the client keeps no token')

const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    viewport: { width: Number(values.width), height: Number(values.height) },
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`console error: ${message.text()}`)
  })

  const target = new URL(positionals[0], values.url).href
  const response = await page.goto(target, { waitUntil: 'networkidle' })
  if (response && !response.ok()) console.error(`HTTP ${response.status()} for ${target}`)
  if (values['wait-for']) await page.locator(values['wait-for']).first().waitFor()

  await page.screenshot({ path: values.out, fullPage: values['full-page'] })
  console.log(values.out)
} catch (error) {
  console.error(`screenshot: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
