/**
 * The Compare page (CP1-CP7), against the seeded libcxx history: the real machines measured every
 * synthetic commit, three samples per test and run.
 */

import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { EXPERIMENT, HARDENED, LINUX, PROFILED_TEST, UNTRACKED } from '../tools/synthetic.ts'
import { cardOf } from './cards.ts'
import { expect, json, profiledRun, test } from './fixtures.ts'
import { ownSuite } from './own-suite.ts'
import { pickOption, pickSuggestion } from './select.ts'
import { plotOf, pointOf, type PlotDiv } from './plot.ts'
import { column, rows, table } from './tables.ts'

type Schemas = components['schemas']

/** The controls of `side`, whose fields are named without it: "Suite", "Machine", "Commit". */
function sideOf(page: Page, side: 'A' | 'B') {
  return page.getByRole('region', { name: new RegExp(`^Side ${side} `) })
}

/** The CSS `position` of `cell`, which is `sticky` for a cell kept in view (CP2 "Width"). */
const positionOf = (cell: Locator) =>
  cell.evaluate((element) => getComputedStyle(element).position)

/**
 * The tests of the rows of `comparison` highlighted (CP5): those whose background differs from the
 * geomean's, which is never highlighted.
 */
function highlightedRows(comparison: Locator) {
  return rows(comparison).evaluateAll((all) => {
    const background = (row: Element) => getComputedStyle(row).backgroundColor
    const usual = background(all[0])
    return all.filter((row) => background(row) !== usual).map((row) => row.children[1].textContent)
  })
}

/** Whether what is drawn at each of `points`, in the page's viewport, is part of `element`. */
function drawsAt(element: Locator, points: { x: number; y: number }[]) {
  return element.evaluate(
    (root, points) =>
      points.map(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        return hit !== null && root.contains(hit)
      }),
    points,
  )
}

/**
 * How far the page has scrolled, and for the open list of suggestions, how far it can scroll and
 * how far it is from its end, or null while none is open. What scrolls the list is the listbox or a
 * box holding it, the nearest of them whose overflow is `auto` or `scroll`. Self-contained, to run
 * in the page.
 */
function scrollState() {
  let box = document.querySelector('[role="listbox"]')
  while (box && !['auto', 'scroll'].includes(getComputedStyle(box).overflowY)) {
    box = box.parentElement
  }
  if (!box) return { page: window.scrollY, list: null }
  const max = box.scrollHeight - box.clientHeight
  return { page: window.scrollY, list: { max, toEnd: max - box.scrollTop } }
}

/** The two newest commits `machine` has runs at, by ordinal: the older first. */
async function newestCommits(request: APIRequestContext, machine = LINUX) {
  const path = `/api/suites/libcxx/commits?machine=${machine}&sort=-ordinal&limit=2`
  const { items } = await json<Schemas['CommitCursorPage']>(request, path)
  return [items[1], items[0]]
}

test('compares the runs of two commits the URL names', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )

  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')
  expect(await rows(comparison).count()).toBeGreaterThan(10)
  // Every test has a value on both sides, so each has a status other than N/A. Status is the
  // column after the checkboxes and the six others.
  const statuses = await column(comparison, 7)
  const comparable = ['Improved', 'Regressed', 'Noise', 'Unchanged']
  expect(statuses.slice(1).every((status) => comparable.includes(status))).toBe(true)
  await expect(page.getByRole('list', { name: 'Summary' })).toContainText('Only in A 0')
  // A bar per compared test.
  const drawn = () =>
    plotOf(page).evaluate((element) => (element as PlotDiv)._fullData?.[0]?.y.length ?? 0)
  await expect.poll(drawn).toBe((await rows(comparison).count()) - 1)
  // The columns fit, so none sticks: sticky cells by the thousand are slow to scroll past.
  const box = comparison.locator('xpath=..')
  expect(await box.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const cells = rows(comparison).nth(1).locator('td')
  expect(await positionOf(cells.nth(0))).toBe('static')
  expect(await positionOf(cells.nth(1))).toBe('static')
})

