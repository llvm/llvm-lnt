// regression-utils.ts — Shared constants and helpers for regression pages.

import type { RegressionState } from './types';
import { el } from './utils';

/** Display metadata for each regression state. */
export const STATE_META: Record<RegressionState, {
  label: string;
  cssClass: string;
}> = {
  detected:        { label: 'Detected',        cssClass: 'state-detected' },
  active:          { label: 'Active',           cssClass: 'state-active' },
  not_to_be_fixed: { label: 'Not To Be Fixed', cssClass: 'state-not-to-be-fixed' },
  fixed:           { label: 'Fixed',            cssClass: 'state-fixed' },
  false_positive:  { label: 'False Positive',   cssClass: 'state-false-positive' },
};

/** All valid regression states in display order. */
export const ALL_STATES: RegressionState[] = [
  'detected', 'active', 'not_to_be_fixed', 'fixed', 'false_positive',
];

/** Resolved states (these are considered "closed"). */
export const RESOLVED_STATES: RegressionState[] = [
  'not_to_be_fixed', 'fixed', 'false_positive',
];

/** Non-resolved states (these are "open" / active). */
export const UNRESOLVED_STATES: RegressionState[] = [
  'detected', 'active',
];

/** Render a state badge span element. */
export function renderStateBadge(state: RegressionState): HTMLElement {
  const meta = STATE_META[state];
  return el('span', { class: `state-badge ${meta?.cssClass || ''}` },
    meta?.label || state);
}
