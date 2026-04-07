// main.ts — SPA entry point for the v5 UI.

import { setApiBase } from './api';
import { addRoute, initRouter } from './router';
import { renderNav, updateActiveNavLink } from './components/nav';
import { el } from './utils';
import './style.css';

// Page modules
import { dashboardPage } from './pages/dashboard';
import { machineListPage } from './pages/machine-list';
import { machineDetailPage } from './pages/machine-detail';
import { runDetailPage } from './pages/run-detail';
import { orderDetailPage } from './pages/order-detail';
import { graphPage } from './pages/graph';
import { comparePage } from './pages/compare';
import { regressionListPage } from './pages/regression-list';
import { regressionDetailPage } from './pages/regression-detail';
import { fieldChangeTriagePage } from './pages/field-change-triage';
import { adminPage } from './pages/admin';

declare const lnt_url_base: string;

function init(): void {
  const root = document.getElementById('v5-app');
  if (!root) return;

  const testsuite = root.getAttribute('data-testsuite') || '';
  const testsuites: string[] = JSON.parse(
    root.getAttribute('data-testsuites') || '[]'
  );
  const v4Url = root.getAttribute('data-v4-url') || '#';

  // Set API base from global set in layout.html
  const urlBase = typeof lnt_url_base !== 'undefined' ? lnt_url_base : '';
  setApiBase(urlBase);

  // Render nav bar (persistent across route changes)
  const nav = renderNav({ testsuite, testsuites, v4Url, urlBase });
  root.append(nav);

  // Page content container
  const pageContainer = el('div', { id: 'v5-page' });
  root.append(pageContainer);

  if (testsuite) {
    // Suite-scoped pages — browsing data within a single test suite
    addRoute('/', dashboardPage);
    addRoute('/machines', machineListPage);
    addRoute('/machines/:name', machineDetailPage);
    addRoute('/runs/:uuid', runDetailPage);
    addRoute('/orders/:value', orderDetailPage);
    addRoute('/regressions', regressionListPage);
    addRoute('/regressions/:uuid', regressionDetailPage);
    addRoute('/field-changes', fieldChangeTriagePage);

    const basePath = `${urlBase}/v5/${encodeURIComponent(testsuite)}`;
    initRouter(pageContainer, basePath, updateActiveNavLink, { testsuite, testsuites });
  } else {
    // Suite-agnostic pages — analysis tools and admin
    addRoute('/admin', adminPage);
    addRoute('/graph', graphPage);
    addRoute('/compare', comparePage);

    const basePath = `${urlBase}/v5`;
    initRouter(pageContainer, basePath, updateActiveNavLink, { testsuite: '', testsuites });
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
