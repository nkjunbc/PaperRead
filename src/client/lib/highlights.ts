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
      const horizontallyClose = rect.left <= last.left + last.width + 2 && last.left <= rect.left + rect.width + 2;
      if (sameLine && horizontallyClose) {
        const left = Math.min(last.left, rect.left);
        const top = Math.min(last.top, rect.top);
        const right = Math.max(last.left + last.width, rect.left + rect.width);
        const bottom = Math.max(last.top + last.height, rect.top + rect.height);
        merged[merged.length - 1] = { left, top, width: right - left, height: bottom - top };
        continue;
      }
    }
    // Native DOMRect exposes geometry on its prototype, so spreading it produces {}.
    merged.push({ left:rect.left, top:rect.top, width:rect.width, height:rect.height });
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
  /** Actual glyph bounds from DOM Range, including proportional fonts and pdf.js transforms. */
  glyphs?: { rect: PixelRect; text: string }[];
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

const bottomOf = (rect: PixelRect) => rect.top + rect.height;
const rightOf = (rect: PixelRect) => rect.left + rect.width;

/** How wide the space before a run may be, on the run's row, for the two runs it parts to be
 * words of one line: a space at least this wide parts two lines (two columns' lines). */
type WordSpace = (span: SpanBox) => number;

/** The page's text columns: each one's left edge, the long runs that begin its lines, and the
 * word's space they were found with. */
interface Columns {
  edges: number[];
  lines: SpanBox[];
  wordSpace: WordSpace;
}

const overlap = (a: PixelRect, b: PixelRect) => Math.min(bottomOf(a), bottomOf(b)) - Math.max(a.top, b.top);

/** A piece of a line (linePieces), with the word's space of the row it begins on. */
interface Piece extends SpanBox {
  space: number;
}

/**
 * The pieces of the page's lines: runs on one line that follow each other a word's space apart
 * (or touch) are one piece. pdf.js gives some PDFs a run for every word; only put back together
 * do they show where a column's lines begin and how far they reach. A gutter is wider than a
 * word's space, so a piece never runs from one column into the next.
 */
function linePieces(spans: SpanBox[], wordSpace: WordSpace): Piece[] {
  const pieces: { rect: PixelRect; text: string; first: PixelRect; last: PixelRect; space: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.rect.left - b.rect.left)) {
    const sameLine = (rect: PixelRect) => overlap(rect, span.rect) > Math.min(rect.height, span.rect.height) / 2;
    const piece = pieces.find((candidate) => {
      const gap = span.rect.left - rightOf(candidate.rect);
      return gap >= -1 && gap < wordSpace(span) && (sameLine(candidate.first) || sameLine(candidate.last));
    });
    if (piece === undefined) {
      pieces.push({ rect: span.rect, text: span.text, first: span.rect, last: span.rect, space: wordSpace(span) });
      continue;
    }
    piece.rect = unionRect([piece.rect, span.rect]);
    piece.text = `${piece.text} ${span.text}`;
    piece.last = span.rect;
  }
  return pieces.map(({ rect, text, space }) => ({ rect, text, space }));
}

/**
 * A word's space on a page whose words may be set wider apart than half a line, as justified
 * text sets those of a loose line: on a row set word by word (three spaces or more between its
 * runs), a space narrower than half again the row's usual one. A gutter is wider than that, and
 * no space as wide as a line is tall is a word's: a gutter is wider still. A row of a few runs
 * (a line in one run, two columns' lines side by side) has no usual space to go by; there a
 * word's space stays narrower than half a line.
 */
function looseWordSpace(spans: SpanBox[], lineHeight: number): WordSpace {
  const rowSpace = new Map<SpanBox, number>();
  for (const row of rowsOf(spans)) {
    const spaces: number[] = [];
    let reach = rightOf(row.spans[0].rect);
    for (const span of row.spans.slice(1)) {
      if (span.rect.left - reach > 1) spaces.push(span.rect.left - reach);
      reach = Math.max(reach, rightOf(span.rect));
    }
    const space = Math.max(lineHeight * 0.5, spaces.length >= 3 ? Math.min(lineHeight, median(spaces) * 1.5) : 0);
    for (const span of row.spans) rowSpace.set(span, space);
  }
  return (span) => rowSpace.get(span) ?? lineHeight * 0.5;
}

