/** Space-aware placement adapted from HazAT/pi-interactive-subagents (MIT).
 * Tiled splits preserve simultaneous visibility; when they become too small,
 * continue in a new tab instead of stacking and hiding panes.
 */
export interface PaneGeometry {
  id: number;
  is_plugin: boolean;
  is_floating?: boolean;
  is_suppressed?: boolean;
  is_fullscreen?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  pane_content_rows?: number;
  pane_content_columns?: number;
  tab_id?: number;
  tab_name?: string;
}

function measurePane(pane: PaneGeometry) {
  const rows = pane.pane_rows ?? 0;
  const columns = pane.pane_columns ?? 0;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows <= 0 || columns <= 0) return null;
  const contentRows = pane.pane_content_rows ?? Math.max(0, rows - 2);
  const contentColumns = pane.pane_content_columns ?? Math.max(0, columns - 2);
  if (!Number.isSafeInteger(contentRows) || !Number.isSafeInteger(contentColumns) ||
      contentRows < 0 || contentRows > rows || contentColumns < 0 || contentColumns > columns) return null;
  // Reserve at least two frame cells on each resulting pane, even if the current
  // pane is borderless or touches a screen edge. Do not count frames as content.
  const rowInset = Math.max(2, rows - contentRows);
  const columnInset = Math.max(2, columns - contentColumns);
  return { rows, columns, rowInset, columnInset };
}

/** Prefer side-by-side panes; try a top/bottom split if width is insufficient. */
export function splitDirection(
  pane: PaneGeometry, minColumns = 50, minRows = 10,
): "down" | "right" | null {
  const size = measurePane(pane);
  if (!size) return null;
  const { rows, columns, rowInset, columnInset } = size;
  if (rows - rowInset >= minRows && Math.floor(columns / 2) - columnInset >= minColumns) return "right";
  if (columns - columnInset >= minColumns && Math.floor(rows / 2) - rowInset >= minRows) return "down";
  return null;
}

export type Placement = { paneId: number; direction: "down" | "right" } | "new-tab" | null;

/** Prefer the largest safe sibling before shrinking the parent. Null means
 * the parent/layout could not be inspected safely.
 */
export function selectPlacement(
  panes: PaneGeometry[], parentId: number, minColumns = 50, minRows = 10,
  parentMinColumns = minColumns, parentMinRows = minRows,
): Placement {
  const parent = panes.find(p => !p.is_plugin && p.id === parentId);
  if (!parent || !Number.isSafeInteger(parent.tab_id)) return null;
  if (parent.is_floating || parent.is_suppressed || parent.is_selectable === false ||
      panes.some(p => p.tab_id === parent.tab_id && p.is_fullscreen)) return "new-tab";
  // Exited/held terminals still occupy visible, splittable space. Excluding
  // them would shrink the parent while a large completed sibling stays intact.
  const usable = panes.filter(p => p.tab_id === parent.tab_id && !p.is_plugin &&
    !p.is_floating && !p.is_suppressed && p.is_selectable !== false);
  // Missing geometry is not evidence that a sibling lacks space. In particular,
  // never shrink the parent just because a sibling could not be inspected.
  if (usable.some(p => !measurePane(p))) return null;
  const direction = (p: PaneGeometry) => splitDirection(p,
    p.id === parentId ? Math.max(minColumns, parentMinColumns) : minColumns,
    p.id === parentId ? Math.max(minRows, parentMinRows) : minRows);
  const candidates = usable.filter(p => direction(p) !== null);
  candidates.sort((a, b) => Number(a.id === parentId) - Number(b.id === parentId) ||
    b.pane_rows! * b.pane_columns! - a.pane_rows! * a.pane_columns! || a.id - b.id);
  const target = candidates[0];
  return target ? { paneId: target.id, direction: direction(target)! } : "new-tab";
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
