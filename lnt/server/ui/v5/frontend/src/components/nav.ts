// components/nav.ts — Navigation bar for the v5 SPA.

import { el, isModifiedClick } from '../utils';
import { navigate } from '../router';

export interface NavConfig {
  testsuite: string;
  urlBase: string; // lnt_url_base
}

let activeLink: HTMLElement | null = null;

interface NavLink {
  label: string;
  path: string;
  suiteParam?: string;
}

/**
 * Build a suite-agnostic nav link element. In suite-agnostic context, clicks
 * use SPA navigation; in suite-scoped context, the browser follows the href.
 */
function buildNavLink(link: NavLink, agnosticBase: string, config: NavConfig): HTMLAnchorElement {
  let href = `${agnosticBase}${link.path}`;
  if (config.testsuite && link.suiteParam) {
    href += `?${link.suiteParam}=${encodeURIComponent(config.testsuite)}`;
  }

  const a = el('a', {
    class: 'v5-nav-link',
    href,
    'data-path': link.path,
  }, link.label) as HTMLAnchorElement;

  if (!config.testsuite) {
    a.addEventListener('click', (e) => {
      if (isModifiedClick(e)) return;
      e.preventDefault();
      navigate(link.path);
    });
  }

  return a;
}

/**
 * Render the navigation bar.
 * Returns the nav element to prepend to the app root.
 *
 * All navbar links are suite-agnostic. In suite-agnostic context they use
 * SPA navigation; in suite-scoped context they use full-page navigation.
 */
export function renderNav(config: NavConfig): HTMLElement {
  const nav = el('nav', { class: 'v5-nav' });
  const agnosticBase = `${config.urlBase}/v5`;

  // Brand — always links to the suite-agnostic dashboard at /v5/
  const brandHref = `${agnosticBase}/`;
  const brand = el('a', { class: 'v5-nav-brand', href: brandHref }, 'LNT');
  if (!config.testsuite) {
    brand.addEventListener('click', (e) => {
      if (isModifiedClick(e)) return;
      e.preventDefault();
      navigate('/');
    });
  }
  // In suite-scoped context: no click handler — browser follows the href
  nav.append(brand);

  // Left-side links
  const linksContainer = el('div', { class: 'v5-nav-links' });

  const leftLinks: NavLink[] = [
    { label: 'Test Suites', path: '/test-suites', suiteParam: 'suite' },
    { label: 'Graph', path: '/graph', suiteParam: 'suite' },
    { label: 'Compare', path: '/compare', suiteParam: 'suite_a' },
    { label: 'Profiles', path: '/profiles', suiteParam: 'suite_a' },
  ];

  for (const link of leftLinks) {
    linksContainer.append(buildNavLink(link, agnosticBase, config));
  }

  // API link — always opens Swagger UI in a new tab
  const apiLink = el('a', {
    class: 'v5-nav-link',
    href: `${config.urlBase}/api/v5/openapi/swagger-ui`,
    target: '_blank',
    rel: 'noopener',
  }, 'API');
  linksContainer.append(apiLink);

  nav.append(linksContainer);

  // Right side: Admin, Settings
  const rightGroup = el('div', { class: 'v5-nav-right' });

  rightGroup.append(buildNavLink({ label: 'Admin', path: '/admin' }, agnosticBase, config));

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

    if (currentPath.startsWith(path)) {
      link.classList.add('v5-nav-link-active');
      activeLink = link;
      break;
    }
  }
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
  const navEl = document.querySelector('.v5-nav');
  if (navEl && navEl.parentElement) {
    navEl.parentElement.insertBefore(panel, navEl.nextSibling);
  }
}