test("links each side's commit to its page, with its card, and the changes from A to B (CP1)", async ({
  page,
  request,
}) => {
  const [older, newer] = await newestCommits(request)
  // Side A newer than side B: the changes are still from A to B.
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${newer.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${older.value}`,
  )

  const github = 'https://github.com/llvm/llvm-project'
  const commitLink = (side: 'A' | 'B') => sideOf(page, side).getByRole('link', { name: /^Commit / })
  await expect(commitLink('A')).toHaveAttribute('href', `/suites/libcxx/commits/${newer.value}`)
  await expect(commitLink('B')).toHaveAttribute('href', `/suites/libcxx/commits/${older.value}`)
  const changes = page.getByRole('main').getByRole('link', { name: /^Diff on GitHub: / })
  await expect(changes).toHaveAttribute('href', `${github}/compare/${newer.value}...${older.value}`)
  await expect(changes).toHaveAttribute('target', '_blank')

  // The commit's card (AR21), on the link to its page.
  await commitLink('B').hover()
  await expect(await cardOf(page, commitLink('B'))).toContainText(older.value)
  await commitLink('B').click()
  await expect(page).toHaveURL(`/suites/libcxx/commits/${older.value}`)
})

test('highlights the row of the bar hovered on the chart (CP5)', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )
  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')

  await plotOf(page).hover({ position: await pointOf(page, 0, 0) })
  const label = page.locator('.hoverlayer .hovertext')
  await expect(label).toBeVisible()
  const highlighted = () => highlightedRows(comparison)
  await expect.poll(highlighted).toHaveLength(1)
  await expect(label).toContainText((await highlighted())[0]!)
})

test("shows a bar's details, linking to the test's history on the Graph page (CP3)", async ({
  page,
  request,
}) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )
  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')

  const position = await pointOf(page, 0, 0)
  const label = page.locator('.hoverlayer .hovertext')
  const comparison = table(page, 'Comparison')
  await plotOf(page).hover({ position })
  await expect(label).toContainText('Click for details')
  await expect.poll(() => highlightedRows(comparison)).toHaveLength(1)
  await plotOf(page).click({ position })
  const details = page.getByRole('dialog')
  await expect(details).toBeFocused()
  // The details take the place of Plotly's label, and its row is no longer highlighted (CP5).
  await expect(label).toHaveCount(0)
  await expect.poll(() => highlightedRows(comparison)).toEqual([])
  const test = (await details.getAttribute('aria-label'))!

  // Each side's run, three samples of the test on one line.
  for (const side of ['A', 'B']) {
    const runs = details.getByRole('table', { name: `Side ${side} runs` })
    await expect(runs.getByRole('link')).toHaveCount(1)
    const samples = runs.getByRole('cell').last()
    await expect(samples).toHaveText(/^[^·]+ · [^·]+ · [^·]+$/)
    const lines = await samples.evaluate((cell) => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      return range.getClientRects().length
    })
    expect(lines).toBe(1)
  }
  const valueB = await details.getByRole('definition').nth(1).textContent()

  // Side B selects its commit's every run: the Graph's point at its commit is Value B. The link
  // highlights both sides' commits, on the same machine, once known to have an ordinal (CP3).
  const graphLink = details.getByRole('link', { name: 'View on graph' })
  await expect(graphLink).toHaveAttribute('href', /&highlight=/)
  await graphLink.click()
  await expect(page).toHaveURL(/\/graph\?/)
  expect([...new URL(page.url()).searchParams]).toEqual([
    ['suite', 'libcxx'],
    ['machine', LINUX],
    ['metric', 'execution_time'],
    ['test', test],
    ['highlight', older.value],
    ['highlight', newer.value],
  ])
  await expect(table(page, 'Tests').getByRole('checkbox', { name: test, exact: true })).toBeChecked()
  const pointAtB = () =>
    plotOf(page).evaluate((element, commit) => {
      type Drawn = PlotDiv & { _fullData: { customdata: string[][] }[] }
      const trace = (element as Drawn)._fullData?.[0]
      const index = trace?.x.indexOf(commit) ?? -1
      return index < 0 ? null : trace!.customdata[index][1]
    }, newer.value)
  await expect.poll(pointAtB).toBe(valueB)
})

test('scrolls the table rather than the page when its columns do not fit', async ({
  page,
  request,
}) => {
  // Both sides have profiles, so that the Profile column is shown.
  const [, newest] = await newestCommits(request)
  const statistics = ['samples', 'mean', 'median', 'min', 'max', 'stddev', 'cv', 'pvalue']
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${newest.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${EXPERIMENT}&metric=execution_time` +
      statistics.map((key) => `&columns=${key}`).join(''),
  )
  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')
  // The Profile column's header is visually hidden, absolutely positioned, which the box must clip
  // as well for the page not to scroll: the check below covers that only while it is shown.
  await expect(comparison.getByRole('columnheader', { name: 'Profile' })).toHaveCount(1)
  const box = comparison.locator('xpath=..')
  expect(await box.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  expect(
    await page.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement
      return scrollWidth <= clientWidth
    }),
  ).toBe(true)

  const row = rows(comparison).nth(1)
  const cells = row.locator('td')
  const [check, name] = [cells.nth(0), cells.nth(1)]
  const status = row.getByText(/^(Improved|Regressed|Noise|Unchanged)$/)
  // The tests' names are not squeezed to make room for the other columns.
  expect((await name.boundingBox())!.width).toBeGreaterThanOrEqual(200)

  // The row in view, from the page's scrolling: scrolling the cell into view could scroll the box.
  await row.evaluate((element) =>
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 100),
  )
  await expect(status).not.toBeInViewport()
  await box.evaluate((element) => (element.scrollLeft = element.scrollWidth))
  await expect(status).toBeInViewport()
  // The checkbox and the name stay in view, over the columns scrolled under them: they stick once
  // the page has found that the columns do not fit.
  await expect.poll(() => positionOf(check)).toBe('sticky')
  await expect.poll(() => positionOf(name)).toBe('sticky')
  const onTop = (cell: Locator) =>
    cell.evaluate((element) => {
      const { left, top, width, height } = element.getBoundingClientRect()
      const hit = document.elementFromPoint(left + width / 2, top + height / 2)
      return hit !== null && element.contains(hit)
    })
  expect(await onTop(check)).toBe(true)
  expect(await onTop(name)).toBe(true)
  // With no gap between them, which the columns scrolled under them would show through.
  const [checkBox, nameBox] = [(await check.boundingBox())!, (await name.boundingBox())!]
  expect(nameBox.x - (checkBox.x + checkBox.width)).toBeCloseTo(0, 0)
})

