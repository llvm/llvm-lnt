// router.ts — Client-side URL routing using the History API.

export interface PageModule {
  /** Render the page into the container. Called on navigation. */
  mount(container: HTMLElement, params: RouteParams): void | Promise<void>;
  /** Clean up when navigating away. Optional. */
  unmount?(): void;
}

export interface RouteParams {
  testsuite: string;
  /** Named captures from the route pattern, e.g. { name: "machine-1" } */
  [key: string]: string;
}

interface RouteEntry {
  /** Regex compiled from the route pattern */
  regex: RegExp;
  /** Named group keys in order */
  keys: string[];
  /** The page module to mount */
  module: PageModule;
}

const routes: RouteEntry[] = [];
let currentModule: PageModule | null = null;
let appContainer: HTMLElement | null = null;
let basePath = ''; // e.g. "/v5/nts"
let onAfterResolve: ((routePath: string) => void) | null = null;

/**
 * Return the current base path (e.g. "/v5/nts").
 * Used by spaLink to construct real href attributes for accessibility.
 */
export function getBasePath(): string {
  return basePath;
}

/**
 * Register a route. Pattern uses Express-style `:param` syntax.
 * Example: "/machines/:name" matches "/machines/clang-x86"
 */
export function addRoute(pattern: string, module: PageModule): void {
  const keys: string[] = [];
  // Convert ":param" to named regex groups
  const regexStr = pattern
    .replace(/:([a-zA-Z_]+)/g, (_match, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  routes.push({
    regex: new RegExp('^' + regexStr + '$'),
    keys,
    module,
  });
}

/**
 * Initialize the router.
 * @param container The DOM element to render pages into
 * @param tsBasePath The base path, e.g. "/v5/nts"
 * @param afterResolve Optional callback after each route resolution (for nav highlighting)
 */
export function initRouter(
  container: HTMLElement,
  tsBasePath: string,
  afterResolve?: (routePath: string) => void,
): void {
  appContainer = container;
  basePath = tsBasePath;
  onAfterResolve = afterResolve || null;

  window.addEventListener('popstate', () => {
    resolve();
  });

  // Initial route resolution
  resolve();
}

/**
 * Navigate to a path (relative to the testsuite base).
 * Example: navigate("/machines/clang-x86")
 */
export function navigate(path: string): void {
  const fullPath = basePath + path;
  window.history.pushState(null, '', fullPath);
  resolve();
}

/**
 * Navigate to a path with query string.
 */
export function navigateWithQuery(path: string, query: string): void {
  const fullPath = basePath + path;
  const qs = query ? '?' + query : '';
  window.history.pushState(null, '', fullPath + qs);
  resolve();
}

/**
 * Resolve the current URL to a route and mount the corresponding page.
 */
function resolve(): void {
  if (!appContainer) return;

  const pathname = window.location.pathname;
  // Strip basePath prefix to get the route portion
  let routePath = pathname;
  if (pathname.startsWith(basePath)) {
    routePath = pathname.slice(basePath.length);
  }
  // Ensure it starts with /
  if (!routePath.startsWith('/')) {
    routePath = '/' + routePath;
  }
  // Normalize: strip trailing slash (except for root "/")
  if (routePath.length > 1 && routePath.endsWith('/')) {
    routePath = routePath.slice(0, -1);
  }

  // Root path "/" maps to the dashboard
  if (routePath === '' || routePath === '/') {
    routePath = '/';
  }

  for (const route of routes) {
    const match = routePath.match(route.regex);
    if (match) {
      const params: RouteParams = {
        testsuite: basePath.split('/').pop() || '',
      };
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });

      // Unmount previous page
      if (currentModule?.unmount) {
        currentModule.unmount();
      }

      // Clear container
      appContainer.replaceChildren();

      // Mount new page
      currentModule = route.module;
      currentModule.mount(appContainer, params);

      if (onAfterResolve) {
        onAfterResolve(routePath);
      }
      return;
    }
  }

  // No route matched — show 404
  if (currentModule?.unmount) {
    currentModule.unmount();
  }
  currentModule = null;
  appContainer.replaceChildren();
  const msg = document.createElement('div');
  msg.style.padding = '40px';
  msg.style.textAlign = 'center';
  msg.style.color = '#666';
  msg.innerHTML = '<h2>Page Not Found</h2><p>The URL does not match any v5 page.</p>';
  appContainer.appendChild(msg);

  if (onAfterResolve) {
    onAfterResolve('');
  }
}
