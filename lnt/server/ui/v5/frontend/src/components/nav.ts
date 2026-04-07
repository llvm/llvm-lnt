// components/nav.ts — Navigation bar for the v5 SPA.

import { el, isModifiedClick } from '../utils';
import { navigate } from '../router';

export interface NavConfig {
  testsuite: string;
  testsuites: string[];
  v4Url: string;
  urlBase: string; // lnt_url_base
}

let activeLink: HTMLElement | null = null;

/**
 * Render the navigation bar.
 * Returns the nav element to prepend to the app root.
 */
export function renderNav(config: NavConfig): HTMLElement {
  const nav = el('nav', { class: 'v5-nav' });
  const tsBasePath = config.testsuite
    ? `${config.urlBase}/v5/${encodeURIComponent(config.testsuite)}`
    : `${config.urlBase}/v5`;

  // Test suite selector (created first so brand and nav links can reference it)
  const suiteSelect = el('select', { class: 'v5-nav-suite-select' }) as HTMLSelectElement;
  for (const name of config.testsuites) {
    const opt = el('option', { value: name }, name);
    if (name === config.testsuite) {
      (opt as HTMLOptionElement).selected = true;
    }
    suiteSelect.append(opt);
  }
  suiteSelect.addEventListener('change', () => {
    const newSuite = suiteSelect.value;
    window.location.href = `${config.urlBase}/v5/${encodeURIComponent(newSuite)}/`;
  });

  // Brand — in admin context, href points to the selected suite's dashboard
  const brandHref = config.testsuite
    ? tsBasePath + '/'
    : `${config.urlBase}/v5/${encodeURIComponent(suiteSelect.value)}/`;
  const brand = el('a', { class: 'v5-nav-brand', href: brandHref }, 'LNT');
  if (!config.testsuite) {
    suiteSelect.addEventListener('change', () => {
      const suite = suiteSelect.value;
      brand.setAttribute('href', `${config.urlBase}/v5/${encodeURIComponent(suite)}/`);
    });
  }
  brand.addEventListener('click', (e) => {
    if (isModifiedClick(e)) return;
    e.preventDefault();
    if (config.testsuite) {
      navigate('/');
    } else {
      const suite = suiteSelect.value;
      if (suite) {
        window.location.href = `${config.urlBase}/v5/${encodeURIComponent(suite)}/`;
      }
    }
  });
  nav.append(brand);

  const suiteGroup = el('div', { class: 'v5-nav-suite' });
  suiteGroup.append(el('span', {}, 'Suite: '), suiteSelect);
  nav.append(suiteGroup);

  // Navigation links
  const links: { label: string; path: string }[] = [
    { label: 'Dashboard', path: '/' },
    { label: 'Graph', path: '/graph' },
    { label: 'Compare', path: '/compare' },
    { label: 'Regressions', path: '/regressions' },
    { label: 'Machines', path: '/machines' },
  ];

  const linksContainer = el('div', { class: 'v5-nav-links' });
  for (const link of links) {
    if (config.testsuite) {
      // Normal testsuite context — use SPA navigation
      const a = el('a', {
        class: 'v5-nav-link',
        href: tsBasePath + link.path,
        'data-path': link.path,
      }, link.label);
      a.addEventListener('click', (e) => {
        if (isModifiedClick(e)) return;
        e.preventDefault();
        navigate(link.path);
      });
      linksContainer.append(a);
    } else {
      // Admin context (no testsuite) — use full page navigation
      // to the suite selected in the dropdown
      const a = el('a', {
        class: 'v5-nav-link',
        'data-path': link.path,
      }, link.label);
      // Set href dynamically so Cmd+Click opens in new tab
      const updateHref = () => {
        const suite = suiteSelect.value;
        if (suite) {
          a.setAttribute('href', `${config.urlBase}/v5/${encodeURIComponent(suite)}${link.path}`);
        }
      };
      updateHref();
      suiteSelect.addEventListener('change', updateHref);
      a.addEventListener('click', (e) => {
        if (isModifiedClick(e)) return;
        e.preventDefault();
        const suite = suiteSelect.value;
        if (suite) {
          window.location.href = `${config.urlBase}/v5/${encodeURIComponent(suite)}${link.path}`;
        }
      });
      linksContainer.append(a);
    }
  }

  // Admin link — goes to /v5/admin (outside testsuite namespace)
  const adminLink = el('a', {
    class: 'v5-nav-link',
    href: `${config.urlBase}/v5/admin`,
    'data-path': '/admin',
  }, 'Admin');
  linksContainer.append(adminLink);

  nav.append(linksContainer);

  // Right side: v4 toggle + Settings
  const rightGroup = el('div', { class: 'v5-nav-right' });

  const v4Link = el('a', { class: 'v5-nav-link', href: config.v4Url }, 'v4 UI');
  rightGroup.append(v4Link);

  const settingsLink = el('a', {
    class: 'v5-nav-link',
    href: '#',
  }, 'Settings');
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    toggleSettings();
  });
  rightGroup.append(settingsLink);
  nav.append(rightGroup);

  return nav;
}

