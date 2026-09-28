import type { Region } from '../../shared/contracts';

/** A rectangle in viewport pixel space, as `Range.getClientRects()` reports it. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Only a selection that starts and ends on the same page can become a
 * highlight. `null` on either side means the endpoint is not inside any
 * tracked page; a mismatch means the drag crossed a page boundary.
 */
export function resolveSelectionPage(startPage: number | null, endPage: number | null): number | null {
  if (startPage === null || endPage === null) return null;
  if (startPage !== endPage) return null;
  return startPage;
}

/**
 * Merge rects that sit on the same visual line and overlap (or nearly touch)
 * horizontally into a single bounding box, so a multi-span selection on one
 * line does not produce one rect per glyph run.
 *
 * Two rects are "the same line" when their vertical bands overlap by more
 * than half of the shorter rect's height. Rects are otherwise left distinct
 * (different lines of a paragraph stay as separate boxes).
 */
export function mergeLineRects(rects: PixelRect[]): PixelRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: PixelRect[] = [];

  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined) {
      const overlapTop = Math.max(rect.top, last.top);
      const overlapBottom = Math.min(rect.top + rect.height, last.top + last.height);
      const verticalOverlap = overlapBottom - overlapTop;
      const shorterHeight = Math.min(rect.height, last.height);
      const sameLine = shorterHeight > 0 && verticalOverlap > shorterHeight / 2;
      // Horizontally adjacent or overlapping, not a large gap away.
      const horizontallyClose = rect.left <= last.left + last.width + 2;
      if (sameLine && horizontallyClose) {
        const left = Math.min(last.left, rect.left);
        const top = Math.min(last.top, rect.top);
        const right = Math.max(last.left + last.width, rect.left + rect.width);
        const bottom = Math.max(last.top + last.height, rect.top + rect.height);
        merged[merged.length - 1] = { left, top, width: right - left, height: bottom - top };
        continue;
      }
    }
    merged.push({ ...rect });
  }
  return merged;
}

/**
 * Convert viewport-pixel rects into page-ratio `Region`s for `page`. Rects
 * are expressed relative to `pageBox` (the page element's own bounding box,
 * same coordinate space as the input rects), clamped to [0,1] so a selection
 * that spills a hairline past the page edge cannot escape it. Degenerate
 * (zero-area) rects are dropped.
 */
export function rectsToRegions(rects: PixelRect[], pageBox: PixelRect, page: number): Region[] {
  if (pageBox.width <= 0 || pageBox.height <= 0) return [];
  const regions: Region[] = [];
  for (const rect of rects) {
    const x0 = clamp01((rect.left - pageBox.left) / pageBox.width);
    const y0 = clamp01((rect.top - pageBox.top) / pageBox.height);
    const x1 = clamp01((rect.left + rect.width - pageBox.left) / pageBox.width);
    const y1 = clamp01((rect.top + rect.height - pageBox.top) / pageBox.height);
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) continue;
    regions.push({ page, x: x0, y: y0, width, height });
  }
  return regions;
}

/** One positioned run of the pdf.js text layer, in viewport pixel space. */
export interface SpanBox {
  rect: PixelRect;
  text: string;
}

export interface Point {
  x: number;
  y: number;
}

/** A run at least this many line heights wide is long enough to reveal a column's left edge. */
const COLUMN_EVIDENCE_LINES = 8;
/** A run starting within this many line heights of a column edge is that column's line. */
const COLUMN_INSET_LINES = 4;
/** Two long runs whose left edges differ by less than this many line heights share a column. */
const COLUMN_EDGE_TOLERANCE_LINES = 1.5;

interface Row {
  spans: SpanBox[];
  top: number;
  bottom: number;
}

/**
 * Group runs into text lines. A run joins a row only when its centre sits inside the row
 * and joining keeps the row about one line tall: the stacked pieces of a display equation
 * (numerator, bar, denominator, limits) must not chain into one tall pseudo-row that then
 * swallows the paragraph line beneath it. A row's extent is fixed by its first run.
 */
function rowsOf(spans: SpanBox[]): Row[] {
  const sorted = [...spans].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const rows: Row[] = [];
  for (const span of sorted) {
    const center = span.rect.top + span.rect.height / 2;
    const row = rows.find((candidate) => center >= candidate.top && center <= candidate.bottom);
    if (row === undefined) {
      rows.push({ spans: [span], top: span.rect.top, bottom: span.rect.top + span.rect.height });
      continue;
    }
    row.spans.push(span);
  }
  for (const row of rows) row.spans.sort((a, b) => a.rect.left - b.rect.left);
  return rows.sort((a, b) => a.top - b.top);
}

