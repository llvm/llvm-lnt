// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPlotlyData, createTimeSeriesChart } from '../components/time-series-chart';
import type { TimeSeriesTrace, PinnedBaseline, TimeSeriesChartOptions, ChartHandle } from '../components/time-series-chart';
import { TRACE_SEP } from '../pages/graph';

function makeTrace(name: string, points: Array<{ orderValue: string; value: number }>, machine = 'm1'): TimeSeriesTrace {
  return {
    testName: name,
    machine,
    points: points.map(p => ({ ...p, runCount: 1, timestamp: null })),
  };
}

describe('buildPlotlyData', () => {
  it('builds one Plotly trace per test', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [
        makeTrace('test-A', [{ orderValue: '100', value: 1.5 }, { orderValue: '101', value: 2.0 }]),
        makeTrace('test-B', [{ orderValue: '100', value: 3.0 }]),
      ],
      yAxisLabel: 'exec_time',
    };

    const { data } = buildPlotlyData(opts);
    expect(data).toHaveLength(2);
    const trace0 = data[0] as { x: string[]; y: number[]; name: string };
    expect(trace0.name).toBe(`test-A${TRACE_SEP}m1`);
    expect(trace0.x).toEqual(['100', '101']);
    expect(trace0.y).toEqual([1.5, 2.0]);
  });

  it('sets x-axis to category type', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('t', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    };

    const { layout } = buildPlotlyData(opts);
    expect((layout as { xaxis: { type: string } }).xaxis.type).toBe('category');
  });

  it('includes customdata for hover template', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('test-A', [{ orderValue: '100', value: 1.5 }])],
      yAxisLabel: 'metric',
    };

    const { data } = buildPlotlyData(opts);
    const trace = data[0] as { customdata: string[][] };
    expect(trace.customdata[0][0]).toBe('100');             // orderValue
    expect(trace.customdata[0][1]).toBe(`test-A${TRACE_SEP}m1`);     // traceName
    expect(trace.customdata[0][4]).toBe('test-A');          // testName
    expect(trace.customdata[0][5]).toBe('m1');              // machine
  });

  it('generates reference order traces with hover', () => {
    const refValues = new Map<string, number>();
    refValues.set('test-A', 2.5);

    const mainTrace = makeTrace('test-A', [{ orderValue: '100', value: 1.5 }, { orderValue: '102', value: 2.0 }]);
    mainTrace.color = '#1f77b4';
    const opts: TimeSeriesChartOptions = {
      traces: [mainTrace],
      yAxisLabel: 'metric',
      baselines: [{
        label: '101 (release-18)',
        tag: 'release-18',
        values: refValues,
      }],
    };

    const { data } = buildPlotlyData(opts);
    // 1 main trace + 1 reference trace
    expect(data).toHaveLength(2);
    const refTrace = data[1] as {
      x: string[]; y: number[]; mode: string;
      line: { dash: string; color: string };
      showlegend: boolean; hovertemplate: string;
    };
    expect(refTrace.y).toEqual([2.5, 2.5]);
    expect(refTrace.mode).toBe('lines');
    expect(refTrace.line.dash).toBe('dot');
    expect(refTrace.line.color).toBe('#1f77b4');
    expect(refTrace.showlegend).toBe(false);
    expect(refTrace.hovertemplate).toContain('Baseline: 101 (release-18)');
    expect(refTrace.hovertemplate).toContain('test-A');
    expect(refTrace.hovertemplate).toContain('2.500');
  });

  it('HTML-escapes user-controlled values in baseline hover templates', () => {
    const refValues = new Map<string, number>();
    refValues.set('<script>alert("xss")</script>', 3.0);

    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('<script>alert("xss")</script>', [{ orderValue: '100', value: 1.5 }])],
      yAxisLabel: 'metric',
      baselines: [{
        label: '101 (<img onerror=alert(1)>)',
        tag: '<img onerror=alert(1)>',
        values: refValues,
      }],
    };

    const { data } = buildPlotlyData(opts);
    const refTrace = data[1] as { hovertemplate: string };
    // Verify that HTML special characters are escaped
    expect(refTrace.hovertemplate).not.toContain('<script>');
    expect(refTrace.hovertemplate).not.toContain('<img');
    expect(refTrace.hovertemplate).toContain('&lt;script&gt;');
    expect(refTrace.hovertemplate).toContain('&lt;img onerror=alert(1)&gt;');
  });

  it('uses all scaffold categories for reference trace x-values', () => {
    const refValues = new Map<string, number>();
    refValues.set('test-A', 2.5);

    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('test-A', [{ orderValue: '102', value: 1.5 }, { orderValue: '103', value: 2.0 }])],
      yAxisLabel: 'metric',
      categoryOrder: ['100', '101', '102', '103', '104', '105'],
      baselines: [{
        label: '101',
        tag: null,
        values: refValues,
      }],
    };

    const { data } = buildPlotlyData(opts);
    const refTrace = data[1] as { x: string[]; y: number[] };
    // x-values include every scaffold category (for hover detection along the line)
    expect(refTrace.x).toEqual(['100', '101', '102', '103', '104', '105']);
    expect(refTrace.y).toEqual([2.5, 2.5, 2.5, 2.5, 2.5, 2.5]);
  });

  it('skips reference traces for tests not in traces', () => {
    const refValues = new Map<string, number>();
    refValues.set('nonexistent-test', 5.0);

    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('test-A', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
      baselines: [{
        label: '100',
        tag: null,
        values: refValues,
      }],
    };

    const { data } = buildPlotlyData(opts);
    // Only the main trace, no reference trace (test not found)
    expect(data).toHaveLength(1);
  });

  it('hides legend when only one trace', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('t', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    };

    const { layout } = buildPlotlyData(opts);
    expect((layout as { showlegend: boolean }).showlegend).toBe(false);
  });

  it('sets categoryarray when categoryOrder is provided', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('t', [{ orderValue: '102', value: 1.0 }])],
      yAxisLabel: 'metric',
      categoryOrder: ['100', '101', '102', '103'],
    };

    const { layout } = buildPlotlyData(opts);
    const xaxis = (layout as { xaxis: Record<string, unknown> }).xaxis;
    expect(xaxis.categoryorder).toBe('array');
    expect(xaxis.categoryarray).toEqual(['100', '101', '102', '103']);
  });

  it('does not set categoryarray when categoryOrder is omitted', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [makeTrace('t', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    };

    const { layout } = buildPlotlyData(opts);
    const xaxis = (layout as { xaxis: Record<string, unknown> }).xaxis;
    expect(xaxis.categoryorder).toBeUndefined();
    expect(xaxis.categoryarray).toBeUndefined();
  });

  it('always hides built-in legend (replaced by legend table)', () => {
    const opts: TimeSeriesChartOptions = {
      traces: [
        makeTrace('t1', [{ orderValue: '100', value: 1.0 }]),
        makeTrace('t2', [{ orderValue: '100', value: 2.0 }]),
      ],
      yAxisLabel: 'metric',
    };

    const { layout } = buildPlotlyData(opts);
    expect((layout as { showlegend: boolean }).showlegend).toBe(false);
  });
});

