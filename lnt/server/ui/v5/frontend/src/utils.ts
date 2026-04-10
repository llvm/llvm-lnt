import type { AggFn } from './types';
import { navigate, getBasePath, getUrlBase } from './router';

/**
 * Separator between test name and machine name in trace names.
 * Uses middle-dot (U+00B7) to avoid ambiguity when machine names contain ' - '.
 */
export const TRACE_SEP = ' \u00b7 ';

// Aggregation functions

/** Default Plotly color palette, shared across Graph and Dashboard sparklines. */
export const PLOTLY_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

/** Return a color from the shared palette by index (wraps around). */
export function machineColor(index: number): string {
  return PLOTLY_COLORS[index % PLOTLY_COLORS.length];
}

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

/** Extract the primary (first) order field value from an order fields dict. */
export function primaryOrderValue(fields: Record<string, string>): string {
  return Object.values(fields)[0] || '';
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
