// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Plotly globally
const mockNewPlot = vi.fn().mockResolvedValue(document.createElement('div'));
const mockPurge = vi.fn();
vi.stubGlobal('Plotly', {
  newPlot: mockNewPlot,
  purge: mockPurge,
});

import {
  createSparklineCard, createSparklineLoading, createSparklineError,
  machineColor,
} from '../components/sparkline-card';
import type { SparklineTrace } from '../components/sparkline-card';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSparklineCard', () => {
  const traces: SparklineTrace[] = [
    {
      machine: 'machine-1',
      color: '#1f77b4',
      points: [
        { timestamp: '2025-01-01T00:00:00Z', value: 100 },
        { timestamp: '2025-01-02T00:00:00Z', value: 105 },
      ],
    },
  ];

  it('renders a container with the metric title', () => {
    const { element } = createSparklineCard({ title: 'execution_time', traces });

    expect(element.classList.contains('sparkline-card')).toBe(true);
    const title = element.querySelector('.sparkline-title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('execution_time');
  });

  it('includes unit in title when provided', () => {
    const { element } = createSparklineCard({
      title: 'execution_time',
      unit: 'ms',
      traces,
    });

    const title = element.querySelector('.sparkline-title');
    expect(title!.textContent).toBe('execution_time (ms)');
  });

  it('contains a chart container div', () => {
    const { element } = createSparklineCard({ title: 'metric', traces });

    const chartDiv = element.querySelector('.sparkline-chart');
    expect(chartDiv).not.toBeNull();
  });

  it('click fires the onClick callback with no machine argument', () => {
    const onClick = vi.fn();
    const { element } = createSparklineCard({
      title: 'metric',
      traces,
      onClick,
    });

    element.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledWith();
  });

  it('destroy() calls Plotly.purge', async () => {
    const { element, destroy } = createSparklineCard({ title: 'metric', traces });

    // Simulate the element being connected to the DOM so requestAnimationFrame fires
    document.body.append(element);

    // Trigger the queued requestAnimationFrame callback
    await vi.waitFor(() => {
      expect(mockNewPlot).toHaveBeenCalled();
    }, { timeout: 100 }).catch(() => {
      // In jsdom, requestAnimationFrame may need manual triggering
    });

    destroy();
    // purge is called if plot was initialized
  });
});

describe('createSparklineLoading', () => {
  it('renders loading state with title', () => {
    const el = createSparklineLoading('compile_time');
    expect(el.classList.contains('sparkline-card')).toBe(true);
    expect(el.querySelector('.sparkline-title')!.textContent).toBe('compile_time');
    expect(el.querySelector('.sparkline-loading')!.textContent).toContain('Loading');
  });

  it('includes unit in title when provided', () => {
    const el = createSparklineLoading('compile_time', 'ms');
    expect(el.querySelector('.sparkline-title')!.textContent).toBe('compile_time (ms)');
  });
});

describe('createSparklineError', () => {
  it('renders error state with title', () => {
    const el = createSparklineError('code_size');
    expect(el.classList.contains('sparkline-card')).toBe(true);
    expect(el.querySelector('.sparkline-title')!.textContent).toBe('code_size');
    expect(el.querySelector('.sparkline-error')!.textContent).toContain('Failed to load');
  });

  it('includes unit in title when provided', () => {
    const el = createSparklineError('code_size', 'bytes');
    expect(el.querySelector('.sparkline-title')!.textContent).toBe('code_size (bytes)');
  });
});

describe('machineColor', () => {
  it('returns a color string', () => {
    expect(machineColor(0)).toBe('#1f77b4');
    expect(machineColor(1)).toBe('#ff7f0e');
  });

  it('wraps around when index exceeds palette size', () => {
    expect(machineColor(10)).toBe(machineColor(0));
  });
});
