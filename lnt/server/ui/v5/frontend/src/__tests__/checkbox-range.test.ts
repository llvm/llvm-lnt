// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { setupCheckboxRange } from '../components/checkbox-range';

function createCheckboxList(count: number): { container: HTMLElement; boxes: HTMLInputElement[] } {
  const container = document.createElement('div');
  const boxes: HTMLInputElement[] = [];
  for (let i = 0; i < count; i++) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-uuid', `uuid-${i}`);
    container.append(cb);
    boxes.push(cb);
  }
  return { container, boxes };
}

/** Simulate a click with optional shiftKey. JSDOM toggles checkbox checked
 *  state on dispatchEvent(MouseEvent('click')), so we just dispatch. */
function clickCheckbox(cb: HTMLInputElement, shiftKey = false): void {
  cb.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
}

describe('setupCheckboxRange', () => {
  let container: HTMLElement;
  let boxes: HTMLInputElement[];
  let changeCalls: number;

  beforeEach(() => {
    ({ container, boxes } = createCheckboxList(5));
    changeCalls = 0;
  });

  it('does nothing on normal click (no shift)', () => {
    setupCheckboxRange(container, 'input[type="checkbox"][data-uuid]', () => changeCalls++);

    clickCheckbox(boxes[2]); // checks it

    // Only the clicked checkbox should be checked
    expect(boxes.map(b => b.checked)).toEqual([false, false, true, false, false]);
  });

  it('selects range on shift+click', () => {
    setupCheckboxRange(container, 'input[type="checkbox"][data-uuid]', () => changeCalls++);

    // Click first
    clickCheckbox(boxes[1]); // checks box 1

    // Shift+click fourth
    clickCheckbox(boxes[4], true); // checks box 4, range fills 1..4

    expect(boxes.map(b => b.checked)).toEqual([false, true, true, true, true]);
    expect(changeCalls).toBeGreaterThan(0);
  });

  it('deselects range on shift+click with unchecked', () => {
    // Check all first
    boxes.forEach(b => { b.checked = true; });

    setupCheckboxRange(container, 'input[type="checkbox"][data-uuid]', () => changeCalls++);

    // Click to uncheck box 1
    clickCheckbox(boxes[1]); // unchecks

    // Shift+click to uncheck box 3
    clickCheckbox(boxes[3], true); // unchecks, range fills 1..3

    expect(boxes.map(b => b.checked)).toEqual([true, false, false, false, true]);
  });

  it('handles shift+click after DOM reorder', () => {
    setupCheckboxRange(container, 'input[type="checkbox"][data-uuid]', () => changeCalls++);

    // Click box 0
    clickCheckbox(boxes[0]); // checks it

    // Reorder: reverse the checkboxes in DOM
    container.replaceChildren(...[...boxes].reverse());

    // Now boxes[0] is last in DOM order (index 4), boxes[4] is first (index 0)
    // Shift+click boxes[4] (first in DOM)
    clickCheckbox(boxes[4], true); // checks box 4, range fills DOM indices 0..4

    expect(boxes.every(b => b.checked)).toBe(true);
  });

  it('destroy removes the event listener', () => {
    const handle = setupCheckboxRange(container, 'input[type="checkbox"][data-uuid]', () => changeCalls++);

    handle.destroy();

    clickCheckbox(boxes[1]); // checks
    clickCheckbox(boxes[3], true); // checks, but no range since listener is gone

    // Range should NOT have been applied
    expect(boxes.map(b => b.checked)).toEqual([false, true, false, true, false]);
    expect(changeCalls).toBe(0);
  });
});
