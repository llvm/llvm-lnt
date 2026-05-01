// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCommitPicker } from '../components/commit-combobox';

const COMMIT_VALUES = ['100', '101', '102', '200'];

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('createCommitPicker', () => {
  it('renders a combobox wrapper with input and dropdown', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    expect(picker.element.getAttribute('role')).toBe('combobox');
    expect(picker.element.querySelector('input')).toBeTruthy();
    expect(picker.element.querySelector('ul')).toBeTruthy();

    picker.element.remove();
  });

  it('shows all commits on focus', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(4);

    picker.element.remove();
  });

  it('displays values in dropdown items', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100');
    expect(texts).toContain('101');
    expect(texts).toContain('102');
    expect(texts).toContain('200');

    picker.element.remove();
  });

  it('filters by commit value', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(3); // 100, 101, 102
    expect(Array.from(items).map(li => li.textContent)).not.toContain('200');

    picker.element.remove();
  });

  it('filters by commit value prefix', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '200';
    picker.input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('200');

    picker.element.remove();
  });

  it('calls onSelect with commit value on click', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click(); // "100"

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('sets input value on selection', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(picker.input.value).toBe('100');

    picker.element.remove();
  });

  it('keeps dropdown open when ArrowDown moves focus to an item', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const dropdown = picker.element.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    picker.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

    expect(dropdown.classList.contains('open')).toBe(true);

    picker.element.remove();
  });

  it('selects item via ArrowDown then Enter', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const dropdown = picker.element.querySelector('ul') as HTMLElement;

    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
    picker.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

    firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts value on change event', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('change'));

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('sets initial value', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      initialValue: '100',
      onSelect: () => {},
    });
    document.body.append(picker.element);

    expect(picker.input.value).toBe('100');

    picker.element.remove();
  });

  it('sets initial value for any commit', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      initialValue: '101',
      onSelect: () => {},
    });

    expect(picker.input.value).toBe('101');
  });

  it('limits dropdown to 100 items', () => {
    const values = Array.from({ length: 150 }, (_, i) => String(i));
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(100);

    picker.element.remove();
  });

  it('closes dropdown on blur', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    expect(picker.element.querySelector('.combobox-dropdown.open')).toBeTruthy();

    picker.input.dispatchEvent(new Event('blur'));
    expect(picker.element.querySelector('.combobox-dropdown.open')).toBeNull();

    picker.element.remove();
  });

  it('uses custom placeholder', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      placeholder: 'Custom placeholder',
      onSelect: () => {},
    });

    expect(picker.input.placeholder).toBe('Custom placeholder');
  });

  // --- Validation tests ---

  it('shows combobox-invalid on input when no commits match', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-no-match';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('removes combobox-invalid on input when commits match', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('no combobox-invalid when input is empty', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('does not call onSelect on change when combobox-invalid', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input')); // triggers invalid
    picker.input.dispatchEvent(new Event('change'));

    expect(onSelect).not.toHaveBeenCalled();

    picker.element.remove();
  });

  it('calls onSelect on Enter when input is valid', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input')); // populate dropdown
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('does not call onSelect on Enter when input is invalid', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input')); // triggers invalid
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onSelect).not.toHaveBeenCalled();

    picker.element.remove();
  });

  it('rejects partial match on Enter (exact-match required)', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    // "10" substring-matches "100", "101", "102" but is not an exact match
    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(false); // suggestions exist

    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('rejects partial match on change (exact-match required)', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new Event('change'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('accepts exact match on Enter', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts exact match on change', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new Event('change'));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts exact match on Enter via display value', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });
});

// ---------------------------------------------------------------------------
// createCommitPicker with displayMap
// ---------------------------------------------------------------------------

describe('createCommitPicker with displayMap', () => {
  const DISPLAY_MAP = new Map([['abc123', 'v1.0'], ['def456', 'v2.0']]);
  const COMMIT_VALUES_DM = ['abc123', 'def456', 'ghi789'];

  it('shows display values in dropdown items', () => {
    const picker = createCommitPicker({
      id: 'display-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    const input = picker.input;
    input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items[0].textContent).toBe('v1.0');
    expect(items[1].textContent).toBe('v2.0');
    expect(items[2].textContent).toBe('ghi789'); // no mapping, raw string

    picker.element.remove();
  });

  it('filters by display value', () => {
    const picker = createCommitPicker({
      id: 'filter-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    const input = picker.input;
    input.value = 'v1';
    input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('v1.0');

    picker.element.remove();
  });

  it('calls onSelect with raw commit string', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'select-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect,
    });
    document.body.append(picker.element);

    const input = picker.input;
    input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(onSelect).toHaveBeenCalledWith('abc123'); // raw string, not 'v1.0'

    picker.element.remove();
  });

  it('sets display value in input after click selection', () => {
    const picker = createCommitPicker({
      id: 'click-display-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(picker.input.value).toBe('v1.0');

    picker.element.remove();
  });

  it('setValue resolves display value from current displayMap', () => {
    let displayMap: Map<string, string> | undefined;
    const picker = createCommitPicker({
      id: 'setvalue-test',
      getCommitData: () => ({ values: ['abc123'], displayMap }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.setValue('abc123');
    expect(picker.input.value).toBe('abc123');

    displayMap = new Map([['abc123', 'v1.0 (tag)']]);
    picker.setValue('abc123');
    expect(picker.input.value).toBe('v1.0 (tag)');

    picker.element.remove();
  });
});
