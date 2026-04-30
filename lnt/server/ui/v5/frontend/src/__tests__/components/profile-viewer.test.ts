// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderProfileViewer } from '../../components/profile-viewer';
import { realisticFunctionDetail } from '../fixtures/profile-fixtures';
import type { ProfileFunctionDetail } from '../../types';

let container: HTMLElement;

const sampleDetail: ProfileFunctionDetail = {
  name: 'main',
  counters: { cycles: 80.0 },
  disassembly_format: 'raw',
  instructions: [
    { address: 0x1000, counters: { cycles: 50.0, 'branch-misses': 5.0 }, text: 'push rbp' },
    { address: 0x1004, counters: { cycles: 30.0, 'branch-misses': 3.0 }, text: 'mov rsp, rbp' },
    { address: 0x1008, counters: { cycles: 20.0, 'branch-misses': 2.0 }, text: 'ret' },
  ],
};

beforeEach(() => {
  container = document.createElement('div');
});

describe('renderProfileViewer — basic rendering', () => {
  it('renders a table with 3 columns', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });

    const ths = container.querySelectorAll('thead th');
    expect(ths).toHaveLength(3);
    expect(ths[0].textContent).toBe('cycles');
    expect(ths[1].textContent).toBe('Address');
    expect(ths[2].textContent).toBe('Instruction');
  });

  it('renders one row per instruction', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
  });

  it('renders hex addresses', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });

    const dataCells = container.querySelectorAll('tbody .profile-disasm-addr');
    expect(dataCells[0].textContent).toBe('0x1000');
    expect(dataCells[1].textContent).toBe('0x1004');
    expect(dataCells[2].textContent).toBe('0x1008');
  });

  it('renders instruction text', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });

    const textCells = container.querySelectorAll('tbody .profile-disasm-text');
    expect(textCells[0].textContent).toBe('push rbp');
    expect(textCells[1].textContent).toBe('mov rsp, rbp');
    expect(textCells[2].textContent).toBe('ret');
  });
});

describe('renderProfileViewer — heat-map', () => {
  it('applies background color to counter value cells', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });

    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat') as NodeListOf<HTMLElement>;
    expect(heatCells).toHaveLength(3);
    // All should have a background-color set
    for (const cell of heatCells) {
      expect(cell.style.backgroundColor).toBeTruthy();
    }
  });

  it('uses white for zero-value instructions', () => {
    const detail: ProfileFunctionDetail = {
      name: 'fn',
      counters: {},
      disassembly_format: 'raw',
      instructions: [
        { address: 0, counters: { cycles: 0 }, text: 'nop' },
        { address: 1, counters: { cycles: 100 }, text: 'add' },
      ],
    };
    renderProfileViewer(container, detail, { counter: 'cycles', displayMode: 'absolute' });

    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat') as NodeListOf<HTMLElement>;
    // The zero-value cell should be white (255,255,255)
    expect(heatCells[0].style.backgroundColor).toBe('rgb(255, 255, 255)');
  });
});

describe('renderProfileViewer — display modes', () => {
  it('relative mode shows percentages', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });

    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat');
    // Total = 50 + 30 + 20 = 100. First = 50/100 * 100 = 50.0%
    expect(heatCells[0].textContent).toBe('50.0%');
    expect(heatCells[1].textContent).toBe('30.0%');
    expect(heatCells[2].textContent).toBe('20.0%');
  });

  it('absolute mode shows raw values', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'absolute' });

    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat');
    expect(heatCells[0].textContent).toBe('50.0');
    expect(heatCells[1].textContent).toBe('30.0');
    expect(heatCells[2].textContent).toBe('20.0');
  });

  it('cumulative mode shows running sum', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'cumulative' });

    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat');
    expect(heatCells[0].textContent).toBe('50.0');
    expect(heatCells[1].textContent).toBe('80.0');  // 50 + 30
    expect(heatCells[2].textContent).toBe('100.0'); // 50 + 30 + 20
  });
});

