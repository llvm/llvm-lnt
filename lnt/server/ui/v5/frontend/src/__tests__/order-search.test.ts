// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing the component
vi.mock('../api', () => ({
  searchOrdersByTag: vi.fn(),
}));
vi.mock('../router', () => ({
  navigate: vi.fn(),
}));

import { renderOrderSearch } from '../components/order-search';
import { searchOrdersByTag } from '../api';
import { navigate } from '../router';

const mockSearch = searchOrdersByTag as ReturnType<typeof vi.fn>;
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

function cursorPage(items: Array<{ fields: Record<string, string>; tag: string | null }>) {
  return { items, cursor: { next: null, previous: null } };
}

describe('renderOrderSearch', () => {
  it('renders an input and dropdown into the container', () => {
    const container = document.createElement('div');
    renderOrderSearch(container, { testsuite: 'nts' });

    expect(container.querySelector('input.order-search-input')).not.toBeNull();
    expect(container.querySelector('ul.order-search-dropdown')).not.toBeNull();
  });

  it('calls searchOrdersByTag after debounce on input', async () => {
    mockSearch.mockResolvedValue(cursorPage([]));

    const container = document.createElement('div');
    document.body.append(container);
    renderOrderSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'release';
    input.dispatchEvent(new Event('input'));

    // Before debounce fires
    expect(mockSearch).not.toHaveBeenCalled();

    // After debounce (300ms)
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSearch).toHaveBeenCalledWith('nts', 'release', { limit: 10 }, expect.anything());
  });

  it('shows dropdown with results including tags', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { fields: { rev: 'abc123' }, tag: 'release-18' },
      { fields: { rev: 'def456' }, tag: null },
    ]));

    const container = document.createElement('div');
    document.body.append(container);
    renderOrderSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'rel';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    const items = dropdown.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('abc123');
    expect(items[0].textContent).toContain('(release-18)');
    expect(items[1].textContent).toContain('def456');
  });

  it('navigates on dropdown item click', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { fields: { rev: 'abc123' }, tag: 'release-18' },
    ]));

    const container = document.createElement('div');
    document.body.append(container);
    renderOrderSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'rel';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const item = container.querySelector('li') as HTMLElement;
    item.click();

    expect(mockNavigate).toHaveBeenCalledWith('/orders/abc123');
    expect(input.value).toBe('');
  });

  it('calls onSelect instead of navigate when provided', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { fields: { rev: 'abc123' }, tag: null },
    ]));

    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    renderOrderSearch(container, { testsuite: 'nts', onSelect });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const item = container.querySelector('li') as HTMLElement;
    item.click();

    expect(onSelect).toHaveBeenCalledWith('abc123');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to typed value on Enter', () => {
    const container = document.createElement('div');
    document.body.append(container);
    renderOrderSearch(container, { testsuite: 'nts' });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'exact-hash';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(mockNavigate).toHaveBeenCalledWith('/orders/exact-hash');
  });

  it('closes dropdown on Escape', async () => {
    mockSearch.mockResolvedValue(cursorPage([
      { fields: { rev: 'abc' }, tag: null },
    ]));

    const container = document.createElement('div');
    document.body.append(container);
    renderOrderSearch(container, { testsuite: 'nts' });

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
    renderOrderSearch(container, { testsuite: 'nts' });

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
    renderOrderSearch(container, { testsuite: 'nts' });

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
    const handle = renderOrderSearch(container, { testsuite: 'nts' });

    const spy = vi.spyOn(document, 'removeEventListener');
    handle.destroy();

    expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
  });
});
