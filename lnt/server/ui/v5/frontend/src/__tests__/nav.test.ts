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

// --- Suite-agnostic context (no testsuite) ---

describe('renderNav (suite-agnostic context)', () => {
  const config = {
    testsuite: '',
    urlBase: '',
  };

  it('renders left-side nav links: Test Suites, Graph, Compare, Profiles', () => {
    const nav = renderNav(config);
    const links = nav.querySelectorAll('.v5-nav-links .v5-nav-link[data-path]');
    const labels = Array.from(links).map(l => l.textContent);
    expect(labels).toEqual(['Test Suites', 'Graph', 'Compare', 'Profiles']);
  });

  it('renders API link with target="_blank"', () => {
    const nav = renderNav(config);
    const apiLink = Array.from(nav.querySelectorAll('.v5-nav-link'))
      .find(l => l.textContent === 'API') as HTMLAnchorElement;
    expect(apiLink).toBeTruthy();
    expect(apiLink.getAttribute('target')).toBe('_blank');
    expect(apiLink.getAttribute('href')).toBe('/api/v5/openapi/swagger-ui');
  });

  it('renders right-side links: Admin, Settings', () => {
    const nav = renderNav(config);
    const rightLinks = nav.querySelectorAll('.v5-nav-right .v5-nav-link');
    const labels = Array.from(rightLinks).map(l => l.textContent);
    expect(labels).toEqual(['Admin', 'Settings']);
  });

  it('renders the LNT brand', () => {
    const nav = renderNav(config);
    const brand = nav.querySelector('.v5-nav-brand');
    expect(brand?.textContent).toBe('LNT');
  });

  it('does not render a suite selector dropdown', () => {
    const nav = renderNav(config);
    const select = nav.querySelector('select');
    expect(select).toBeNull();
  });

  it('brand href is /v5/', () => {
    const nav = renderNav(config);
    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    expect(brand.getAttribute('href')).toBe('/v5/');
  });

  it('clicking brand calls navigate("/")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    brand.click();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('clicking Test Suites calls navigate("/test-suites")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Test Suites') as HTMLAnchorElement;
    link.click();
    expect(navigate).toHaveBeenCalledWith('/test-suites');
  });

  it('clicking Graph calls navigate("/graph")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Graph') as HTMLAnchorElement;
    link.click();
    expect(navigate).toHaveBeenCalledWith('/graph');
  });

  it('clicking Compare calls navigate("/compare")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Compare') as HTMLAnchorElement;
    link.click();
    expect(navigate).toHaveBeenCalledWith('/compare');
  });

  it('clicking Profiles calls navigate("/profiles")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Profiles') as HTMLAnchorElement;
    link.click();
    expect(navigate).toHaveBeenCalledWith('/profiles');
  });

  it('clicking Admin calls navigate("/admin")', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Admin') as HTMLAnchorElement;
    link.click();
    expect(navigate).toHaveBeenCalledWith('/admin');
  });

  it('Settings link renders', () => {
    const nav = renderNav(config);
    const settingsLink = Array.from(nav.querySelectorAll('.v5-nav-link'))
      .find(l => l.textContent === 'Settings');
    expect(settingsLink).toBeTruthy();
  });

  it('Cmd+Click on nav link does not call navigate()', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Graph') as HTMLAnchorElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Ctrl+Click on nav link does not call navigate()', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Graph') as HTMLAnchorElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Cmd+Click on brand does not call navigate()', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    brand.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('nav links include urlBase when set', () => {
    const configWithBase = { ...config, urlBase: '/lnt' };
    const nav = renderNav(configWithBase);
    const links = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]')) as HTMLAnchorElement[];
    const hrefs = links.map(l => ({ label: l.textContent, href: l.getAttribute('href') }));
    expect(hrefs).toContainEqual({ label: 'Graph', href: '/lnt/v5/graph' });
    expect(hrefs).toContainEqual({ label: 'Admin', href: '/lnt/v5/admin' });
    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    expect(brand.getAttribute('href')).toBe('/lnt/v5/');
  });
});

