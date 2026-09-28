/** Space-aware placement adapted from HazAT/pi-interactive-subagents (MIT).
 * Tiled splits preserve simultaneous visibility; when they become too small,
 * continue in a new tab instead of stacking and hiding panes.
 */
export interface PaneGeometry {
  id: number;
  is_plugin: boolean;
  is_floating?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  tab_name?: string;
}

export function splitDirection(pane: PaneGeometry): "down" | "right" | null {
  const rows = pane.pane_rows ?? 0;
  const columns = pane.pane_columns ?? 0;
  if (rows < 5 || columns < 5) return null;
  if (rows * 4 > columns && rows > 10) return "down";
  return columns > 10 ? "right" : null;
}

function canSplit(pane: PaneGeometry, minColumns: number, minRows: number): boolean {
  const rows = pane.pane_rows ?? 0;
  const columns = pane.pane_columns ?? 0;
  switch (splitDirection(pane)) {
    case "down": return columns >= minColumns && Math.floor(rows / 2) >= minRows;
    case "right": return rows >= minRows && Math.floor(columns / 2) >= minColumns;
    default: return false;
  }
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
  const usable = panes.filter(p => p.tab_id === parent.tab_id && !p.is_plugin &&
    !p.is_floating && p.is_selectable !== false && !p.exited &&
    Number.isSafeInteger(p.pane_rows) && p.pane_rows! > 0 &&
    Number.isSafeInteger(p.pane_columns) && p.pane_columns! > 0);
  const candidates = usable.filter(p => canSplit(p, minColumns, minRows));
  candidates.sort((a, b) => Number(a.id === parentId) - Number(b.id === parentId) ||
    b.pane_rows! * b.pane_columns! - a.pane_rows! * a.pane_columns! || a.id - b.id);
  const target = candidates[0];
  return target ? { paneId: target.id, direction: splitDirection(target)! } : "new-tab";
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
