import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const fieldChangeTriagePage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, 'Field Change Triage'),
        el('p', {}, 'Not implemented yet.'),
      )
    );
  },
};
