import type { AggFn } from './types';
import { getTestSuiteInfoCached, resolveCommits } from './api';
import { navigate, getBasePath, getUrlBase } from './router';

/**
 * Separator between test name and machine name in trace names.
 * Uses middle-dot (U+00B7) to avoid ambiguity when machine names contain ' - '.
 */
export const TRACE_SEP = ' \u00b7 ';

/** Delay (ms) to distinguish single-click from double-click. */
export const DOUBLE_CLICK_DELAY_MS = 200;

// Aggregation functions

/** Default Plotly color palette, shared across Graph and Dashboard sparklines. */
const PLOTLY_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

/** Return a color from the shared palette by index (wraps around). */
export function machineColor(index: number): string {
  return PLOTLY_COLORS[index % PLOTLY_COLORS.length];
}

/** Colors for comparison row statuses, shared across chart and summary bar. */
export const STATUS_COLORS: Record<string, string> = {
  improved: '#2ca02c',
  regressed: '#d62728',
  noise: '#999999',
  unchanged: '#999999',
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function safeMin(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => Math.min(a, b));
}

export function safeMax(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => Math.max(a, b));
}

/** Geometric mean of positive values. Returns null if no valid (> 0) values. */
export function geomean(values: number[]): number | null {
  const valid = values.filter(v => v > 0);
  if (valid.length === 0) return null;
  const sumLog = valid.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(sumLog / valid.length);
}

export function getAggFn(name: AggFn): (values: number[]) => number {
  switch (name) {
    case 'median': return median;
    case 'mean': return mean;
    case 'min': return safeMin;
    case 'max': return safeMax;
  }
}

// Formatting

export function formatValue(v: number | null): string {
  if (v === null) return 'N/A';
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toPrecision(4);
  if (v === 0) return '0';
  return v.toPrecision(3);
}