/**
 * Update the active link in the nav bar based on the current route.
 * Call this after each route resolution.
 */
export function updateActiveNavLink(currentPath: string): void {
  if (activeLink) {
    activeLink.classList.remove('v5-nav-link-active');
  }
  activeLink = null;

  const links = document.querySelectorAll<HTMLElement>('.v5-nav-link[data-path]');
  for (const link of links) {
    const path = link.getAttribute('data-path');
    if (!path) continue;

    // Exact match for "/" (dashboard), prefix match for others
    if (path === '/') {
      if (currentPath === '/' || currentPath === '') {
        link.classList.add('v5-nav-link-active');
        activeLink = link;
      }
    } else if (currentPath.startsWith(path)) {
      link.classList.add('v5-nav-link-active');
      activeLink = link;
    }
  }
}

/**
 * Remove a suite from the nav bar dropdown (e.g. after deletion).
 */
export function removeSuiteFromNav(suiteName: string): void {
  const select = document.querySelector('.v5-nav-suite-select') as HTMLSelectElement | null;
  if (!select) return;
  for (const opt of Array.from(select.options)) {
    if (opt.value === suiteName) {
      opt.remove();
      break;
    }
  }
}

/**
 * Add a suite to the nav bar dropdown in sorted position (e.g. after creation).
 */
export function addSuiteToNav(suiteName: string): void {
  const select = document.querySelector('.v5-nav-suite-select') as HTMLSelectElement | null;
  if (!select) return;
  const options = Array.from(select.options);
  // Avoid duplicates
  if (options.some(o => o.value === suiteName)) return;
  const insertIndex = options.findIndex(o => o.value > suiteName);
  const opt = new Option(suiteName, suiteName);
  if (insertIndex === -1) select.add(opt);
  else select.add(opt, insertIndex);
}

/** Settings panel toggle (token input). Reuses the existing pattern. */
function toggleSettings(): void {
  let panel = document.getElementById('v5-settings-panel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    return;
  }

  // Create settings panel
  panel = el('div', { id: 'v5-settings-panel', class: 'settings-panel' });
  panel.append(el('label', {}, 'Auth Token'));
  const tokenInput = el('input', {
    type: 'password',
    class: 'token-input',
    placeholder: 'Paste v5 API token...',
  }) as HTMLInputElement;
  tokenInput.value = localStorage.getItem('lnt_v5_token') || '';
  tokenInput.addEventListener('change', () => {
    const val = tokenInput.value.trim();
    if (val) localStorage.setItem('lnt_v5_token', val);
    else localStorage.removeItem('lnt_v5_token');
  });
  panel.append(tokenInput);

  // Insert after the nav
  const nav = document.querySelector('.v5-nav');
  if (nav && nav.parentElement) {
    nav.parentElement.insertBefore(panel, nav.nextSibling);
  }
}