function rowAt(rows: Row[], y: number): number {
  const inside = rows.findIndex((row) => y >= row.top && y <= row.bottom);
  if (inside >= 0) return inside;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  rows.forEach((row, index) => {
    const distance = y < row.top ? row.top - y : y - row.bottom;
    if (distance < bestDistance && distance <= (row.bottom - row.top) * 1.5) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * The left edges of the page's text columns, found from its long runs: every long run
 * starts at its column's left edge (a paragraph's first line may be indented by a word or
 * so, which the tolerance absorbs). Justified columns can overlap horizontally, so a run's
 * left edge, never its centre or right edge, is what identifies its column.
 */
function columnEdges(spans: SpanBox[]): number[] {
  const lineHeight = spans.reduce((sum, span) => sum + span.rect.height, 0) / spans.length;
  const longRuns = spans.filter((span) => span.rect.width >= lineHeight * COLUMN_EVIDENCE_LINES);
  const edges: { left: number; count: number }[] = [];
  for (const span of longRuns.sort((a, b) => a.rect.left - b.rect.left)) {
    const edge = edges.find((candidate) => Math.abs(candidate.left - span.rect.left) <= lineHeight * COLUMN_EDGE_TOLERANCE_LINES);
    if (edge === undefined) edges.push({ left: span.rect.left, count: 1 });
    else edge.count += 1;
  }
  // A column needs a few lines of evidence; a single wide caption or equation is not one.
  const supported = edges.filter((edge) => edge.count >= 3);
  return (supported.length > 0 ? supported : edges).map((edge) => edge.left);
}

/**
 * Which column a run belongs to. A run that starts at (or a word or two after) a column
 * edge belongs to that column — text never begins left of its own column's margin, so a
 * run starting just *before* an edge is the previous column's. A piece floating
 * mid-column (an equation term, an equation number) starts far from every edge, and for
 * it the run's centre against the column boundaries decides instead.
 */
function columnOf(edges: number[], rect: PixelRect, lineHeight: number): number {
  const tolerance = lineHeight * 0.5; // a slight overshoot left of the margin is still "at" it
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const offset = rect.left - edges[index];
    if (offset >= -tolerance && offset <= lineHeight * COLUMN_INSET_LINES) return index;
  }
  const center = rect.left + rect.width / 2;
  let column = 0;
  for (let index = 1; index < edges.length; index += 1) if (center >= edges[index]) column = index;
  return column;
}

/** The column the drag started in: the last column whose left edge is at or left of the
 * start point. Judged from the point itself, so an offset baseline between the two
 * columns (which can put the start row's nearest run in the other column) cannot mislead. */
function columnAt(x: number, edges: number[], lineHeight: number): number {
  // The same half-line tolerance as columnOf: a drag begun a few pixels before a column's
  // first glyph is still a drag in that column.
  let column = 0;
  for (let index = 1; index < edges.length; index += 1) if (x >= edges[index] - lineHeight * 0.5) column = index;
  return column;
}

function unionRect(rects: PixelRect[]): PixelRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The runs a reader swept with the mouse, as a printed-page selection works: on one line,
 * everything between the two points; across lines, the rest of the first line, every line
 * between inside the same column, and the start of the last line.
 *
 * The browser's own selection cannot be used for this: pdf.js emits its runs in content-
 * stream order, so a DOM range between two nearby runs can span half a page of equation
 * pieces and the other column. Returns one rect per swept line plus the swept text.
 */
export function sweepSelection(spans: SpanBox[], down: Point, up: Point): { rects: PixelRect[]; text: string } | null {
  const usable = spans.filter((span) => span.rect.width > 0 && span.rect.height > 0 && span.text.trim().length > 0);
  const rows = rowsOf(usable);
  if (rows.length === 0) return null;
  const edges = columnEdges(usable);
  const lineHeight = usable.reduce((sum, span) => sum + span.rect.height, 0) / usable.length;
  const [start, end] = down.y < up.y || (down.y === up.y && down.x <= up.x) ? [down, up] : [up, down];
  const startRow = rowAt(rows, start.y);
  const endRow = rowAt(rows, end.y);
  if (startRow < 0 || endRow < 0) return null;
  const [first, last] = startRow <= endRow ? [startRow, endRow] : [endRow, startRow];

  const picked: SpanBox[][] = [];
  if (first === last) {
    const [lo, hi] = [Math.min(start.x, end.x), Math.max(start.x, end.x)];
    picked.push(rows[first].spans.filter((span) => span.rect.left <= hi && span.rect.left + span.rect.width >= lo));
  } else {
    // The column is the one the drag started in. Justified columns in a two-column paper
    // can overlap horizontally (a left-column run's right edge past the right column's
    // left edge), so each run is placed by which column edge its own left edge is
    // nearest to — a run that begins at the other column's edge is never swept in.
    const column = columnAt(start.x, edges, lineHeight);
    const inColumn = (span: SpanBox) => columnOf(edges, span.rect, lineHeight) === column;
    for (let index = first; index <= last; index += 1) {
      const row = rows[index].spans.filter(inColumn);
      if (index === first) picked.push(row.filter((span) => span.rect.left + span.rect.width >= start.x));
      else if (index === last) picked.push(row.filter((span) => span.rect.left <= end.x));
      else picked.push(row);
    }
  }

  const lines = picked.filter((row) => row.length > 0);
  if (lines.length === 0) return null;
  return {
    rects: lines.map((row) => unionRect(row.map((span) => span.rect))),
    text: lines.map((row) => row.map((span) => span.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * The full pipeline from a drag selection to storable highlight rects:
 * merge same-line rects first (fewer, cleaner boxes), then convert to
 * page-ratio regions. Returns `null` when nothing survives (e.g. every rect
 * was entirely outside the page box).
 */
export function selectionToRegions(rawRects: PixelRect[], pageBox: PixelRect, page: number): Region[] | null {
  const merged = mergeLineRects(rawRects.filter((r) => r.width > 0 && r.height > 0));
  const regions = rectsToRegions(merged, pageBox, page).slice(0, 200);
  return regions.length > 0 ? regions : null;
}
