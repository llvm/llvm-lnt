// components/checkbox-range.ts — Shift+click range selection for checkbox lists.

/**
 * Enable shift+click range selection on checkboxes within a container.
 * Uses event delegation so it works after DOM rebuilds (sort, filter).
 * Tracks the last-clicked checkbox by its identity in the current DOM order.
 *
 * @param container - The parent element containing the checkboxes.
 * @param selector  - CSS selector matching the checkboxes (e.g. 'input[type="checkbox"][data-uuid]').
 * @param onChange  - Called after any range selection so the caller can update UI state.
 * @returns { destroy } to remove the event listener.
 */
export function setupCheckboxRange(
  container: HTMLElement,
  selector: string,
  onChange: () => void,
): { destroy: () => void } {
  let lastCheckedEl: HTMLInputElement | null = null;

  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.matches(selector)) return;

    const cb = target as HTMLInputElement;

    if (e.shiftKey && lastCheckedEl) {
      const allBoxes = [...container.querySelectorAll<HTMLInputElement>(selector)];
      const currentIndex = allBoxes.indexOf(cb);
      const lastIndex = allBoxes.indexOf(lastCheckedEl);

      // If lastCheckedEl is no longer in the DOM (e.g. after sort), skip range
      if (lastIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        for (let i = start; i <= end; i++) {
          allBoxes[i].checked = cb.checked;
        }
        onChange();
      }
    }

    lastCheckedEl = cb;
  }

  container.addEventListener('click', onClick);

  return {
    destroy() {
      container.removeEventListener('click', onClick);
      lastCheckedEl = null;
    },
  };
}
