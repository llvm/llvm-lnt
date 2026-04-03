// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the router's navigate before importing nav
vi.mock('../router', () => ({
  navigate: vi.fn(),
}));

import { renderNav, updateActiveNavLink } from '../components/nav';
import { navigate } from '../router';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  // Provide localStorage stub
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
  });
});

describe('renderNav', () => {
  const config = {
    testsuite: 'nts',
    testsuites: ['nts', 'compile'],
    v4Url: '/db_default/v4/nts/recent_activity',
    urlBase: '',
  };

  it('renders all expected navigation links', () => {
    const nav = renderNav(config);
    const links = nav.querySelectorAll('.v5-nav-link[data-path]');
    const labels = Array.from(links).map(l => l.textContent);
    expect(labels).toEqual(['Dashboard', 'Graph', 'Compare', 'Regressions', 'Machines', 'Admin']);
  });

  it('renders the LNT brand', () => {
    const nav = renderNav(config);
    const brand = nav.querySelector('.v5-nav-brand');
    expect(brand?.textContent).toBe('LNT');
  });

  it('renders suite selector with correct options', () => {
    const nav = renderNav(config);
    const select = nav.querySelector('.v5-nav-suite-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const options = Array.from(select.options);
    expect(options.map(o => o.value)).toEqual(['nts', 'compile']);
    expect(select.value).toBe('nts');
  });

  it('renders v4 UI link', () => {
    const nav = renderNav(config);
    const v4Link = Array.from(nav.querySelectorAll('.v5-nav-link'))
      .find(l => l.textContent === 'v4 UI') as HTMLAnchorElement;
    expect(v4Link).toBeTruthy();
    expect(v4Link.href).toContain('/db_default/v4/nts/recent_activity');
  });

  it('clicking a nav link calls navigate()', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const machinesLink = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Machines') as HTMLAnchorElement;
    expect(machinesLink).toBeTruthy();

    machinesLink.click();
    expect(navigate).toHaveBeenCalledWith('/machines');
  });

  it('clicking brand calls navigate("/")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    brand.click();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('renders Settings link', () => {
    const nav = renderNav(config);
    const settingsLink = Array.from(nav.querySelectorAll('.v5-nav-link'))
      .find(l => l.textContent === 'Settings');
    expect(settingsLink).toBeTruthy();
  });
});

describe('updateActiveNavLink', () => {
  const config = {
    testsuite: 'nts',
    testsuites: ['nts'],
    v4Url: '#',
    urlBase: '',
  };

  it('highlights Dashboard for root path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/');

    const dashLink = document.querySelector('[data-path="/"]');
    expect(dashLink?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('highlights Machines for /machines path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/machines');

    const machinesLink = document.querySelector('[data-path="/machines"]');
    expect(machinesLink?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('highlights Machines for /machines/foo sub-path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/machines/foo');

    const machinesLink = document.querySelector('[data-path="/machines"]');
    expect(machinesLink?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('does not highlight Dashboard for non-root paths', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/machines');

    const dashLink = document.querySelector('[data-path="/"]');
    expect(dashLink?.classList.contains('v5-nav-link-active')).toBe(false);
  });

  it('clears previous active link when path changes', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/machines');
    updateActiveNavLink('/graph');

    const machinesLink = document.querySelector('[data-path="/machines"]');
    const graphLink = document.querySelector('[data-path="/graph"]');
    expect(machinesLink?.classList.contains('v5-nav-link-active')).toBe(false);
    expect(graphLink?.classList.contains('v5-nav-link-active')).toBe(true);
  });
});