describe('renderProfileViewer — row cap', () => {
  it('caps at 500 rows for large functions', () => {
    const instructions = Array.from({ length: 600 }, (_, i) => ({
      address: i,
      counters: { cycles: 1.0 },
      text: `inst_${i}`,
    }));
    const detail: ProfileFunctionDetail = {
      name: 'big_fn',
      counters: {},
      disassembly_format: 'raw',
      instructions,
    };

    renderProfileViewer(container, detail, { counter: 'cycles', displayMode: 'absolute' });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(500);

    const capMsg = container.querySelector('.profile-row-cap');
    expect(capMsg).toBeTruthy();
    expect(capMsg?.textContent).toContain('Showing 500 of 600');
  });

  it('"Show all" button renders all rows', () => {
    const instructions = Array.from({ length: 600 }, (_, i) => ({
      address: i,
      counters: { cycles: 1.0 },
      text: `inst_${i}`,
    }));
    const detail: ProfileFunctionDetail = {
      name: 'big_fn',
      counters: {},
      disassembly_format: 'raw',
      instructions,
    };

    renderProfileViewer(container, detail, { counter: 'cycles', displayMode: 'absolute' });

    const btn = container.querySelector('.profile-row-cap button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(600);
    expect(container.querySelector('.profile-row-cap')).toBeNull();
  });

  it('does not show cap for small functions', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'absolute' });

    expect(container.querySelector('.profile-row-cap')).toBeNull();
  });
});

describe('renderProfileViewer — edge cases', () => {
  it('renders empty table for no instructions', () => {
    const detail: ProfileFunctionDetail = {
      name: 'empty_fn',
      counters: {},
      disassembly_format: 'raw',
      instructions: [],
    };

    renderProfileViewer(container, detail, { counter: 'cycles', displayMode: 'relative' });

    expect(container.querySelector('.no-results')?.textContent).toBe('No instructions.');
    expect(container.querySelector('table')).toBeNull();
  });

  it('single instruction renders correctly', () => {
    const detail: ProfileFunctionDetail = {
      name: 'one',
      counters: {},
      disassembly_format: 'raw',
      instructions: [{ address: 42, counters: { cycles: 100 }, text: 'ret' }],
    };

    renderProfileViewer(container, detail, { counter: 'cycles', displayMode: 'relative' });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    // 100/100 * 100 = 100.0%
    expect(rows[0].querySelector('.profile-disasm-heat')?.textContent).toBe('100.0%');
  });

  it('missing counter shows 0', () => {
    renderProfileViewer(container, sampleDetail, { counter: 'nonexistent', displayMode: 'absolute' });

    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat');
    expect(heatCells[0].textContent).toBe('0.0');
  });

  it('destroy() is callable without error', () => {
    const { destroy } = renderProfileViewer(container, sampleDetail, { counter: 'cycles', displayMode: 'relative' });
    expect(() => destroy()).not.toThrow();
  });
});

describe('renderProfileViewer — realistic data', () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.createElement('div'); });

  it('renders realistic x86-64 function with 48 instructions', () => {
    renderProfileViewer(container, realisticFunctionDetail, { counter: 'cycles', displayMode: 'relative' });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(48);

    // The call instruction at 0x40102d has the highest cycles (18.2 out of ~34.2 total).
    // In relative mode, this is ~53.2% — the hottest instruction.
    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat') as NodeListOf<HTMLElement>;
    // Find the cell with the highest percentage value
    let maxPctCell: HTMLElement | null = null;
    let maxPct = 0;
    for (const cell of heatCells) {
      const pct = parseFloat(cell.textContent || '0');
      if (pct > maxPct) { maxPct = pct; maxPctCell = cell; }
    }
    expect(maxPctCell).toBeTruthy();
    expect(maxPct).toBeGreaterThan(40); // should be ~53%
    expect(maxPctCell!.style.backgroundColor).not.toBe('rgb(255, 255, 255)');

    // Address column has realistic hex addresses
    const addrCells = container.querySelectorAll('tbody .profile-disasm-addr');
    expect(addrCells[0].textContent).toBe('0x401000');
    expect(addrCells[addrCells.length - 1].textContent).toBe('0x4010b4');

    // Instruction text has real x86-64 mnemonics
    const textCells = container.querySelectorAll('tbody .profile-disasm-text');
    expect(textCells[0].textContent).toBe('push   rbp');
    expect(textCells[1].textContent).toBe('mov    rbp, rsp');
  });

  it('renders all 4 counters correctly in absolute mode', () => {
    renderProfileViewer(container, realisticFunctionDetail, { counter: 'cache-misses', displayMode: 'absolute' });

    // The hottest cache-miss instruction is the call at 0x40102d with 22.1
    const heatCells = container.querySelectorAll('tbody .profile-disasm-heat');
    const values = Array.from(heatCells).map(c => parseFloat(c.textContent || '0'));
    const max = Math.max(...values);
    expect(max).toBeCloseTo(22.1, 0);
  });
});
