// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderPagination } from '../components/pagination';

describe('renderPagination', () => {
  it('renders Previous and Next buttons', () => {
    const container = document.createElement('div');
    renderPagination(container, {
      hasPrevious: true,
      hasNext: true,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('Previous');
    expect(buttons[1].textContent).toContain('Next');
  });

  it('disables Previous when hasPrevious is false', () => {
    const container = document.createElement('div');
    renderPagination(container, {
      hasPrevious: false,
      hasNext: true,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
    });

    const prevBtn = container.querySelector('button') as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it('disables Next when hasNext is false', () => {
    const container = document.createElement('div');
    renderPagination(container, {
      hasPrevious: true,
      hasNext: false,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
    });

    const buttons = container.querySelectorAll('button');
    const nextBtn = buttons[1] as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('calls onPrevious when Previous is clicked', () => {
    const onPrev = vi.fn();
    const container = document.createElement('div');
    renderPagination(container, {
      hasPrevious: true,
      hasNext: true,
      onPrevious: onPrev,
      onNext: vi.fn(),
    });

    const prevBtn = container.querySelector('button') as HTMLButtonElement;
    prevBtn.click();
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('calls onNext when Next is clicked', () => {
    const onNext = vi.fn();
    const container = document.createElement('div');
    renderPagination(container, {
      hasPrevious: true,
      hasNext: true,
      onPrevious: vi.fn(),
      onNext,
    });

    const buttons = container.querySelectorAll('button');
    (buttons[1] as HTMLButtonElement).click();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('displays range text when provided', () => {
    const container = document.createElement('div');
    renderPagination(container, {
      hasPrevious: false,
      hasNext: true,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      rangeText: '1\u201325 of 100',
    });

    const range = container.querySelector('.pagination-range');
    expect(range).not.toBeNull();
    expect(range!.textContent).toBe('1\u201325 of 100');
  });
});
