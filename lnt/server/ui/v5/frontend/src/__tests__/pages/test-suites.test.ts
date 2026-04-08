// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { testSuitesPage } from '../../pages/test-suites';

describe('testSuitesPage', () => {
  it('renders Test Suites heading and placeholder text', () => {
    const container = document.createElement('div');
    testSuitesPage.mount(container, { testsuite: '' });

    expect(container.querySelector('h2')?.textContent).toBe('Test Suites');
    expect(container.textContent).toContain('Not implemented yet');
  });
});
