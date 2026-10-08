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
 * that is only spelled unusually (`offset=050`) is rewritten. One that only the server can rule
 * out, such as a machine that does not exist, is dropped by `useDropUnusable` once a response shows
 * it to be unusable.
 *
 * `useUrlState` needs a `UrlStateProvider` inside the router.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, type RefObject } from 'react'
import { useLocation, useNavigate, type Location } from 'react-router'

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

/** One of `options`. */
export function enumParam<const T extends string>(options: readonly T[], defaultValue: T): Param<T> {
  return singleParam(defaultValue, (value) => options.find((option) => option === value))
}

/** A non-negative integer. */
export function integerParam(defaultValue = 0): Param<number> {
  return singleParam(defaultValue, (value) => {
    const number = Number(value)
    return /^\d+$/.test(value) && Number.isSafeInteger(number) ? number : undefined
  })
}

/** A parameter repeated once per value (I3's convention). */
export function listParam(): Param<string[]> {
  return { default: [], parse: (values) => values, serialize: (value) => value }
}

/** How `value` is spelled in the URL: not at all at its default. */
function canonical<T>(param: Param<T>, value: T): string[] {
  const serialized = param.serialize(value)
  const atDefault = sameValues(serialized, param.serialize(param.default))
  return atDefault ? [] : serialized
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/** The settings, and the values to rewrite: unusable ones to their default, others canonically. */
function read<P extends Params>(params: P, search: URLSearchParams) {
  const values: Record<string, unknown> = {}
  const rewrites: Record<string, unknown> = {}
  for (const [key, param] of Object.entries(params)) {
    const raw = search.getAll(key)
    const value = raw.length === 0 ? param.default : (param.parse(raw) ?? param.default)
    values[key] = value
    if (!sameValues(raw, canonical(param, value))) rewrites[key] = value
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
 * keep their own. Changes compose, even several within one event handler. A change made after the
 * path has changed -- a debounced search landing after the user navigated away -- is ignored,
 * rather than applied to the page now showing.
 */
export function useUrlState<P extends Params>(
  params: P,
): [ValuesOf<P>, (changes: Partial<ValuesOf<P>>) => void] {
  const location = useLocation()
  const navigate = useNavigate()
  const pendingRef = useContext(PendingLocation)
  if (pendingRef === null) throw new Error('useUrlState must be used inside a UrlStateProvider')

  const { values, rewrites } = useMemo(
    () => read(params, new URLSearchParams(location.search)),
    [params, location.search],
  )

  const { pathname } = location
  const update = useCallback(
    (changes: Partial<ValuesOf<P>>) => {
      const current = pendingRef.current
      if (current.pathname !== pathname) return

      const search = new URLSearchParams(current.search)
      for (const [key, value] of Object.entries(changes)) {
        const param = params[key]
        if (param === undefined || value === undefined) continue
        search.delete(key)
        for (const item of canonical(param, value)) search.append(key, item)
      }
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