test("shows a bar's details over the table's sticky columns (CP2, CP3)", async ({
  page,
  request,
}) => {
  // Side B's two runs make the details tall enough to reach the table.
  const [, newest] = await newestCommits(request)
  const statistics = ['samples', 'mean', 'median', 'min', 'max', 'stddev', 'cv', 'pvalue']
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${newest.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${EXPERIMENT}&metric=execution_time` +
      statistics.map((key) => `&columns=${key}`).join(''),
  )
  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')
  const name = comparison.getByRole('columnheader', { name: 'Test', exact: true })
  await expect.poll(() => positionOf(name)).toBe('sticky')

  // The first bar's details, on its right, reach down over the table's header.
  await plotOf(page).click({ position: await pointOf(page, 0, 0) })
  const details = page.getByRole('dialog')
  const link = details.getByRole('link', { name: 'View on graph' })
  await link.scrollIntoViewIfNeeded()
  const [box, header, linkBox] = [
    (await details.boundingBox())!,
    (await name.boundingBox())!,
    (await link.boundingBox())!,
  ]
  expect(box.x < header.x + header.width && header.x < box.x + box.width).toBe(true)
  expect(box.y < header.y + header.height && header.y < box.y + box.height).toBe(true)

  // Nothing of the table is drawn over them.
  const inset = 4
  const points = [
    { x: box.x + inset, y: box.y + box.height - inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
    { x: Math.max(box.x, header.x) + inset, y: header.y + header.height / 2 },
    { x: linkBox.x + linkBox.width / 2, y: linkBox.y + linkBox.height / 2 },
  ]
  expect(await drawsAt(details, points)).toEqual(points.map(() => true))
})

test('compares two commits chosen from scratch', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto('/compare')

  for (const [side, commit] of [
    ['A', older],
    ['B', newer],
  ] as const) {
    const controls = sideOf(page, side)
    await pickOption(controls, 'Suite', 'libcxx')
    await pickSuggestion(controls, 'Machine', LINUX)
    // The commit is searched by its commit string, and suggested by its display value.
    await pickSuggestion(controls, 'Commit', commit.value, String(commit.fields.svn_revision))
  }
  await pickOption(page, 'Metric', 'Execution Time')

  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')
  await expect(page).toHaveURL(new RegExp(`commit_a=${older.value}.*commit_b=${newer.value}`))
})

test("gives a long machine name its side's width, runs listed or not (CP1)", async ({
  page,
  request,
}) => {
  const [, commit] = await newestCommits(request, HARDENED)
  await page.goto(`/compare?suite_a=libcxx&machine_a=${HARDENED}`)
  const controls = sideOf(page, 'A')
  const machine = controls.getByRole('combobox', { name: 'Machine' })
  // Measured once the side shows what the URL names, and no longer its placeholders.
  await expect(controls.getByRole('button', { name: 'libcxx Suite' })).toBeVisible()
  await expect(machine).toHaveValue(HARDENED)
  const width = () => machine.evaluate((element) => element.clientWidth)
  const before = await width()

  // The whole name shows: the combobox takes the side's width, rather than that of its text.
  expect(await machine.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(before)

  // Nor does it widen with the runs once they are listed.
  await pickSuggestion(controls, 'Commit', commit.value, String(commit.fields.svn_revision))
  await expect(controls.getByRole('checkbox', { name: 'Select all runs' })).toBeVisible()
  expect(await width()).toBe(before)
})

test('offers the untracked machines last, under their heading (AR18)', async ({ page }) => {
  await page.goto('/compare?suite_a=libcxx')
  const machine = sideOf(page, 'A').getByRole('combobox', { name: 'Machine' })

  await machine.fill('macos-26.5-arm64')

  const untracked = page.getByRole('group', { name: 'Untracked' })
  await expect(untracked.getByRole('option')).toHaveText([UNTRACKED])
  // After every tracked machine matching the text.
  await expect(page.getByRole('option').last()).toHaveText(UNTRACKED)
  await expect(page.getByRole('option').first()).not.toHaveText(UNTRACKED)
})

test("stops scrolling a combobox's list at its end, leaving it open (AR14)", async ({
  page,
  request,
}) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )
  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')
  // The page could scroll, which would close the list.
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true)

  // Every machine of the suite, more than the list shows at once.
  await sideOf(page, 'B').getByRole('button', { name: 'Show suggestions Machine' }).click()
  await page.getByRole('listbox').hover()
  await page.mouse.wheel(0, 10_000)
  await expect
    .poll(async () => {
      const { list } = await page.evaluate(scrollState)
      return list !== null && list.max > 0 && list.toEnd < 1
    })
    .toBe(true)

  // Past its end, then back up a little. Wheel events are handled in order, so once the list has
  // scrolled up, the wheel past its end has been handled. Only that it scrolled up is checked, as
  // on macOS the list then bounces back to its end.
  const seen = await page.evaluateHandle(() => {
    const state = { scrolledUp: false }
    const onScroll = ({ target: box }: Event) => {
      const list = document.querySelector('[role="listbox"]')
      if (!(box instanceof Element) || !box.contains(list)) return
      const toEnd = box.scrollHeight - box.clientHeight - box.scrollTop
      if (toEnd >= 1) state.scrolledUp = true
    }
    addEventListener('scroll', onScroll, { capture: true })
    return state
  })
  await page.mouse.wheel(0, 1000)
  await page.mouse.wheel(0, -100)
  await expect
    .poll(async () => {
      const { page: scrollY, list } = await page.evaluate(scrollState)
      return { open: list !== null, scrollY, scrolledUp: await seen.evaluate((s) => s.scrolledUp) }
    })
    .toEqual({ open: true, scrollY: 0, scrolledUp: true })
})

test('suggests the commits highest ordinal first (AR15)', async ({ page, request }) => {
  const [, newest] = await newestCommits(request)
  await page.goto(`/compare?suite_a=libcxx&machine_a=${LINUX}`)

  await sideOf(page, 'A').getByRole('button', { name: 'Show suggestions Commit' }).click()

  // Not the experiment, although LINUX saw it last: it has no ordinal, so it comes after them.
  await expect(page.getByRole('option').first()).toContainText(String(newest.fields.svn_revision))
})

test("links a test to its profile on both sides, side B on its default test", async ({
  page,
  request,
}) => {
  const [, newest] = await newestCommits(request)
  const runA = await profiledRun(request, LINUX, newest.value)
  const runB = await profiledRun(request, LINUX, EXPERIMENT)
  const query = new URLSearchParams({
    suite_a: 'libcxx',
    machine_a: LINUX,
    commit_a: newest.value,
    suite_b: 'libcxx',
    machine_b: LINUX,
    commit_b: EXPERIMENT,
    metric: 'execution_time',
    test_filter: PROFILED_TEST,
  })
  await page.goto(`/compare?${query}`)

  const row = rows(table(page, 'Comparison')).filter({ hasText: PROFILED_TEST }).first()
  const profiles = new URLSearchParams({
    suite_a: 'libcxx',
    machine_a: LINUX,
    commit_a: newest.value,
    run_a: runA,
    test_a: PROFILED_TEST,
    suite_b: 'libcxx',
    machine_b: LINUX,
    commit_b: EXPERIMENT,
    run_b: runB,
  })
  await expect(row.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    `/profiles?${profiles}`,
  )
})

test('adds the comparison to a new regression, then to that one', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  const run = (commit: string, ordinal: number, value: number) => ({
    machine: 'm1',
    commit,
    ordinal,
    tests: [{ name: 'bench', samples: [{ execution_time: value }] }],
  })
  await ownSuite(request, tokenFor, testInfo, [run('c1', 1, 1), run('c2', 2, 2)], async (suite) => {
    await signIn(page, 'triage')
    await page.goto(
      `/compare?suite_a=${suite}&machine_a=m1&commit_a=c1&suite_b=${suite}&machine_b=m1` +
        '&commit_b=c2&metric=execution_time',
    )
    await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')

    const toggle = page.getByRole('button', { name: 'Add to regression' })
    await toggle.click()
    const create = page.getByRole('form', { name: 'Create new regression' })
    await create.getByLabel('Title').fill('From compare')
    await create.getByRole('button', { name: 'Create regression' }).click()
    const link = page.getByRole('status').getByRole('link', { name: 'From compare' })
    await expect(link).toBeVisible()
    const uuid = (await link.getAttribute('href'))!.split('/').at(-1)!
    const created = await json<Schemas['RegressionDetail']>(
      request,
      `/api/suites/${suite}/regressions/${uuid}`,
    )
    expect(created.commit).toBe('c2')
    expect(created.indicators).toMatchObject([
      { machine: 'm1', test: 'bench', metric: 'execution_time' },
    ])

    // Adding the same indicator again adds none.
    await toggle.click()
    const add = page.getByRole('form', { name: 'Add to existing' })
    await add.getByRole('combobox', { name: 'Regression' }).fill('From')
    await page.getByRole('option', { name: 'From compare' }).click()
    await add.getByRole('button', { name: 'Add indicators' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Added' })).toHaveText(
      'Added 0 indicators to From compare. 1 indicator already existed.',
    )
  })
})

test('overlays sides B pinned on the chart, keeping them on a swap', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )
  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')

  const pin = page.getByRole('button', { name: 'Pin as shadow' })
  const chips = page.getByRole('list', { name: 'Shadows' }).getByRole('listitem')
  const shadows = () => new URL(page.url()).searchParams.getAll('shadow')
  const first = `libcxx/${LINUX}/${newer.fields.svn_revision}`
  await pin.click()
  await expect(chips).toHaveText([new RegExp(`^●Shadow: ${first} · \\d+ tests×$`)])
  await expect(page.getByRole('button', { name: `Dismiss the shadow ${first}` })).toBeFocused()
  await expect(pin).toBeDisabled()
  // Side B on the experiment: its comparison is the bars, and the newest commit's a line.
  // Typed key by key, as a user does: `fill`, which sets the whole text at once, is sometimes lost
  // when the focus comes from the chip's button.
  const commitB = sideOf(page, 'B').getByRole('combobox', { name: 'Commit' })
  await commitB.click()
  await commitB.press('ControlOrMeta+a')
  await commitB.pressSequentially(EXPERIMENT)
  await page.getByRole('option', { name: EXPERIMENT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]commit_b=${EXPERIMENT}(&|$)`))
  const traces = () =>
    plotOf(page).evaluate((element) =>
      (element as PlotDiv)._fullData.map((trace) => ({ name: trace.name, y: trace.y })),
    )
  await expect.poll(async () => (await traces()).map((trace) => trace.name)).toEqual([
    'comparison',
    'shadow 1',
  ])
  // The line goes through a point per test, sorted by its own ratios.
  const points = (await traces())[1].y
  expect(points.length).toBeGreaterThan(10)
  expect(points).toEqual([...points].sort((x, y) => x - y))
  // Its chip counts them.
  await expect(chips).toHaveText([`●Shadow: ${first} · ${points.length} tests×`])

  // The experiment pinned too: two lines.
  await pin.click()
  await expect(chips).toHaveCount(2)
  expect(shadows()).toEqual([`libcxx/${LINUX}/${newer.value}`, `libcxx/${LINUX}/${EXPERIMENT}`])
  await expect.poll(async () => (await traces()).map((trace) => trace.name)).toEqual([
    'comparison',
    'shadow 1',
    'shadow 2',
  ])

  // Swapping the sides keeps both, compared with the new side A.
  await page.getByRole('button', { name: 'Swap sides' }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]commit_a=${EXPERIMENT}(&|$)`))
  await expect(chips).toHaveCount(2)
  expect(shadows()).toHaveLength(2)
  await expect.poll(async () => (await traces()).length).toBe(3)

  // Dismissing the first gives the focus to the chip after it.
  await page.getByRole('button', { name: `Dismiss the shadow ${first}` }).click()
  await expect(chips).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^Dismiss the shadow / })).toBeFocused()
  expect(shadows()).toEqual([`libcxx/${LINUX}/${EXPERIMENT}`])
})