// --- Suite-scoped context (testsuite: 'nts') ---

describe('renderNav (suite-scoped context)', () => {
  const config = {
    testsuite: 'nts',
    urlBase: '',
  };

  it('renders same links as agnostic context (navbar looks identical)', () => {
    const nav = renderNav(config);
    const leftLinks = nav.querySelectorAll('.v5-nav-links .v5-nav-link[data-path]');
    const leftLabels = Array.from(leftLinks).map(l => l.textContent);
    expect(leftLabels).toEqual(['Test Suites', 'Graph', 'Compare', 'Profiles']);

    const rightLinks = nav.querySelectorAll('.v5-nav-right .v5-nav-link');
    const rightLabels = Array.from(rightLinks).map(l => l.textContent);
    expect(rightLabels).toEqual(['Admin', 'Settings']);
  });

  it('brand href is /v5/ (not suite-scoped)', () => {
    const nav = renderNav(config);
    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    expect(brand.getAttribute('href')).toBe('/v5/');
  });

  it('clicking brand does NOT call navigate() (full-page nav)', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const brand = nav.querySelector('.v5-nav-brand') as HTMLAnchorElement;
    brand.click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clicking Test Suites does NOT call navigate() (full-page nav)', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Test Suites') as HTMLAnchorElement;
    link.click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Graph link href includes ?suite=nts', () => {
    const nav = renderNav(config);
    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Graph') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/v5/graph?suite=nts');
  });

  it('Compare link href includes ?suite_a=nts', () => {
    const nav = renderNav(config);
    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Compare') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/v5/compare?suite_a=nts');
  });

  it('Profiles link href includes ?suite_a=nts', () => {
    const nav = renderNav(config);
    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Profiles') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/v5/profiles?suite_a=nts');
  });

  it('clicking Admin does NOT call navigate() (full-page nav)', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const link = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'))
      .find(l => l.textContent === 'Admin') as HTMLAnchorElement;
    link.click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('no nav link calls navigate() in suite-scoped context', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    const links = Array.from(nav.querySelectorAll('.v5-nav-link[data-path]'));
    for (const link of links) {
      (link as HTMLElement).click();
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});

// --- updateActiveNavLink ---

describe('updateActiveNavLink', () => {
  const config = {
    testsuite: '',
    urlBase: '',
  };

  it('highlights Test Suites for /test-suites path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/test-suites');

    const link = document.querySelector('[data-path="/test-suites"]');
    expect(link?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('highlights Graph for /graph path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/graph');

    const link = document.querySelector('[data-path="/graph"]');
    expect(link?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('highlights Compare for /compare path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/compare');

    const link = document.querySelector('[data-path="/compare"]');
    expect(link?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('highlights Profiles for /profiles path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/profiles');

    const link = document.querySelector('[data-path="/profiles"]');
    expect(link?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('highlights Admin for /admin path', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/admin');

    const link = document.querySelector('[data-path="/admin"]');
    expect(link?.classList.contains('v5-nav-link-active')).toBe(true);
  });

  it('no link highlighted for root path /', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/');

    const activeLinks = document.querySelectorAll('.v5-nav-link-active');
    expect(activeLinks).toHaveLength(0);
  });

  it('clears previous highlight when path changes', () => {
    const nav = renderNav(config);
    document.body.append(nav);

    updateActiveNavLink('/graph');
    updateActiveNavLink('/admin');

    const graphLink = document.querySelector('[data-path="/graph"]');
    const adminLink = document.querySelector('[data-path="/admin"]');
    expect(graphLink?.classList.contains('v5-nav-link-active')).toBe(false);
    expect(adminLink?.classList.contains('v5-nav-link-active')).toBe(true);
  });
});
