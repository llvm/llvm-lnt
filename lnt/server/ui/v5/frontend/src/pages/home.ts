import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const homePage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, 'Dashboard'),
        el('p', {}, 'Not implemented yet.'),
      )
    );
  },
};