/**
 * The page's text columns, found from its long runs: every long run starts at its column's
 * left edge (a paragraph's first line may be indented by a word or so, which the tolerance
 * absorbs). Justified columns can overlap horizontally, so a run's left edge, never its centre
 * or right edge, is what identifies its column.
 *
 * pdf.js also splits lines part-way along (at a change of font, a wide space, after a section
 * number): a run that begins a word's space after another on its line does not begin the line,
 * and long second runs that begin at about the same place on a few lines are no column, for a
 * column edge has a gutter before it: more of its lines begin there than run from further left
 * across it to its column's far side. A column after the first also stands beside another,
 * with that column's lines to the left of its own; a block indented within a column (an
 * abstract, a list, a section title after its number) or text centred above or below the
 * columns (a title, a footer) has none.
 *
 * The evidence is read from the pieces of the lines (linePieces), never the runs themselves: a
 * page whose every word is a run of its own has no long run, yet its lines are long pieces.
 * Their words are a word's space apart, narrower than half a line. A page whose columns no line
 * shows that way is read again with the words of a loose line as one piece (looseWordSpace),
 * and taken as columns only when that finds columns its lines bear out.
 */
function columnsOf(spans: SpanBox[], lineHeight: number): Columns {
  const tight: WordSpace = () => lineHeight * 0.5;
  const found = columnsWith(spans, lineHeight, tight);
  if (found.edges.length > 1) return { edges: found.edges, lines: found.lines, wordSpace: tight };
  const loose = looseWordSpace(spans, lineHeight);
  const wider = columnsWith(spans, lineHeight, loose);
  return wider.supported > 1 ? { edges: wider.edges, lines: wider.lines, wordSpace: loose } : { edges: found.edges, lines: found.lines, wordSpace: tight };
}

/** The columns the pieces of the lines show with `wordSpace` (columnsOf), and how many of them
 * their lines bear out. */
