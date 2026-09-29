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

/** Split the largest eligible pane, provided no sibling will exceed the parent
 * in width or height after the split. Null means no safe placement.
 */
export function selectPlacement(
  panes: PaneGeometry[], parentId: number, minColumns = 50, minRows = 10,
  parentMinColumns = minColumns, parentMinRows = minRows,
): Placement {
  const parent = panes.find(p => !p.is_plugin && p.id === parentId);
  if (!parent || !Number.isSafeInteger(parent.tab_id)) return null;
  if (parent.is_floating || parent.is_suppressed || parent.is_selectable === false ||
      panes.some(p => p.tab_id === parent.tab_id && p.is_fullscreen)) return null;
  // Exited/held terminals still occupy space and must participate in size checks.
  const usable = panes.filter(p => p.tab_id === parent.tab_id && !p.is_plugin &&
    !p.is_floating && !p.is_suppressed && p.is_selectable !== false);
  // Missing geometry is not evidence that a sibling lacks space. In particular,
  // never shrink the parent just because a sibling could not be inspected.
  if (usable.some(p => !measurePane(p))) return null;
  const siblingsFit = (columns: number, rows: number) => usable.every(p =>
    p.id === parentId || (p.pane_columns! <= columns && p.pane_rows! <= rows));
  if (!siblingsFit(parent.pane_columns!, parent.pane_rows!)) return null;
  let best: Placement = null, bestArea = 0;
  for (const p of usable) {
    const area = p.pane_columns! * p.pane_rows!;
    if (p.id === parentId || area < bestArea || (area === bestArea && p.id > best!.paneId)) continue;
    const direction = splitDirection(p, minColumns, minRows);
    if (direction) { best = { paneId: p.id, direction }; bestArea = area; }
  }
  if (parent.pane_columns! * parent.pane_rows! <= bestArea) return best;
  // Only a strictly larger parent can win. Exact halves avoid rounding overshoot.
  const direction = splitDirections(parent, Math.max(minColumns, parentMinColumns), Math.max(minRows, parentMinRows))
    .find(d => d === "right"
      ? parent.pane_columns! % 2 === 0 && siblingsFit(parent.pane_columns! / 2, parent.pane_rows!)
      : parent.pane_rows! % 2 === 0 && siblingsFit(parent.pane_columns!, parent.pane_rows! / 2));
  return direction ? { paneId: parentId, direction } : best;
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
