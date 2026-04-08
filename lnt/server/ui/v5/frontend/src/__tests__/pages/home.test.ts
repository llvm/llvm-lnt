// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { homePage } from '../../pages/home';

describe('homePage', () => {
  it('renders Dashboard heading and placeholder text', () => {
    const container = document.createElement('div');
    homePage.mount(container, { testsuite: '' });

    expect(container.querySelector('h2')?.textContent).toBe('Dashboard');
    expect(container.textContent).toContain('Not implemented yet');
  });
});