function columnsWith(spans: SpanBox[], lineHeight: number, wordSpace: WordSpace): { edges: number[]; lines: SpanBox[]; supported: number } {
  const pieces = linePieces(spans, wordSpace);
  const continues = (span: Piece) => pieces.some((other) => other !== span && overlap(other.rect, span.rect) > Math.min(other.rect.height, span.rect.height) / 2
    && rightOf(other.rect) <= span.rect.left + 1 && span.rect.left - rightOf(other.rect) < span.space);
  const longRuns = pieces.filter((span) => span.rect.width >= lineHeight * COLUMN_EVIDENCE_LINES && !continues(span));
  const clusters: { left: number; right: number; lines: SpanBox[] }[] = [];
  for (const span of longRuns.sort((a, b) => a.rect.left - b.rect.left)) {
    const cluster = clusters.find((candidate) => Math.abs(candidate.left - span.rect.left) <= lineHeight * COLUMN_EDGE_TOLERANCE_LINES);
    if (cluster === undefined) clusters.push({ left: span.rect.left, right: rightOf(span.rect), lines: [span] });
    else {
      cluster.lines.push(span);
      cluster.right = Math.max(cluster.right, rightOf(span.rect));
    }
  }
  // Runs of the column before may overshoot into this one (justified columns can overlap);
  // only a run reaching past the middle of this column's lines runs across it.
  const runAcross = (column: { left: number; right: number }) => pieces.filter((span) => span.rect.left < column.left - lineHeight * 0.5 && rightOf(span.rect) > (column.left + column.right) / 2).length;
  const beside = (column: { left: number; lines: SpanBox[] }, before: SpanBox[]) => column.lines.filter((line) => before.some((other) => other.rect.left < column.left - lineHeight && overlap(other.rect, line.rect) > 0)).length;
  // A column needs a few lines of evidence; a single wide caption or equation is not one.
  const supported: typeof clusters = [];
  for (const cluster of clusters) {
    if (cluster.lines.length < 3 || runAcross(cluster) >= cluster.lines.length) continue;
    if (supported.length > 0 && beside(cluster, supported.flatMap((column) => column.lines)) < 3) continue;
    supported.push(cluster);
  }
  const found = supported.length > 0 ? supported : clusters;
  if (found.length === 0) return { edges: [Math.min(...spans.map((span) => span.rect.left))], lines: [], supported: 0 };
  return { edges: found.map((cluster) => cluster.left), lines: found.flatMap((cluster) => cluster.lines), supported: supported.length };
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

/** The column a point is in: the last column whose left edge is at or left of it, with the
 * same half-line tolerance as columnOf, so a drag begun a few pixels before a column's first
 * glyph is still a drag in that column. */
function columnAt(x: number, edges: number[], lineHeight: number): number {
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One printed line in reading order. `column` is -1 for a line that runs across the columns. */
interface Line extends Row {
  band: number;
  column: number;
}

/**
 * The page's lines in reading order, as a reader of a printed page takes them: down the first
 * column, then down the next. A line running across the columns (a title, a full-width
 * caption) divides the page into bands, each read column by column, with the dividing line
 * read between them. Lines are grouped per column, so the two columns' lines are never one
 * row however close their baselines sit.
 *
 * Above the columns' text a page may have its head (a title and author block, a running head)
 * and below it its foot (a page number, a conference footer): everything from the column text
 * out to a line crossing a gutter there is read before or after the columns, line by line
 * across the page, never as the start or end of one column.
 */
function readingOrder(spans: SpanBox[]): { lines: Line[]; locate(point: Point): number } | null {
  if (spans.length === 0) return null;
  const lineHeight = median(spans.map((span) => span.rect.height));
  const { edges, lines: columnLines, wordSpace } = columnsOf(spans, lineHeight);
  const lastEdge = edges[edges.length - 1];
  const pageRight = Math.max(...spans.map((span) => rightOf(span.rect)));
  // Across the columns: begins in the first column and reaches past the middle of the last.
  // pdf.js may split such a line into runs a word's space apart (a caption): they are one line.
  // Runs that overlap by half a line or more are two columns' lines that overshoot, never one.
  const across = new Set<SpanBox>();
  const acrossLine = (runs: SpanBox[]) => {
    if (runs.length > 0 && runs[0].rect.left < edges[1] - lineHeight * 0.5 && Math.max(...runs.map((run) => rightOf(run.rect))) > (lastEdge + pageRight) / 2) for (const run of runs) across.add(run);
  };
  if (edges.length > 1) {
    for (const row of rowsOf(spans)) {
      let runs: SpanBox[] = [];
      for (const span of row.spans) {
        const gap = span.rect.left - Math.max(...runs.map((run) => rightOf(run.rect)));
        if (runs.length > 0 && (gap <= -lineHeight * 0.5 || gap >= wordSpace(span))) {
          acrossLine(runs);
          runs = [];
        }
        runs.push(span);
      }
      acrossLine(runs);
    }
  }
  const crossesGutter = (rect: PixelRect) => edges.slice(1).some((edge) => rect.left < edge - lineHeight * 0.5 && rightOf(rect) > edge);
  const bodyTop = Math.min(...columnLines.map((span) => span.rect.top));
  const bodyBottom = Math.max(...columnLines.map((span) => bottomOf(span.rect)));
  const crossing = spans.filter((span) => crossesGutter(span.rect));
  const head = Math.max(...crossing.filter((span) => bottomOf(span.rect) <= bodyTop + lineHeight * 0.25).map((span) => bottomOf(span.rect)));
  const foot = Math.min(...crossing.filter((span) => span.rect.top >= bodyBottom - lineHeight * 0.25).map((span) => span.rect.top));
  const furniture = (rect: PixelRect) => bottomOf(rect) <= head + lineHeight * 0.25 || rect.top >= foot - lineHeight * 0.25;
  const divides = (span: SpanBox) => across.has(span) || furniture(span.rect);
  const dividers = rowsOf(spans.filter(divides));
  const bandAt = (y: number) => dividers.filter((divider) => (divider.top + divider.bottom) / 2 < y).length;
  const columns = edges.map((): SpanBox[] => []);
  for (const span of spans) if (!divides(span)) columns[columnOf(edges, span.rect, lineHeight)].push(span);

  const lines: Line[] = [];
  for (let band = 0; band <= dividers.length; band += 1) {
    columns.forEach((columnSpans, column) => {
      const inBand = columnSpans.filter((span) => bandAt(span.rect.top + span.rect.height / 2) === band);
      for (const row of rowsOf(inBand)) lines.push({ ...row, band, column });
    });
    if (band < dividers.length) lines.push({ ...dividers[band], band, column: -1 });
  }

  /** The line a point is on: a dividing line under it, else the nearest line of its column in
   * its band, within a line and a half; -1 when it is nowhere near text. */
  const locate = ({ x, y }: Point): number => {
    const divider = lines.findIndex((line) => line.column === -1 && y >= line.top && y <= line.bottom);
    if (divider >= 0) return divider;
    const band = bandAt(y);
    const column = columnAt(x, edges, lineHeight);
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    lines.forEach((line, index) => {
      if (line.band !== band || line.column !== column) return;
      const distance = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0;
      if (distance < bestDistance && distance <= (line.bottom - line.top) * 1.5) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  };
  return { lines, locate };
}

/** Either end of a sweep: a point on the page, or the page's first or last line for a page
 * that a drag crossing pages begins before or ends after. */
export type SweepEnd = Point | 'start' | 'end';

/**
 * The runs a reader swept with the mouse, as a printed-page selection works: in reading order
 * from one point to the other, the rest of the first line, every line between and the start
 * of the last. A drag from the foot of the left column to the head of the right one takes the
 * end of the left column and the top of the right, never the gutter or the lines beside it.
 *
 * The browser's own selection cannot be used for this: pdf.js emits its runs in content-
 * stream order, so a DOM range between two nearby runs can span half a page of equation
 * pieces and the other column. Returns one rect per swept line plus the swept text. A rect
 * takes its height from the line's text runs; pdf.js glyph boxes are taller than the line,
 * and neighbouring lines' boxes would overlap.
 */
export function sweepSelection(spans: SpanBox[], from: SweepEnd, to: SweepEnd): { rects: PixelRect[]; text: string } | null {
  const layout = readingOrder(spans.filter((span) => span.rect.width > 0 && span.rect.height > 0 && span.text.trim().length > 0));
  if (layout === null) return null;
  const { lines, locate } = layout;
  const place = (end: SweepEnd) => (end === 'start' ? { line: 0, x: -Infinity } : end === 'end' ? { line: lines.length - 1, x: Infinity } : { line: locate(end), x: end.x });
  const a = place(from);
  const b = place(to);
  if (a.line < 0 || b.line < 0) return null;
  const [first, last] = a.line < b.line || (a.line === b.line && a.x <= b.x) ? [a, b] : [b, a];

  const swept: { rect: PixelRect; text: string }[] = [];
  for (let index = first.line; index <= last.line; index += 1) {
    const lo = index === first.line ? first.x : -Infinity;
    const hi = index === last.line ? last.x : Infinity;
    // Clip the ends by measured glyphs. Selecting one word in a long pdf.js span must not
    // select that entire span; estimating offsets from average character width also fails
    // for proportional fonts, math, ligatures and horizontally scaled text layers.
    const pieces = lines[index].spans
      .filter((span) => span.rect.left + span.rect.width >= lo && span.rect.left <= hi)
      .flatMap((span): { rect: PixelRect; text: string }[] => {
        if (!span.glyphs) return [span];
        const glyphs = span.glyphs.filter((glyph) => {
          const middle = glyph.rect.left + glyph.rect.width / 2;
          return middle >= lo && middle <= hi;
        });
        if (glyphs.length === 0) return [];
        const across = unionRect(glyphs.map((glyph) => glyph.rect));
        return [{ text: glyphs.map((glyph) => glyph.text).join(''), rect: { left: across.left, top: span.rect.top, width: across.width, height: span.rect.height } }];
      });
    if (pieces.length === 0) continue;
    swept.push({ rect: unionRect(pieces.map((piece) => piece.rect)), text: pieces.map((piece) => piece.text).join(' ') });
  }
  if (swept.length === 0) return null;
  return {
    rects: swept.map((line) => line.rect),
    text: swept.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

/** One end of a drag that may cross pages: the page and a point in page-local pixels. */
export interface PagePoint {
  page: number;
  point: Point;
}

export interface PageSweep {
  page: number;
  rects: PixelRect[];
  text: string;
}

/**
 * A drag that crosses pages, swept page by page: on the first page from the start to its last
 * line, every page between whole, and on the last page from its first line to the end. A page
 * whose text was never measured (not drawn while the drag passed) is skipped, never guessed.
 */
export function sweepPages(spansOf: (page: number) => SpanBox[] | undefined, from: PagePoint, to: PagePoint): PageSweep[] {
  const [first, last] = from.page <= to.page ? [from, to] : [to, from];
  const sweeps: PageSweep[] = [];
  for (let page = first.page; page <= last.page; page += 1) {
    const spans = spansOf(page);
    if (spans === undefined) continue;
    const swept = sweepSelection(spans, page === first.page ? first.point : 'start', page === last.page ? last.point : 'end');
    if (swept !== null) sweeps.push({ page, ...swept });
  }
  return sweeps;
}

/**
 * The full pipeline from a drag selection to storable highlight rects:
 * merge same-line rects first (fewer, cleaner boxes), then convert to
 * page-ratio regions. Returns `null` when nothing survives (e.g. every rect
 * was entirely outside the page box). Every line is kept: a selection that
 * marks more lines than a record holds is refused before it is saved
 * (AnnotationSession), never cut short here.
 */
export function selectionToRegions(rawRects: PixelRect[], pageBox: PixelRect, page: number): Region[] | null {
  const merged = mergeLineRects(rawRects.filter((r) => r.width > 0 && r.height > 0));
  const regions = rectsToRegions(merged, pageBox, page);
  return regions.length > 0 ? regions : null;
}
