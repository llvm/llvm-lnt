import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const regressionDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, `Regression: ${params.uuid}`),
        el('p', {}, 'Not implemented yet.'),
      )
    );
  },
};
