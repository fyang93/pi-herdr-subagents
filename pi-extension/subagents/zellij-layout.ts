/** Size-bounded tiled placement adapted from HazAT/pi-interactive-subagents (MIT). */
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

/** Approximate visual aspect ratio: a terminal cell is about twice as tall as wide. */
function splitDirections(pane: PaneGeometry, minColumns: number, minRows: number): ("down" | "right")[] {
  const size = measurePane(pane);
  if (!size) return [];
  const { rows, columns, rowInset, columnInset } = size;
  const directions: ("down" | "right")[] = rows * 2 > columns ? ["down", "right"] : ["right", "down"];
  return directions.filter(direction => direction === "right"
    ? rows - rowInset >= minRows && Math.floor(columns / 2) - columnInset >= minColumns
    : columns - columnInset >= minColumns && Math.floor(rows / 2) - rowInset >= minRows);
}

export function splitDirection(
  pane: PaneGeometry, minColumns = 50, minRows = 10,
): "down" | "right" | null {
  return splitDirections(pane, minColumns, minRows)[0] ?? null;
}

export type Placement = { paneId: number; direction: "down" | "right" } | null;

/** Split the largest eligible pane in the caller's tab. */
export function selectPlacement(
  panes: PaneGeometry[], parentId: number, minColumns = 50, minRows = 10,
): Placement {
  const parent = panes.find(p => !p.is_plugin && p.id === parentId);
  if (!parent || !Number.isSafeInteger(parent.tab_id)) return null;
  if (parent.is_floating || parent.is_suppressed || parent.is_selectable === false ||
      panes.some(p => p.tab_id === parent.tab_id && p.is_fullscreen)) return null;
  const usable = panes.filter(p => p.tab_id === parent.tab_id && !p.is_plugin &&
    !p.is_floating && !p.is_suppressed && p.is_selectable !== false);
  if (usable.some(p => !measurePane(p))) return null;
  let best: Placement = null, bestArea = 0;
  for (const p of usable) {
    const area = p.pane_columns! * p.pane_rows!;
    if (area < bestArea || (area === bestArea && best !== null &&
        !(best.paneId === parentId ? p.id !== parentId : p.id !== parentId && p.id < best.paneId))) continue;
    const direction = splitDirection(p, minColumns, minRows);
    if (direction) { best = { paneId: p.id, direction }; bestArea = area; }
  }
  return best;
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
