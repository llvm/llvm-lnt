// main.ts — SPA entry point for the v5 UI.

import { setApiBase } from './api';
import { addRoute, initRouter } from './router';
import { renderNav, updateActiveNavLink } from './components/nav';
import { el } from './utils';
import './style.css';

// Page modules
import { homePage } from './pages/home';
import { testSuitesPage } from './pages/test-suites';
import { machineDetailPage } from './pages/machine-detail';
import { runDetailPage } from './pages/run-detail';
import { orderDetailPage } from './pages/order-detail';
import { graphPage } from './pages/graph';
import { comparePage } from './pages/compare';
import { regressionListPage } from './pages/regression-list';
import { regressionDetailPage } from './pages/regression-detail';
import { fieldChangeTriagePage } from './pages/field-change-triage';
import { adminPage } from './pages/admin';
import type { PageModule } from './router';

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
  const nav = renderNav({ testsuite, v4Url, urlBase });
  root.append(nav);

  // Page content container
  const pageContainer = el('div', { id: 'v5-page' });
  root.append(pageContainer);

  if (testsuite) {
    // Suite-scoped pages — detail views within a single test suite.
    // The suite root redirects to the Test Suites page with suite pre-selected.
    const suiteRedirectPage: PageModule = {
      mount(): void {
        window.location.replace(`${urlBase}/v5/test-suites?suite=${encodeURIComponent(testsuite)}`);
      },
    };
    addRoute('/', suiteRedirectPage);
    addRoute('/machines/:name', machineDetailPage);
    addRoute('/runs/:uuid', runDetailPage);
    addRoute('/commits/:value', orderDetailPage);
    addRoute('/regressions', regressionListPage);
    addRoute('/regressions/:uuid', regressionDetailPage);
    addRoute('/field-changes', fieldChangeTriagePage);

    const basePath = `${urlBase}/v5/${encodeURIComponent(testsuite)}`;
    initRouter(pageContainer, basePath, updateActiveNavLink, { testsuite, testsuites, urlBase });
  } else {
    // Suite-agnostic pages — dashboard, test suites, analysis tools, admin
    addRoute('/', homePage);
    addRoute('/test-suites', testSuitesPage);
    addRoute('/admin', adminPage);
    addRoute('/graph', graphPage);
    addRoute('/compare', comparePage);

    const basePath = `${urlBase}/v5`;
    initRouter(pageContainer, basePath, updateActiveNavLink, { testsuite: '', testsuites, urlBase });
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
