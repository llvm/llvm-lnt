// components/profile-colors.ts — Shared heat-map gradient for profile components.

/**
 * Map a ratio (0..1) to a white → yellow → red gradient.
 * Used by both the disassembly heat-map and function selector badges.
 */
export function heatGradient(ratio: number): string {
  const r = Math.min(Math.max(ratio, 0), 1);
  if (r <= 0.5) {
    const t = r * 2;
    return `rgb(255,255,${Math.round(255 * (1 - t))})`;
  }
  const t = (r - 0.5) * 2;
  return `rgb(255,${Math.round(255 * (1 - t))},0)`;
}
