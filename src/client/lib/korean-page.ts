import type { Block, Region, Translation } from '../../shared/contracts';
import { selectTranslations } from '../../shared/translations';
import { pageRenderSize, type Size } from './geometry';
import { describeTranslationState } from './status';

/** Which side of a two-column page a flow item belongs to. `full` spans both
 * columns (or the page's only column, when there is just one). */
export type Column = 'left' | 'right' | 'full';

/** Kinds whose blocks carry Korean prose once translated (spec: heading/paragraph/caption). */
const TEXT_KINDS = new Set<Block['kind']>(['heading', 'paragraph', 'caption']);

/** A translated prose block. `text` is null while there is nothing to show yet —
 * the spec calls for leaving that slot blank, never a placeholder or the source text.
 * `align` is 'center' for a short block the original centred in its column (a title, an
 * "Abstract" heading). */
export interface KoreanTextItem {
  kind: 'text';
  block: Block;
  column: Column;
  text: string | null;
  /** Only v2 translations use inline math/emphasis markers. Legacy text stays literal. */
  promptVersion?: string;
  align: 'center' | 'start';
}

/** A block whose original appearance is kept — figure/table/equation/reference/unsupported.
 * `region` is the block's bounding box where it starts on this page, in the page's own [0,1]
 * ratio coordinates, ready for `regionToPixels`. A crop that runs on into the next column or
 * onto the next page (a worked example's numeric lines) has its later parts in `continued`,
 * one box per column or page in reading order; they are shown under the first part, set the
 * same way. `align` and `inset` keep it where the original put it across its column: centred
 * there, or indented by `inset` (page-width fraction) from the column's text edge. */
export interface KoreanSourceItem {
  kind: 'source';
  block: Block;
  column: Column;
  region: Region;
  continued: Region[];
  align: 'center' | 'start';
  inset: number;
}

export type KoreanFlowItem = KoreanTextItem | KoreanSourceItem;

export interface KoreanPageLayout {
  page: number;
  columnCount: 1 | 2;
  /** In the paper's own reading order (block.order), ready to flow into the page grid. */
  items: KoreanFlowItem[];
  /** True when the complete original page must remain visible: no text can be translated,
   * some of the page's prose has no translation yet, or a requested translation has finally
   * failed. A page turns Korean only as a whole. */
  sourceOnly: boolean;
}

/** Horizontal/vertical margins cleared for Korean prose, as a ratio of the page box.
 * Not specified by the source spec; picked to resemble a normal article margin and kept
 * as named constants so they can be tuned later without touching layout code. */
export const PAGE_MARGIN_X = 0.08;
export const PAGE_MARGIN_TOP = 0.06;
export const PAGE_MARGIN_BOTTOM = 0.06;
export const COLUMN_GUTTER = 0.04;
/** Emitted after a page's typography settles, including when its outer height stays fixed. */
export const KOREAN_PAGE_LAYOUT_EVENT = 'paperread-korean-page-layout';

export interface KoreanPageFit { fontScale:number; lineHeight:number; paragraphGap:number }
export interface MeasuredKoreanPageFit extends KoreanPageFit { height:number }

/** Tighten spacing, never the type: at most three layout reads, and a page still longer than
 * its source grows taller (the Korean page only sets a minimum height) instead of shrinking
 * its text. fontScale stays 1; it remains part of the fit so saved ink keeps its layout key. */
export function fitKoreanPageHeight(sourceHeight:number,measure:(fit:KoreanPageFit)=>number):MeasuredKoreanPageFit {
  const target=sourceHeight*1.051;
  const check=(fit:KoreanPageFit):MeasuredKoreanPageFit=>({...fit,height:measure(fit)});
  const spacious=check({fontScale:1,lineHeight:1.6,paragraphGap:.8});
  if(spacious.height<=target)return spacious;
  const balanced=check({fontScale:1,lineHeight:1.5,paragraphGap:.55});
  if(balanced.height<=target)return balanced;
  return check({fontScale:1,lineHeight:1.4,paragraphGap:.4});
}

/** A block narrower than this (as a fraction of page width) is counted toward a column;
 * at or above it, the block is treated as spanning the full page width instead. */