export function formatPercent(v: number | null): string {
  if (v === null) return 'N/A';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export function formatRatio(v: number | null): string {
  if (v === null) return 'N/A';
  return v.toFixed(4);
}

export function formatTime(iso: string | null, fallback = '\u2014'): string {
  if (!iso) return fallback;
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

/** Ensure a URL has a protocol; prepend https:// if missing. */
export function ensureProtocol(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}


/**
 * Return the display value for a commit. If the schema defines a commit_field
 * with display=true and the commit's fields dict has a non-null value for it,
 * return that value. Otherwise, return the raw commit string.
 *
 * If the commit has a tag, it is appended in parentheses.
 */
export function commitDisplayValue(
  entry: { commit: string; fields: Record<string, string>; tag?: string | null },
  commitFields?: Array<{ name: string; display?: boolean }>,
): string {
  let base = entry.commit;
  if (commitFields) {
    const displayField = commitFields.find(f => f.display);
    if (displayField && entry.fields[displayField.name]) {
      base = entry.fields[displayField.name];
    }
  }
  if (entry.tag) {
    return `${base} (${entry.tag})`;
  }
  return base;
}


/**
 * Resolve display values for a batch of commits via the API.
 *
 * Fetches the test suite schema (cached) and calls POST /commits/resolve,
 * then builds a Map from raw commit string to display value using
 * ``commitDisplayValue()``.
 *
 * On any failure (network, missing schema, etc.) returns an empty map
 * so callers can always fall back to raw commit strings without try/catch.
 */
export async function resolveDisplayMap(
  suite: string,
  commits: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (commits.length === 0) return new Map();
  try {
    const [suiteInfo, resolved] = await Promise.all([
      getTestSuiteInfoCached(suite, signal),
      resolveCommits(suite, commits, signal),
    ]);
    const commitFields = suiteInfo.schema.commit_fields;
    const map = new Map<string, string>();
    for (const [key, summary] of Object.entries(resolved.results)) {
      map.set(key, commitDisplayValue(summary, commitFields));
    }
    return map;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return new Map();
  }
}


// Text filtering

let _cachedFilterKey = '';
let _cachedRegex: RegExp | null = null;
let _cachedRegexValid = true;
let _cachedPlainFilter = '';
let _cachedPlainLower = '';

function _getRegex(pattern: string): RegExp | null {
  const key = 're:' + pattern;
  if (_cachedFilterKey !== key) {
    _cachedFilterKey = key;
    try {
      _cachedRegex = new RegExp(pattern, 'i');
      _cachedRegexValid = true;
    } catch {
      _cachedRegex = null;
      _cachedRegexValid = false;
    }
  }
  return _cachedRegex;
}

export function matchesFilter(text: string, filter: string): boolean {
  if (!filter) return true;
  if (filter.startsWith('re:')) {
    const regex = _getRegex(filter.slice(3));
    return regex ? regex.test(text) : false;
  }
  if (_cachedPlainFilter !== filter) {
    _cachedPlainFilter = filter;
    _cachedPlainLower = filter.toLowerCase();
  }
  return text.toLowerCase().includes(_cachedPlainLower);
}

export function isFilterValid(filter: string): boolean {
  if (!filter || !filter.startsWith('re:')) return true;
  _getRegex(filter.slice(3));
  return _cachedRegexValid;
}

export function updateFilterValidation(input: HTMLInputElement): void {
  const isRegex = input.value.startsWith('re:');
  const valid = isFilterValid(input.value);

  input.classList.toggle('filter-invalid', !valid);

  let container = input.parentElement;
  const needsWrap = container
    && !container.classList.contains('combobox')
    && !container.classList.contains('commit-search')
    && !container.classList.contains('filter-input-wrapper');

  if (isRegex && needsWrap) {
    const wrapper = el('div', { class: 'filter-input-wrapper' });
    container!.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    container = wrapper;
  } else if (needsWrap) {
    // Input has never entered regex mode, so no wrapper or chip exists yet.
    return;
  } else {
    container = input.parentElement;
  }

  let badge = container?.querySelector('.filter-regex-badge') as HTMLElement | null;

  if (isRegex) {
    if (!badge) {
      badge = el('span', { class: 'filter-regex-badge', 'aria-hidden': 'true' }, 'regex');
      input.after(badge);
    }
    badge.classList.toggle('filter-regex-badge-invalid', !valid);
    input.classList.add('filter-has-badge');
  } else if (badge) {
    badge.remove();
    input.classList.remove('filter-has-badge');
  }
}


// DOM helpers

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === true) {
        e.setAttribute(k, '');
      } else if (v === false) {
        // Boolean false: omit the attribute entirely
      } else {
        e.setAttribute(k, v);
      }
    }
  }
  for (const child of children) {
    e.append(child);
  }
  return e;
}

/** Return true when the click should be handled by the browser (new tab, etc.). */
export function isModifiedClick(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

/**
 * Create an anchor element that navigates via the SPA router.
 * All internal links across all pages should use this helper.
 *
 * The href is set to the real full path so that right-click "Open in new tab",
 * Cmd+Click / Ctrl+Click (open in new tab), middle-click, browser status bar,
 * and screen readers all work correctly. Modified clicks (Cmd, Ctrl, Shift,
 * middle-click) bypass the SPA router and let the browser handle them natively.
 */
export function spaLink(text: string, path: string): HTMLAnchorElement {
  const a = el('a', { href: getBasePath() + path, class: 'spa-link' }, text);
  a.addEventListener('click', (e) => {
    if (isModifiedClick(e)) return;
    e.preventDefault();
    navigate(path);
  });
  return a;
}

/**
 * Build a full URL for a suite-agnostic page.
 * @param path  Path relative to /v5, e.g. "/compare?suite_a=nts"
 */
export function agnosticUrl(path: string): string {
  return getUrlBase() + '/v5' + path;
}

/**
 * Create an anchor element that links to a suite-agnostic page.
 *
 * Use this for cross-context links from suite-scoped pages to suite-agnostic
 * pages (e.g. Graph, Compare). These links trigger a full page load since the
 * SPA context changes (different route table, different basePath).
 *
 * @param text  Link text
 * @param path  Path relative to /v5, e.g. "/compare?suite_a=nts&machine_a=..."
 */
export function agnosticLink(text: string, path: string): HTMLAnchorElement {
  return el('a', { href: agnosticUrl(path), class: 'spa-link' }, text);
}
