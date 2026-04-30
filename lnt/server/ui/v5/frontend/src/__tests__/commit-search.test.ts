// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing the component
vi.mock('../api', () => ({
  searchCommits: vi.fn(),
}));
vi.mock('../router', () => ({
  navigate: vi.fn(),
}));

import { renderCommitSearch } from '../components/commit-search';
import { searchCommits } from '../api';
import { navigate } from '../router';

const mockSearch = searchCommits as ReturnType<typeof vi.fn>;
const mockNavigate = navigate as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  mockSearch.mockReset();
  mockNavigate.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function cursorPage(items: Array<{ commit: string; ordinal: number | null; fields: Record<string, string> }>) {
  return { items, cursor: { next: null, previous: null } };
}

describe('renderCommitSearch', () => {
  it('renders an input and dropdown into the container', () => {
    const container = document.createElement('div');
    renderCommitSearch(container, { testsuite: 'nts' });

    expect(container.querySelector('input.commit-search-input')).not.toBeNull();
    expect(container.querySelector('ul.commit-search-dropdown')).not.toBeNull();
  });

  it('calls searchCommits after debounce on input', async () => {
    mockSearch.mockResolvedValue(cursorPage([]));

    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'release';
    input.dispatchEvent(new Event('input'));

    // Before debounce fires
    expect(mockSearch).not.toHaveBeenCalled();

    // After debounce (300ms)
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSearch).toHaveBeenCalledWith('nts', 'release', { limit: 10 }, expect.anything());
  });

  it('shows dropdown with results including secondary info', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { commit: 'abc123', ordinal: 1, fields: {} },
      { commit: 'def456', ordinal: null, fields: {} },
    ]));

    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'rel';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    const items = dropdown.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('abc123');
    expect(items[0].textContent).not.toContain('#1');  // ordinal not shown
    expect(items[1].textContent).toContain('def456');
  });

  it('navigates on dropdown item click', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { commit: 'abc123', ordinal: 1, fields: {} },
    ]));

    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'rel';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const item = container.querySelector('li') as HTMLElement;
    item.click();

    expect(mockNavigate).toHaveBeenCalledWith('/commits/abc123');
    expect(input.value).toBe('');
  });

  it('calls onSelect instead of navigate when provided', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { commit: 'abc123', ordinal: null, fields: {} },
    ]));

    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts', onSelect });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const item = container.querySelector('li') as HTMLElement;
    item.click();

    expect(onSelect).toHaveBeenCalledWith('abc123');
    expect(mockNavigate).not.toHaveBeenCalled();
    // Input shows the selected value (not cleared)
    expect(input.value).toBe('abc123');
  });

  it('clears input via clear() method', () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const handle = renderCommitSearch(container, { testsuite: 'nts', onSelect });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'some-commit';

    handle.clear();
    expect(input.value).toBe('');
  });

  it('navigates to typed value on Enter', () => {
    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'exact-hash';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(mockNavigate).toHaveBeenCalledWith('/commits/exact-hash');
  });

  it('closes dropdown on Escape', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { commit: 'abc', ordinal: null, fields: {} },
    ]));

    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dropdown.classList.contains('open')).toBe(false);
  });

  it('hides dropdown when input is empty', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSearch).not.toHaveBeenCalled();
    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(false);
  });

  it('hides dropdown when API returns no results', async () => {
    mockSearch.mockResolvedValue(cursorPage([]));

    const container = document.createElement('div');
    document.body.append(container);
    renderCommitSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'nothing';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(false);
  });

  it('destroy() removes document click listener', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = renderCommitSearch(container, { testsuite: 'nts' });

    const spy = vi.spyOn(document, 'removeEventListener');
    handle.destroy();

    expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
  });
});