const FULL_WIDTH_RATIO = 0.55;
/** A block's horizontal center must fall clearly left/right of the midline to count toward
 * that column — this keeps a block straddling the gutter from tipping the vote either way. */
const COLUMN_MID_LOW = 0.47;
const COLUMN_MID_HIGH = 0.53;
/** A translated paragraph is never rendered smaller than this fraction of the page height,
 * even if the extractor measured an unusually small source font. */
const MIN_FONT_SIZE_RATIO = 0.012;

function homePage(block: Block): number | null {
  return block.regions[0]?.page ?? null;
}

/** Where a block starts on `page`: the union of its regions there that share the column of its
 * first one. A paragraph that runs from the foot of the left column on into the right column
 * belongs to the left column, where it starts — not to a full-width span across both. */
function leadingBoundsOnPage(block: Block, page: number): Region | null {
  const onPage = block.regions.filter((region) => region.page === page);
  if (onPage.length === 0) return null;
  const first = onPage[0];
  const run = onPage.filter((region) => Math.abs(region.x - first.x) < 0.25);
  const left = Math.min(...run.map((region) => region.x));
  const top = Math.min(...run.map((region) => region.y));
  const right = Math.max(...run.map((region) => region.x + region.width));
  const bottom = Math.max(...run.map((region) => region.y + region.height));
  return { page, x: left, y: top, width: right - left, height: bottom - top };
}

/** The union bounding box of regions that all sit on one page. */
function bounds(regions: readonly Region[]): Region {
  const left = Math.min(...regions.map((region) => region.x));
  const top = Math.min(...regions.map((region) => region.y));
  const right = Math.max(...regions.map((region) => region.x + region.width));
  const bottom = Math.max(...regions.map((region) => region.y + region.height));
  return { page: regions[0].page, x: left, y: top, width: right - left, height: bottom - top };
}

/** A block's regions as boxes, one per column or page it runs through, in reading order. It runs
 * into the next column where a piece far to the side lies wholly above the one before it; pieces
 * side by side stay one box. */
function partsOf(block: Block): Region[] {
  const runs: Region[][] = [];
  for (const region of block.regions) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run !== undefined && previous !== undefined && run[0].page === region.page
      && !(Math.abs(region.x - run[0].x) >= 0.25 && region.y + region.height <= previous.y)) run.push(region);
    else runs.push([region]);
  }
  return runs.map(bounds);
}

/**
 * Blocks whose reading position starts on `page`, in the paper's own reading order.
 *
 * A block "belongs" to the page its first region sits on — the extractor already encodes
 * column-aware reading order into `order` (top band, then left column, then right column),
 * so sorting the page's own blocks by `order` reproduces that order without recomputing it.
 */
export function blocksForPage(blocks: readonly Block[], page: number): Block[] {
  return blocks.filter((block) => homePage(block) === page).sort((a, b) => a.order - b.order);
}

/**
 * Two columns need a clear narrow block on each side at a matching vertical position. This
 * preserves the extractor's two-column reading order even when each column's final prose has
 * already been joined into one multi-line block.
 */
export function detectColumnCount(pageBlocks: readonly Block[], page: number): 1 | 2 {
  const left: { box: Region; multiline: boolean }[] = [];
  const right: { box: Region; multiline: boolean }[] = [];
  for (const block of pageBlocks) {
    const box = leadingBoundsOnPage(block, page);
    if (box === null || box.width >= FULL_WIDTH_RATIO) continue;
    const center = box.x + box.width / 2;
    const candidate = { box, multiline: block.regions.filter((region) => region.page === page).length >= 2 };
    if (center < COLUMN_MID_LOW) left.push(candidate);
    else if (center > COLUMN_MID_HIGH) right.push(candidate);
  }
  const verticallyMatched = left.some((a) => right.some((b) =>
    Math.max(a.box.y, b.box.y) <= Math.min(a.box.y + a.box.height, b.box.y + b.box.height) + 0.03
    && ((left.length >= 2 && right.length >= 2) || (a.multiline && b.multiline)),
  ));
  return left.length > 0 && right.length > 0 && verticallyMatched ? 2 : 1;
}

