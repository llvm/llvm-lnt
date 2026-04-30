// Custom DOM event names used for inter-module communication.
export const CHART_ZOOM = 'chart-zoom' as const;
export const CHART_HOVER = 'chart-hover' as const;
export const TABLE_HOVER = 'table-hover' as const;
export const TEST_FILTER_CHANGE = 'test-filter-change' as const;
export const SETTINGS_CHANGE = 'settings-change' as const;
export const GRAPH_TABLE_HOVER = 'graph-table-hover' as const;
export const GRAPH_CHART_HOVER = 'graph-chart-hover' as const;
export const GRAPH_CHART_DBLCLICK = 'graph-chart-dblclick' as const;

/** Type-safe wrapper for addEventListener with CustomEvent detail.
 *  Returns a cleanup function to remove the listener. */
export function onCustomEvent<T>(
  name: string,
  handler: (detail: T) => void,
): () => void {
  const listener = ((e: CustomEvent<T>) => {
    handler(e.detail);
  }) as EventListener;
  document.addEventListener(name, listener);
  return () => document.removeEventListener(name, listener);
}
