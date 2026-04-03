// pages/dashboard.ts — Dashboard landing page.

import type { PageModule, RouteParams } from '../router';
import type { OrderDetail } from '../types';
import { getRecentRuns, getOrder } from '../api';
import { el, spaLink, formatTime, truncate, primaryOrderValue } from '../utils';
import { renderDataTable } from '../components/data-table';

let controller: AbortController | null = null;

export const dashboardPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();

    const ts = params.testsuite;
    container.append(el('h2', { class: 'page-header' }, 'Dashboard'));

    const recentSection = el('div', { class: 'dashboard-section' });
    container.append(recentSection);

    loadRecentOrders(ts, recentSection, controller.signal);
  },

  unmount(): void {
    if (controller) { controller.abort(); controller = null; }
  },
};

interface OrderRow {
  orderValue: string;
  tag: string | null;
  latestRun: string;
  latestRunUuid: string;
}

async function loadRecentOrders(ts: string, section: HTMLElement, signal: AbortSignal): Promise<void> {
  section.append(el('h3', {}, 'Recent Orders'));
  const loading = el('p', { class: 'progress-label' }, 'Loading recent runs...');
  section.append(loading);

  try {
    const result = await getRecentRuns(ts, { limit: 50, sort: '-start_time' }, signal);

    // Group by primary order field value, tracking the latest run
    const orderMap = new Map<string, { latestRun: string; latestRunUuid: string }>();
    for (const run of result.items) {
      const ov = primaryOrderValue(run.order);
      if (!ov) continue;
      let entry = orderMap.get(ov);
      if (!entry) {
        entry = { latestRun: run.start_time || '', latestRunUuid: run.uuid };
        orderMap.set(ov, entry);
      }
      if (run.start_time && run.start_time > entry.latestRun) {
        entry.latestRun = run.start_time;
        entry.latestRunUuid = run.uuid;
      }
    }

    // Batch-fetch order details to get tags (batches of 5 to avoid overwhelming connections)
    const orderValues = [...orderMap.keys()];
    const tagMap = new Map<string, string | null>();
    const batchSize = 5;
    for (let i = 0; i < orderValues.length; i += batchSize) {
      const batch = orderValues.slice(i, i + batchSize);
      await Promise.all(batch.map(async (v) => {
        try {
          const detail: OrderDetail = await getOrder(ts, v, signal);
          tagMap.set(v, detail.tag);
        } catch {
          tagMap.set(v, null);
        }
      }));
    }

    const rows: OrderRow[] = orderValues.map(v => {
      const entry = orderMap.get(v)!;
      return {
        orderValue: v,
        tag: tagMap.get(v) || null,
        latestRun: entry.latestRun,
        latestRunUuid: entry.latestRunUuid,
      };
    });

    loading.remove();

    if (rows.length === 0) {
      section.append(el('p', { class: 'no-results' }, 'No recent runs found.'));
      return;
    }

    renderDataTable(section, {
      columns: [
        { key: 'orderValue', label: 'Order',
          render: (r) => {
            const label = truncate(r.orderValue, 12) + (r.tag ? ` (${r.tag})` : '');
            return spaLink(label, `/orders/${encodeURIComponent(r.orderValue)}`);
          } },
        { key: 'latestRun', label: 'Latest Run',
          render: (r) => spaLink(
            formatTime(r.latestRun, ''),
            `/runs/${encodeURIComponent(r.latestRunUuid)}`,
          ) },
      ],
      rows,
      emptyMessage: 'No recent orders.',
    });
  } catch (e: unknown) {
    loading.remove();
    section.append(el('p', { class: 'error-banner' }, `Failed to load recent orders: ${e}`));
  }
}
