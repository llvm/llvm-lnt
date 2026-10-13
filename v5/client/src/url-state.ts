/**
 * A page's settings, kept in the URL's query parameters (AR2 "State").
 *
 * A page declares each setting it keeps in the URL as a `Param`, and reads and writes them through
 * `useUrlState`. A setting at its default is left out of the URL. Writing replaces the current
 * history entry, so that Back leaves the page rather than stepping back through its settings;
 * changing the path (a link, `navigate`) adds one as usual.
 *
 * A value the page cannot use is dropped, and the page uses the default instead. One that is
 * malformed -- not one of an enumeration's values, say -- is dropped as soon as it is read, and one
 * that is only spelled unusually (a search with spaces around it) is rewritten. One that only the
 * server can rule out, such as a machine that does not exist, is dropped by `useDropUnusable` once
 * a response shows it to be unusable.
 *
 * `useUrlState` needs a `UrlStateProvider` inside the router.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react'
import { useLocation, useNavigate, useNavigationType, type Location } from 'react-router'
import { parseNumber } from './format'
import { sameElements } from './same-elements'

/**
 * How one setting is read from and written to the URL. (Methods rather than function-typed
 * properties, so that any `Param<T>` is a `Param<unknown>`.)
 */
export interface Param<T> {
  default: T
  /** The setting for the parameter's values, or undefined if the page cannot use them. */
  parse(values: string[]): T | undefined
  serialize(value: T): string[]
}

type Params = Record<string, Param<unknown>>

export type ValuesOf<P extends Params> = { [K in keyof P]: P[K]['default'] }

/** A parameter given once, read by `parseOne`. Given more than once, it is unusable. */
function singleParam<T>(defaultValue: T, parseOne: (value: string) => T | undefined): Param<T> {
  return {
    default: defaultValue,
    parse: (values) => (values.length === 1 ? parseOne(values[0]) : undefined),
    serialize: (value) => [String(value)],
  }
}

export function stringParam(defaultValue = ''): Param<string> {
  return singleParam(defaultValue, (value) => value)
}

/** A text whose surrounding spaces are dropped: a search's, which never means to match them. */
export function trimmedStringParam(): Param<string> {
  return singleParam('', (value) => value.trim())
}

/** One of `options`. */
export function enumParam<const T extends string>(options: readonly T[], defaultValue: T): Param<T> {
  return singleParam(defaultValue, (value) => options.find((option) => option === value))
}

/** A boolean, spelled `true` or `false`. */
export function booleanParam(defaultValue: boolean): Param<boolean> {
  return singleParam(defaultValue, (value) =>
    value === 'true' ? true : value === 'false' ? false : undefined,
  )
}

/**
 * A number between `min` and `max` that the URL may leave out, which is null, such as the value
 * of an optional knob that the URL holds only while it is enabled (CP7). A value that is not such
 * a number is unusable.
 */
export function optionalNumberParam(min = -Infinity, max = Infinity): Param<number | null> {
  return singleParam<number | null>(null, (value) => parseNumber(value, min, max))
}

/** A parameter repeated once per value (I3's convention). */
export function listParam(): Param<string[]> {
  // Each value once, in the order first given: a value given twice means nothing more.
  return { default: [], parse: (values) => [...new Set(values)], serialize: (value) => value }
}

/**
 * Any number of `options`, repeated once per value, and none by default. Values that are not
 * options are dropped, and the rest are kept once each, in the order of `options`.
 */
export function enumListParam<const T extends string>(options: readonly T[]): Param<T[]> {
  return {
    default: [],
    parse: (values) => options.filter((option) => values.includes(option)),
    serialize: (value) => options.filter((option) => value.includes(option)),
  }
}

/** Whether `value` is `param`'s default, and so absent from the URL. */
export function isDefault<T>(param: Param<T>, value: T): boolean {
  return sameElements(param.serialize(value), param.serialize(param.default))
}

/**
 * The settings of a page with tabs (AR2 "State"). `params` declares the tab, as `tab`, and the
 * settings of every tab; `perTab` lists the settings each tab uses. Two functions give settings
 * their defaults, as changes for `useUrlState`:
 *
 * - `reset()`: every setting, for switching to another tab, which starts afresh.
 * - `unused(values)`: the settings the URL holds but the tab of `values` does not use, for the page
 *   to drop them.
 */
export function tabSettings<P extends Params & { tab: Param<string> }>(
  params: P,
  perTab: Record<ValuesOf<P>['tab'], readonly Exclude<keyof P, 'tab'>[]>,
) {
  type Setting = Exclude<keyof P, 'tab'>
  const settings = Object.keys(params).filter((key) => key !== 'tab') as Setting[]
  const defaults = (keys: readonly Setting[]) =>
    Object.fromEntries(keys.map((key) => [key, params[key].default])) as Partial<ValuesOf<P>>
  return {
    reset: () => defaults(settings),
    unused: (values: ValuesOf<P>) => {
      const used = perTab[values.tab as ValuesOf<P>['tab']]
      return defaults(
        settings.filter((key) => !used.includes(key) && !isDefault(params[key], values[key])),
      )
    },
  }
}

/** How `value` is spelled in the URL: not at all at its default. */
function canonical<T>(param: Param<T>, value: T): string[] {
  return isDefault(param, value) ? [] : param.serialize(value)
}