function columnFor(box: Region, columnCount: 1 | 2): Column {
  if (columnCount === 1) return 'full';
  if (box.width >= FULL_WIDTH_RATIO) return 'full';
  // Set across the midline (a centred title) it belongs to neither column: its centre sits a
  // hair either side of 0.5 and would otherwise push it into one of them.
  if (box.x < 0.48 && box.x + box.width > 0.52) return 'full';
  return box.x + box.width / 2 < 0.5 ? 'left' : 'right';
}

/** The completed Korean text for one block, or null while there is nothing to show —
 * pending/running/failed/unsupported all leave the slot blank (spec: never a placeholder,
 * never the source text, in the Korean page itself). */
function translatedText(block: Block, byBlock: ReadonlyMap<string, Translation>): string | null {
  const state = describeTranslationState(block, byBlock.get(block.blockId));
  return state.status === 'completed' ? state.text : null;
}

/**
 * Build one page's Korean layout: prose blocks carry translated text (or a blank slot),
 * everything else (figure/table/equation/reference/unsupported) carries the original region
 * to crop and place inline, all in the paper's own reading order. `modelId` is the job's
 * model (null without a job); each block shows the record the progress counts.
 */
export function buildKoreanLayout(blocks: readonly Block[], translations: readonly Translation[], page: number, modelId: string | null): KoreanPageLayout {
  const pageBlocks = blocksForPage(blocks, page);
  const columnCount = detectColumnCount(pageBlocks, page);
  const byBlock = selectTranslations(pageBlocks, translations, modelId);

  // The horizontal extent of each column's own content on the original page: a crop is placed
  // against it, so a centred figure or equation stays centred on the Korean page.
  const extents = new Map<Column, [number, number]>();
  const widen = (column: Column, box: Region) => {
    const [lo, hi] = extents.get(column) ?? [box.x, box.x + box.width];
    extents.set(column, [Math.min(lo, box.x), Math.max(hi, box.x + box.width)]);
  };
  for (const block of pageBlocks) {
    const box = leadingBoundsOnPage(block, page);
    if (box === null) continue;
    const column = columnFor(box, columnCount);
    widen(column, box);
    if (column !== 'full') widen('full', box);
  }

  // Text alignment compares headings with the body edges, not with a long heading's own
  // bounds. A centred two-line title often occupies far more than 70% of the body width.
  const proseExtents=new Map<Column,[number,number]>();
  const bodySizes=pageBlocks.filter(block=>block.kind==='paragraph'&&block.fontSize>0).map(block=>block.fontSize).sort((a,b)=>a-b);
  const bodySize=bodySizes[Math.floor(bodySizes.length/2)]??0;
  for(const block of pageBlocks.filter(block=>block.kind==='paragraph')) {
    const box=leadingBoundsOnPage(block,page);
    if(!box)continue;
    const column=columnFor(box,columnCount);
    for(const target of column==='full'?['full'] as const:[column,'full'] as const) {
      const [lo,hi]=proseExtents.get(target)??[box.x,box.x+box.width];
      proseExtents.set(target,[Math.min(lo,box.x),Math.max(hi,box.x+box.width)]);
    }
  }

  const items: KoreanFlowItem[] = [];
  let hasTranslatableBlock = false;
  let hasFailedTranslation = false;
  let hasMissingTranslation = false;
  for (const block of pageBlocks) {
    const onPage = block.regions.filter((region) => region.page === page);
    if (onPage.length === 0) continue;
    const box = bounds(onPage);
    const column = columnFor(leadingBoundsOnPage(block, page) ?? box, columnCount);

    if (TEXT_KINDS.has(block.kind) && block.translatable) {
      hasTranslatableBlock = true;
      hasFailedTranslation ||= byBlock.get(block.blockId)?.status === 'failed';
      const text = translatedText(block, byBlock);
      hasMissingTranslation ||= text === null;
      const [lo, hi] = proseExtents.get(column) ?? extents.get(column) ?? [0, 1];
      const lines=block.regions.filter(region=>region.page===page);
      const centre=(lo+hi)/2;
      // A single printed title can fill the body width, leaving no inset as evidence.
      // Its first position, larger type, full-page span and symmetric centre distinguish
      // that case from the ordinary left-aligned section headings below it.
      const prominentTitle=column==='full'&&block===pageBlocks[0]&&box.y<.2&&bodySize>0&&block.fontSize>bodySize*1.1
        &&Math.abs(box.x+box.width/2-centre)<.01;
      const centred=block.kind==='heading'
        ? lines.every(line=>Math.abs(line.x+line.width/2-centre)<.025)
          && (prominentTitle||lines.some(line=>line.x>lo+.01&&line.x+line.width<hi-.01))
        : box.width < (hi-lo)*.7 && Math.abs(box.x+box.width/2-centre)<.03;
      items.push({ kind: 'text', block, column, text, promptVersion: byBlock.get(block.blockId)?.promptVersion, align: centred ? 'center' : 'start' });
      continue;
    }
    if (TEXT_KINDS.has(block.kind)) continue; // heading/paragraph/caption with no text: nothing to show

    const [first, ...continued] = partsOf(block);
    const [lo, hi] = extents.get(column) ?? [0, 1];
    const centred = Math.abs(first.x + first.width / 2 - (lo + hi) / 2) < 0.03;
    items.push({ kind: 'source', block, column, region: first, continued, align: centred ? 'center' : 'start', inset: centred ? 0 : Math.max(0, first.x - lo) });
  }

  // The page is the unit of publication: until every paragraph on it has its Korean, the whole
  // original page stays. A Korean page with a blank slot would silently drop that paragraph —
  // after a re-extraction a page can keep most of its translations while one paragraph waits
  // for the user to resume, and nothing on a half-Korean page would say that text is missing.
  const sourceOnly = !hasTranslatableBlock || hasFailedTranslation || hasMissingTranslation;
  return { page, columnCount, items, sourceOnly };
}

