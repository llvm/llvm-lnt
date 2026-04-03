import type { AggFn } from './types';
import { navigate, getBasePath } from './router';

/**
 * Separator between test name and machine name in trace names.
 * Uses middle-dot (U+00B7) to avoid ambiguity when machine names contain ' - '.
 */
export const TRACE_SEP = ' \u00b7 ';

// Aggregation functions

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

/**
 * Create an anchor element that navigates via the SPA router.
 * All internal links across all pages should use this helper.
 *
 * The href is set to the real full path so that right-click "Open in new tab",
 * middle-click, browser status bar, and screen readers all work correctly.
 */
export function spaLink(text: string, path: string): HTMLAnchorElement {
  const a = el('a', { href: getBasePath() + path, class: 'spa-link' }, text);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(path);
  });
  return a;
}