/** A setting as last read: the URL's values it was read from, and the value they gave. */
interface Reading {
  raw: string[]
  value: unknown
}

/**
 * The settings, and the values to rewrite: unusable ones to their default, others canonically. A
 * setting whose values in the URL are those of its reading in `readings` keeps the value it had,
 * the same array for a list, so that what a page computes from it is not computed again whenever
 * another setting changes. `readings` is updated with what is read.
 */
function read<P extends Params>(
  params: P,
  search: URLSearchParams,
  readings: Map<string, Reading>,
) {
  const values: Record<string, unknown> = {}
  const rewrites: Record<string, unknown> = {}
  for (const [key, param] of Object.entries(params)) {
    const raw = search.getAll(key)
    const last = readings.get(key)
    const value =
      last !== undefined && sameElements(last.raw, raw)
        ? last.value
        : raw.length === 0
          ? param.default
          : (param.parse(raw) ?? param.default)
    readings.set(key, { raw, value })
    values[key] = value
    if (!sameElements(raw, canonical(param, value))) rewrites[key] = value
  }
  return { values: values as ValuesOf<P>, rewrites: rewrites as Partial<ValuesOf<P>> }
}

/**
 * The location every `useUrlState` of the app starts its changes from: the router's, or the one a
 * change has just navigated to but the router has not rendered yet. Shared, so that changes made
 * one after the other compose, whichever part of the page makes them. `UrlStateProvider` provides
 * it.
 */
export const PendingLocation = createContext<RefObject<Location> | null>(null)

/**
 * The settings `params` declares, read from the URL, and a function that changes some of them.
 *
 * Declare `params` once, outside the component, so that it is the same object on every render.
 * Parameters it does not declare are left as they are, so that several parts of a page can each
 * keep their own. A setting keeps the same value, the same array for a list, for as long as its
 * values in the URL do not change, so that it can be a dependency of a memo. Changes compose, even
 * several within one event handler. A change made after the path has changed -- a debounced
 * search landing after the user navigated away -- is ignored, rather than applied to the page now
 * showing.
 */
export function useUrlState<P extends Params>(
  params: P,
): [ValuesOf<P>, (changes: Partial<ValuesOf<P>>) => void] {
  const location = useLocation()
  const navigate = useNavigate()
  const pendingRef = useContext(PendingLocation)
  if (pendingRef === null) throw new Error('useUrlState must be used inside a UrlStateProvider')

  // What each setting was last read as, which only ever lets a setting keep the value it had.
  const [readings] = useState(() => new Map<string, Reading>())
  const { values, rewrites } = useMemo(
    () => read(params, new URLSearchParams(location.search), readings),
    [params, location.search, readings],
  )

  const { pathname } = location
  const update = useCallback(
    (changes: Partial<ValuesOf<P>>) => {
      const current = pendingRef.current
      if (current.pathname !== pathname) return

      const search = new URLSearchParams(current.search)
      let changed = false
      for (const [key, value] of Object.entries(changes)) {
        const param = params[key]
        if (param === undefined || value === undefined) continue
        const items = canonical(param, value)
        if (sameElements(search.getAll(key), items)) continue
        changed = true
        search.delete(key)
        for (const item of items) search.append(key, item)
      }
      // A change that leaves the URL as it is must not navigate: each navigation is a new location
      // that renders the page again, so a caller writing on every render (`useDropUnusable`, with a
      // check that rejects the default too) would never settle.
      if (!changed) return
      const next = search.toString()
      pendingRef.current = { ...current, search: next ? `?${next}` : '' }
      navigate(
        { pathname, search: pendingRef.current.search, hash: current.hash },
        { replace: true },
      )
    },
    [params, navigate, pathname, pendingRef],
  )

  // Make the URL say what the page shows: drop what it cannot use, and spell the rest canonically.
  useEffect(() => {
    if (Object.keys(rewrites).length > 0) update(rewrites)
  }, [rewrites, update])

  return [values, update]
}

/**
 * A key that changes whenever the user navigates to the page -- a link to it while on it, say -- but
 * not when the page's own changes to its settings replace the history entry (AR2 "State"). A page
 * rendered under it starts afresh on each visit, in the state the new URL describes.
 */
export function useVisitKey(): string {
  const location = useLocation()
  const navigation = useNavigationType()
  const [visit, setVisit] = useState(location.key)
  if (navigation !== 'REPLACE' && location.key !== visit) setVisit(location.key)
  return visit
}

/** The parts of a query result that say whether its data can be relied on. */
interface Settled<Data> {
  data: Data | undefined
  isSuccess: boolean
  isPlaceholderData?: boolean
}

/**
 * Call `drop` once `query` has succeeded and `isUsable` says, from its data, that a setting is not
 * usable. A query that failed, or is still showing placeholder data from a previous query, shows
 * nothing about the setting, and drops nothing.
 */
export function useDropUnusable<Data>(
  query: Settled<Data>,
  isUsable: (data: Data) => boolean,
  drop: () => void,
): void {
  const { data, isSuccess, isPlaceholderData } = query
  useEffect(() => {
    if (isSuccess && !isPlaceholderData && !isUsable(data as Data)) drop()
  })
}