// ===========================================================================
// createTimeSeriesChart
// ===========================================================================

describe('createTimeSeriesChart', () => {
  let mockNewPlot: ReturnType<typeof vi.fn>;
  let mockReact: ReturnType<typeof vi.fn>;
  let mockPurge: ReturnType<typeof vi.fn>;
  let mockRestyle: ReturnType<typeof vi.fn>;
  let mockAddTraces: ReturnType<typeof vi.fn>;
  let mockDeleteTraces: ReturnType<typeof vi.fn>;
  let mockRelayout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock Plotly on globalThis
    const mockGd = document.createElement('div');
    (mockGd as unknown as { on: ReturnType<typeof vi.fn> }).on = vi.fn();

    mockNewPlot = vi.fn().mockResolvedValue(mockGd);
    mockReact = vi.fn().mockResolvedValue(mockGd);
    mockPurge = vi.fn();
    mockRestyle = vi.fn();
    mockAddTraces = vi.fn();
    mockDeleteTraces = vi.fn();
    mockRelayout = vi.fn();

    vi.stubGlobal('Plotly', {
      newPlot: mockNewPlot,
      react: mockReact,
      purge: mockPurge,
      restyle: mockRestyle,
      addTraces: mockAddTraces,
      deleteTraces: mockDeleteTraces,
      relayout: mockRelayout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls Plotly.newPlot on creation', () => {
    const container = document.createElement('div');
    createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    });

    expect(mockNewPlot).toHaveBeenCalledTimes(1);
    expect(mockReact).not.toHaveBeenCalled();
  });

  it('calls Plotly.react on update()', async () => {
    const container = document.createElement('div');
    const handle = createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    });

    handle.update({
      traces: [makeTrace('t1', [{ orderValue: '100', value: 2.0 }])],
      yAxisLabel: 'metric',
    });

    // react() is chained after newPlot() resolves — flush microtasks
    await new Promise(r => setTimeout(r, 0));

    expect(mockNewPlot).toHaveBeenCalledTimes(1);
    expect(mockReact).toHaveBeenCalledTimes(1);
  });

  it('calls Plotly.purge on destroy()', () => {
    const container = document.createElement('div');
    const handle = createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    });

    handle.destroy();

    expect(mockPurge).toHaveBeenCalledTimes(1);
  });

  it('shows "No data to plot" for zero traces', () => {
    const container = document.createElement('div');
    createTimeSeriesChart(container, {
      traces: [],
      yAxisLabel: 'metric',
    });

    expect(container.textContent).toContain('No data to plot');
    expect(mockNewPlot).not.toHaveBeenCalled();
  });

  it('replaces "No data" message with chart on update with data', () => {
    const container = document.createElement('div');
    const handle = createTimeSeriesChart(container, {
      traces: [],
      yAxisLabel: 'metric',
    });

    handle.update({
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    });

    expect(mockNewPlot).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.graph-chart')).not.toBeNull();
  });

  it('preserves x-axis range on update()', async () => {
    const container = document.createElement('div');

    // Mock newPlot to set .layout on the chart div (simulating Plotly behavior)
    mockNewPlot.mockImplementation((div: HTMLElement) => {
      (div as unknown as { layout: unknown }).layout = {
        xaxis: { range: [10, 50], autorange: false },
        yaxis: { autorange: true },
      };
      const gd = div as unknown as { on: ReturnType<typeof vi.fn> };
      gd.on = vi.fn();
      return Promise.resolve(div);
    });

    const handle = createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
      categoryOrder: ['100', '101', '102'],
    });

    handle.update({
      traces: [makeTrace('t1', [{ orderValue: '100', value: 2.0 }, { orderValue: '101', value: 3.0 }])],
      yAxisLabel: 'metric',
      categoryOrder: ['100', '101', '102'],
    });

    await new Promise(r => setTimeout(r, 0));

    expect(mockReact).toHaveBeenCalledTimes(1);
    const layout = mockReact.mock.calls[0][2] as { xaxis: { range: unknown; autorange: unknown } };
    expect(layout.xaxis.range).toEqual([10, 50]);
    expect(layout.xaxis.autorange).toBe(false);
  });

  it('preserves y-axis range when user has zoomed (autorange=false)', async () => {
    const container = document.createElement('div');

    mockNewPlot.mockImplementation((div: HTMLElement) => {
      (div as unknown as { layout: unknown }).layout = {
        xaxis: { range: [-0.5, 2.5], autorange: false },
        yaxis: { range: [1.0, 5.0], autorange: false },
      };
      const gd = div as unknown as { on: ReturnType<typeof vi.fn> };
      gd.on = vi.fn();
      return Promise.resolve(div);
    });

    const handle = createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    });

    handle.update({
      traces: [makeTrace('t1', [{ orderValue: '100', value: 2.0 }])],
      yAxisLabel: 'metric',
    });

    await new Promise(r => setTimeout(r, 0));

    const layout = mockReact.mock.calls[0][2] as { yaxis: { range: unknown; autorange: unknown } };
    expect(layout.yaxis.range).toEqual([1.0, 5.0]);
    expect(layout.yaxis.autorange).toBe(false);
  });

  it('does not set y-axis range when autorange is true (no user zoom)', async () => {
    const container = document.createElement('div');

    mockNewPlot.mockImplementation((div: HTMLElement) => {
      (div as unknown as { layout: unknown }).layout = {
        xaxis: { range: [-0.5, 2.5], autorange: false },
        yaxis: { autorange: true },
      };
      const gd = div as unknown as { on: ReturnType<typeof vi.fn> };
      gd.on = vi.fn();
      return Promise.resolve(div);
    });

    const handle = createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
    });

    handle.update({
      traces: [makeTrace('t1', [{ orderValue: '100', value: 2.0 }])],
      yAxisLabel: 'metric',
    });

    await new Promise(r => setTimeout(r, 0));

    const layout = mockReact.mock.calls[0][2] as { yaxis: { range?: unknown; autorange?: unknown } };
    // yaxis should NOT have an explicit range — let Plotly auto-range
    expect(layout.yaxis.autorange).toBeUndefined();
    expect(layout.yaxis.range).toBeUndefined();
  });

  it('does not set explicit ranges after zoom reset (autorange=true on both axes)', async () => {
    const container = document.createElement('div');

    mockNewPlot.mockImplementation((div: HTMLElement) => {
      // Simulate state after double-click zoom reset
      (div as unknown as { layout: unknown }).layout = {
        xaxis: { range: [-0.5, 2.5], autorange: true },
        yaxis: { autorange: true },
      };
      const gd = div as unknown as { on: ReturnType<typeof vi.fn> };
      gd.on = vi.fn();
      return Promise.resolve(div);
    });

    const handle = createTimeSeriesChart(container, {
      traces: [makeTrace('t1', [{ orderValue: '100', value: 1.0 }])],
      yAxisLabel: 'metric',
      categoryOrder: ['100', '101', '102'],
    });

    handle.update({
      traces: [makeTrace('t1', [{ orderValue: '100', value: 2.0 }])],
      yAxisLabel: 'metric',
      categoryOrder: ['100', '101', '102'],
    });

    await new Promise(r => setTimeout(r, 0));

    const layout = mockReact.mock.calls[0][2] as {
      xaxis: { range: unknown; autorange: unknown };
      yaxis: { range?: unknown; autorange?: unknown };
    };
    // X-axis preserves whatever Plotly has (autorange=true from double-click)
    expect(layout.xaxis.autorange).toBe(true);
    // Y-axis should not have explicit range
    expect(layout.yaxis.autorange).toBeUndefined();
    expect(layout.yaxis.range).toBeUndefined();
  });

  it('hoverTrace() calls restyle to emphasize one trace and dim others', async () => {
    const container = document.createElement('div');
    const handle = createTimeSeriesChart(container, {
      traces: [
        makeTrace('test-A', [{ orderValue: '100', value: 1.0 }]),
        makeTrace('test-B', [{ orderValue: '100', value: 2.0 }]),
        makeTrace('test-C', [{ orderValue: '100', value: 3.0 }]),
      ],
      yAxisLabel: 'metric',
    });

    // Wait for newPlot to resolve
    await new Promise(r => setTimeout(r, 0));

    handle.hoverTrace(`test-B${TRACE_SEP}m1`);
    await new Promise(r => setTimeout(r, 0));

    // First call: dim all 3 traces
    expect(mockRestyle).toHaveBeenCalledTimes(2);
    expect(mockRestyle.mock.calls[0][1]).toEqual({ opacity: 0.2, 'line.width': 1.5 });
    expect(mockRestyle.mock.calls[0][2]).toEqual([0, 1, 2]);
    // Second call: emphasize trace index 1 (test-B)
    expect(mockRestyle.mock.calls[1][1]).toEqual({ opacity: 1.0, 'line.width': 3 });
    expect(mockRestyle.mock.calls[1][2]).toEqual([1]);
  });

  it('hoverTrace(null) restores all traces to normal', async () => {
    const container = document.createElement('div');
    const handle = createTimeSeriesChart(container, {
      traces: [
        makeTrace('test-A', [{ orderValue: '100', value: 1.0 }]),
        makeTrace('test-B', [{ orderValue: '100', value: 2.0 }]),
      ],
      yAxisLabel: 'metric',
    });

    await new Promise(r => setTimeout(r, 0));

    handle.hoverTrace(null);
    await new Promise(r => setTimeout(r, 0));

    expect(mockRestyle).toHaveBeenCalledTimes(1);
    expect(mockRestyle.mock.calls[0][1]).toEqual({ opacity: 1.0, 'line.width': 1.5 });
    expect(mockRestyle.mock.calls[0][2]).toEqual([0, 1]);
  });

  it('hoverTrace() dims reference-order traces along with non-hovered main traces', async () => {
    const container = document.createElement('div');
    const refValues = new Map<string, number>();
    refValues.set('test-A', 5.0);

    const handle = createTimeSeriesChart(container, {
      traces: [
        makeTrace('test-A', [{ orderValue: '100', value: 1.0 }]),
        makeTrace('test-B', [{ orderValue: '100', value: 2.0 }]),
      ],
      yAxisLabel: 'metric',
      baselines: [{
        label: '100', tag: null, values: refValues,
      }],
    });

    await new Promise(r => setTimeout(r, 0));

    handle.hoverTrace(`test-A${TRACE_SEP}m1`);
    await new Promise(r => setTimeout(r, 0));

    // 2 main traces + 1 reference trace = 3 total
    expect(mockRestyle.mock.calls[0][1]).toEqual({ opacity: 0.2, 'line.width': 1.5 });
    expect(mockRestyle.mock.calls[0][2]).toEqual([0, 1, 2]);
    // Emphasize only trace 0 (test-A · m1)
    expect(mockRestyle.mock.calls[1][1]).toEqual({ opacity: 1.0, 'line.width': 3 });
    expect(mockRestyle.mock.calls[1][2]).toEqual([0]);
  });

  it('shows scatter trace on hover when getRawValues returns >1 values', async () => {
    const container = document.createElement('div');
    // Capture the gd.on handlers
    const handlers = new Map<string, Function>();
    const mockGd = document.createElement('div');
    (mockGd as unknown as { on: ReturnType<typeof vi.fn> }).on = vi.fn(
      (evt: string, cb: Function) => { handlers.set(evt, cb); },
    );
    mockNewPlot.mockResolvedValue(mockGd);

    createTimeSeriesChart(container, {
      traces: [
        { testName: 'test-A', machine: 'm1', color: '#1f77b4', points: [{ orderValue: '100', value: 2.0, runCount: 3, timestamp: null }] },
      ],
      yAxisLabel: 'metric',
      getRawValues: (_test, _machine, _order) => [1.0, 2.0, 3.0],
    });

    await new Promise(r => setTimeout(r, 0));

    // Simulate hover
    const hoverHandler = handlers.get('plotly_hover');
    expect(hoverHandler).toBeDefined();
    hoverHandler!({ points: [{ customdata: ['100', `test-A${TRACE_SEP}m1`, '2.000', '3', 'test-A', 'm1'], curveNumber: 0, pointNumber: 0 }] });
    await new Promise(r => setTimeout(r, 0));

    expect(mockAddTraces).toHaveBeenCalledTimes(1);
    const scatter = mockAddTraces.mock.calls[0][1];
    expect(scatter.x).toEqual(['100', '100', '100']);
    expect(scatter.y).toEqual([1.0, 2.0, 3.0]);
    expect(scatter.mode).toBe('markers');
    expect(scatter.marker.color).toBe('#1f77b4');
    expect(scatter.marker.opacity).toBe(0.3);
    expect(scatter.showlegend).toBe(false);
    expect(scatter.hoverinfo).toBe('skip');
  });

  it('does not show scatter when getRawValues returns <=1 values', async () => {
    const container = document.createElement('div');
    const handlers = new Map<string, Function>();
    const mockGd = document.createElement('div');
    (mockGd as unknown as { on: ReturnType<typeof vi.fn> }).on = vi.fn(
      (evt: string, cb: Function) => { handlers.set(evt, cb); },
    );
    mockNewPlot.mockResolvedValue(mockGd);

    createTimeSeriesChart(container, {
      traces: [
        { testName: 'test-A', machine: 'm1', color: '#1f77b4', points: [{ orderValue: '100', value: 1.0, runCount: 1, timestamp: null }] },
      ],
      yAxisLabel: 'metric',
      getRawValues: () => [1.0],
    });

    await new Promise(r => setTimeout(r, 0));

    handlers.get('plotly_hover')!({ points: [{ customdata: ['100', `test-A${TRACE_SEP}m1`, '1.000', '1', 'test-A', 'm1'], curveNumber: 0, pointNumber: 0 }] });
    await new Promise(r => setTimeout(r, 0));

    expect(mockAddTraces).not.toHaveBeenCalled();
  });

  it('removes scatter trace on unhover', async () => {
    const container = document.createElement('div');
    const handlers = new Map<string, Function>();
    const mockGd = document.createElement('div');
    (mockGd as unknown as { on: ReturnType<typeof vi.fn> }).on = vi.fn(
      (evt: string, cb: Function) => { handlers.set(evt, cb); },
    );
    mockNewPlot.mockResolvedValue(mockGd);

    createTimeSeriesChart(container, {
      traces: [
        { testName: 'test-A', machine: 'm1', color: '#1f77b4', points: [{ orderValue: '100', value: 2.0, runCount: 3, timestamp: null }] },
      ],
      yAxisLabel: 'metric',
      getRawValues: () => [1.0, 2.0, 3.0],
    });

    await new Promise(r => setTimeout(r, 0));

    // Hover to add scatter
    handlers.get('plotly_hover')!({ points: [{ customdata: ['100', `test-A${TRACE_SEP}m1`, '2.000', '3', 'test-A', 'm1'], curveNumber: 0, pointNumber: 0 }] });
    await new Promise(r => setTimeout(r, 0));
    expect(mockAddTraces).toHaveBeenCalledTimes(1);

    // Unhover to remove scatter
    handlers.get('plotly_unhover')!();
    await new Promise(r => setTimeout(r, 0));
    expect(mockDeleteTraces).toHaveBeenCalledTimes(1);
    expect(mockDeleteTraces.mock.calls[0][1]).toEqual([-1]);
  });

  it('does not add scatter when getRawValues is not provided', async () => {
    const container = document.createElement('div');
    const handlers = new Map<string, Function>();
    const mockGd = document.createElement('div');
    (mockGd as unknown as { on: ReturnType<typeof vi.fn> }).on = vi.fn(
      (evt: string, cb: Function) => { handlers.set(evt, cb); },
    );
    mockNewPlot.mockResolvedValue(mockGd);

    createTimeSeriesChart(container, {
      traces: [
        { testName: 'test-A', machine: 'm1', color: '#1f77b4', points: [{ orderValue: '100', value: 2.0, runCount: 3, timestamp: null }] },
      ],
      yAxisLabel: 'metric',
      // no getRawValues
    });

    await new Promise(r => setTimeout(r, 0));

    handlers.get('plotly_hover')!({ points: [{ customdata: ['100', `test-A${TRACE_SEP}m1`, '2.000', '3', 'test-A', 'm1'], curveNumber: 0, pointNumber: 0 }] });
    await new Promise(r => setTimeout(r, 0));

    expect(mockAddTraces).not.toHaveBeenCalled();
  });
});
