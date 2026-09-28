/** Space-aware placement adapted from HazAT/pi-interactive-subagents (MIT).
 * Tiled splits preserve simultaneous visibility; when they become too small,
 * continue in a new tab instead of stacking and hiding panes.
 */
export interface PaneGeometry {
  id: number;
  is_plugin: boolean;
  is_floating?: boolean;
  is_suppressed?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  tab_name?: string;
}

/** Prefer side-by-side panes; try a vertical split only if width is insufficient. */
export function splitDirection(
  pane: PaneGeometry, minColumns = 50, minRows = 10,
): "down" | "right" | null {
  const rows = pane.pane_rows ?? 0;
  const columns = pane.pane_columns ?? 0;
  if (rows >= minRows && Math.floor(columns / 2) >= minColumns) return "right";
  if (columns >= minColumns && Math.floor(rows / 2) >= minRows) return "down";
  return null;
}

export type Placement = { paneId: number; direction: "down" | "right" } | "new-tab" | null;

/** Prefer the largest safe sibling before shrinking the parent. Null means
 * the parent/layout could not be inspected safely.
 */
export function selectPlacement(
  panes: PaneGeometry[], parentId: number, minColumns = 50, minRows = 10,
): Placement {
  const parent = panes.find(p => !p.is_plugin && p.id === parentId);
  if (!parent || !Number.isSafeInteger(parent.tab_id)) return null;
  // Exited/held terminals still occupy visible, splittable space. Excluding
  // them would shrink the parent while a large completed sibling stays intact.
  const usable = panes.filter(p => p.tab_id === parent.tab_id && !p.is_plugin &&
    !p.is_floating && !p.is_suppressed && p.is_selectable !== false &&
    Number.isSafeInteger(p.pane_rows) && p.pane_rows! > 0 &&
    Number.isSafeInteger(p.pane_columns) && p.pane_columns! > 0);
  const candidates = usable.filter(p => splitDirection(p, minColumns, minRows) !== null);
  candidates.sort((a, b) => Number(a.id === parentId) - Number(b.id === parentId) ||
    b.pane_rows! * b.pane_columns! - a.pane_rows! * a.pane_columns! || a.id - b.id);
  const target = candidates[0];
  return target ? { paneId: target.id, direction: splitDirection(target, minColumns, minRows)! } : "new-tab";
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
