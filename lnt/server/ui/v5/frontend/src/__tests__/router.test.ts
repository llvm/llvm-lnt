// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// We need to test the router module. Since it uses global state,
// we import fresh each test by resetting modules.
let routerModule: typeof import('../router');

beforeEach(async () => {
  // Reset the router's internal state by re-importing
  vi.resetModules();
  routerModule = await import('../router');

  // Reset DOM
  document.body.innerHTML = '';

  // Mock history API
  vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
});

describe('addRoute + resolve', () => {
  it('matches an exact path and mounts the module', () => {
    const container = document.createElement('div');
    const mount = vi.fn();
    const module: import('../router').PageModule = { mount };

    routerModule.addRoute('/', module);

    // Set window.location to the correct path
    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');

    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0][0]).toBe(container);
    expect(mount.mock.calls[0][1]).toMatchObject({ testsuite: 'nts' });
  });

  it('matches parameterized routes', () => {
    const container = document.createElement('div');
    const mount = vi.fn();
    const module: import('../router').PageModule = { mount };

    routerModule.addRoute('/machines/:name', module);

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/machines/clang-x86', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');

    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0][1]).toMatchObject({
      testsuite: 'nts',
      name: 'clang-x86',
    });
  });

  it('decodes URI-encoded parameters', () => {
    const container = document.createElement('div');
    const mount = vi.fn();
    const module: import('../router').PageModule = { mount };

    routerModule.addRoute('/machines/:name', module);

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/machines/machine%20with%20space', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');

    expect(mount.mock.calls[0][1].name).toBe('machine with space');
  });

  it('shows 404 for unmatched routes', () => {
    const container = document.createElement('div');

    routerModule.addRoute('/', { mount: vi.fn() });

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/nonexistent', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');

    expect(container.innerHTML).toContain('Page Not Found');
  });

  it('unmounts previous page before mounting new one', () => {
    const container = document.createElement('div');
    const unmount = vi.fn();
    const moduleA: import('../router').PageModule = { mount: vi.fn(), unmount };
    const moduleB: import('../router').PageModule = { mount: vi.fn() };

    routerModule.addRoute('/', moduleA);
    routerModule.addRoute('/other', moduleB);

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');
    expect(moduleA.mount).toHaveBeenCalledTimes(1);

    // Navigate to /other
    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/other', search: '', hash: '' },
      writable: true,
    });

    routerModule.navigate('/other');

    expect(unmount).toHaveBeenCalledTimes(1);
    expect(moduleB.mount).toHaveBeenCalledTimes(1);
  });

  it('strips trailing slashes for non-root paths', () => {
    const container = document.createElement('div');
    const mount = vi.fn();
    routerModule.addRoute('/machines', { mount });

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/machines/', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');
    expect(mount).toHaveBeenCalledTimes(1);
  });
});

describe('navigate', () => {
  it('calls pushState and resolves the new route', () => {
    const container = document.createElement('div');
    const mountA = vi.fn();
    const mountB = vi.fn();

    routerModule.addRoute('/', { mount: mountA });
    routerModule.addRoute('/machines', { mount: mountB });

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts');
    expect(mountA).toHaveBeenCalledTimes(1);

    // Navigate
    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/machines', search: '', hash: '' },
      writable: true,
    });
    routerModule.navigate('/machines');

    expect(window.history.pushState).toHaveBeenCalled();
    expect(mountB).toHaveBeenCalledTimes(1);
  });
});

describe('afterResolve callback', () => {
  it('is called with the resolved route path', () => {
    const container = document.createElement('div');
    const callback = vi.fn();

    routerModule.addRoute('/', { mount: vi.fn() });
    routerModule.addRoute('/machines', { mount: vi.fn() });

    Object.defineProperty(window, 'location', {
      value: { pathname: '/v5/nts/', search: '', hash: '' },
      writable: true,
    });

    routerModule.initRouter(container, '/v5/nts', callback);

    expect(callback).toHaveBeenCalledWith('/');
  });
});