/** One row of the Korean page grid: either a full-width item, or a pair of column stacks
 * running in parallel until the next full-width item breaks them. */
export type KoreanSegment =
  | { type: 'full'; item: KoreanFlowItem }
  | { type: 'columns'; left: KoreanFlowItem[]; right: KoreanFlowItem[] };

/**
 * Group a page's flow items into rendering segments.
 *
 * A one-column page always yields one `columns` segment with everything in `left` and an
 * empty `right`, so a caller renders the same two-stack grid either way. A two-column page
 * flushes its running left/right stacks whenever a full-width item interrupts them, so a
 * wide heading or figure spans the full page width instead of being squeezed into a column.
 */
export function groupKoreanSegments(items: readonly KoreanFlowItem[], columnCount: 1 | 2): KoreanSegment[] {
  if (columnCount === 1) {
    return items.length === 0 ? [] : [{ type: 'columns', left: [...items], right: [] }];
  }

  const segments: KoreanSegment[] = [];
  let left: KoreanFlowItem[] = [];
  let right: KoreanFlowItem[] = [];
  const flush = () => {
    if (left.length > 0 || right.length > 0) segments.push({ type: 'columns', left, right });
    left = [];
    right = [];
  };
  for (const item of items) {
    if (item.column === 'full') {
      flush();
      segments.push({ type: 'full', item });
      continue;
    }
    if (item.column === 'left') left.push(item);
    else right.push(item);
  }
  flush();
  return segments;
}

/** The font size, in pixels, a translated paragraph should render at for the page's current
 * rendered height. Mirrors the block's own font-size ratio before page fitting, floored so a
 * near-zero source measurement never collapses to invisible text. */
export function koreanFontSizePx(block: Block, renderedPageHeight: number): number {
  const ratio = Number.isFinite(block.fontSize) && block.fontSize > 0 ? block.fontSize : MIN_FONT_SIZE_RATIO;
  return Math.max(ratio, MIN_FONT_SIZE_RATIO) * renderedPageHeight;
}

/** One authoritative height source for both Korean placeholders and boundaries. */
export function koreanPageHeight(measured: number | undefined, fallback: number): number {
  return measured !== undefined && Number.isFinite(measured) && measured > 0 ? measured : fallback;
}

/** The unmeasured height, derived from the page's own PDF dimensions at this zoom. */
export function koreanPageFallbackHeight(intrinsic: Size, zoom: number): number {
  return pageRenderSize(intrinsic, zoom).height;
}
