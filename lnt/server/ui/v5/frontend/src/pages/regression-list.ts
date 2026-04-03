import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const regressionListPage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, 'Regression List'),
        el('p', {}, 'Not implemented yet.'),
      )
    );
  },
};
