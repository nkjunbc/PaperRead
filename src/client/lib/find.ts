import type { Block, Translation } from '../../shared/contracts';
import { buildKoreanLayout, groupKoreanSegments } from './korean-page';
import type { Pane } from './sync';
import { translationTextParts } from './translation-text';

/** An inline formula in a Korean paragraph shows the original's picture, not words. One
 * character no query can contain stands in for it, so nothing matches inside or across it. */
export const FORMULA_GAP = '\uFFFC';

/** One stretch of text searched as a whole: an original page, or one translated paragraph. */
export interface FindUnit {
  pane: Pane;
  page: number;
  /** The translated paragraph's block; null for an original page. */
  blockId: string | null;
  text: string;
}

/** One match. `occurrence` counts the matches before it in the same unit: that is how the page,
 * once drawn, finds it again. `start`/`end` are offsets in the unit's text. */
export interface FindHit {
  pane: Pane;
  page: number;
  blockId: string | null;
  occurrence: number;
  start: number;
  end: number;
}

const PANE_ORDER: Record<Pane, number> = { source: 0, translation: 1 };
const PANE_NAMES: Record<Pane, string> = { source: '원문', translation: '한국어' };

/**
 * The query as a pattern: taken literally, case ignored, a run of spaces in it matching any run
 * of white space in the text (a line break included), and the spaces around it dropped. Null
 * when nothing is left to look for.
 */
export function findPattern(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  const literal = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(literal, 'giu');
}

/** pdf.js text content: a run of text, or a marked-content boundary that carries none. */
export type TextContentItem = { str: string; hasEOL: boolean } | { type: string };

/** An original page's text as pdf.js gives it, joined exactly as its text layer draws it: each
 * run in order, a line break after a line's last run. */
export function sourcePageText(items: readonly TextContentItem[]): string {
  let text = '';
  for (const item of items) {
    if (!('str' in item)) continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text;
}

/** One unit per original page, in page order; a page whose text could not be read (null) has none. */
export function sourceUnits(pageTexts: readonly (string | null)[]): FindUnit[] {
  const units: FindUnit[] = [];
  pageTexts.forEach((text, index) => {
    if (text !== null) units.push({ pane: 'source', page: index + 1, blockId: null, text });
  });
  return units;
}

/** A translated paragraph's words as the Korean page draws them, a formula as one stand-in. */
export function translatedParagraphText(text: string, promptVersion: string, block: Block): string {
  return translationTextParts(text, promptVersion, block).map((part) => (part.math ? FORMULA_GAP : part.text)).join('');
}

/**
 * The translated paragraphs the Korean pane draws, in the order it draws them. A page the Korean
 * pane shows as the original page image (not every paragraph translated yet, or one failed) has
 * none: its words are found in the original pane only. `modelId` is the job's model, as for the
 * Korean page itself.
 */
export function translationUnits(blocks: readonly Block[], translations: readonly Translation[], pageCount: number, modelId: string | null): FindUnit[] {
  const units: FindUnit[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const layout = buildKoreanLayout(blocks, translations, page, modelId);
    if (layout.sourceOnly) continue;
    for (const segment of groupKoreanSegments(layout.items, layout.columnCount)) {
      const drawn = segment.type === 'full' ? [segment.item] : [...segment.left, ...segment.right];
      for (const item of drawn) {
        if (item.kind !== 'text' || item.text === null) continue;
        units.push({ pane: 'translation', page, blockId: item.block.blockId, text: translatedParagraphText(item.text, item.promptVersion ?? '', item.block) });
      }
    }
  }
  return units;
}

/** Every match of `query` in `units`, by page, the original before the Korean, in reading order. */
export function findHits(units: readonly FindUnit[], query: string): FindHit[] {
  const pattern = findPattern(query);
  if (pattern === null) return [];
  const ordered = [...units].sort((a, b) => a.page - b.page || PANE_ORDER[a.pane] - PANE_ORDER[b.pane]);
  const hits: FindHit[] = [];
  for (const unit of ordered) {
    let occurrence = 0;
    for (const match of unit.text.matchAll(pattern)) {
      if (match[0].length === 0) continue;
      hits.push({ pane: unit.pane, page: unit.page, blockId: unit.blockId, occurrence, start: match.index, end: match.index + match[0].length });
      occurrence += 1;
    }
  }
  return hits;
}

export function countByPane(hits: readonly FindHit[]): Record<Pane, number> {
  const counts: Record<Pane, number> = { source: 0, translation: 0 };
  for (const hit of hits) counts[hit.pane] += 1;
  return counts;
}

/** The result after `index` (or before it), wrapping around; -1 when there are none. */
export function stepHit(index: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return direction > 0 ? 0 : count - 1;
  return (index + direction + count) % count;
}

/** The first result on `page` or after it, else the first of all; -1 when there are none. */
export function firstHitFrom(hits: readonly FindHit[], page: number): number {
  if (hits.length === 0) return -1;
  const index = hits.findIndex((hit) => hit.page >= page);
  return index < 0 ? 0 : index;
}

/** Where a result is: its pane, page, paragraph and which match there. */
export function hitKey(hit: Pick<FindHit, 'pane' | 'page' | 'blockId' | 'occurrence'>): string {
  return `${hit.pane}:${hit.page}:${hit.blockId ?? ''}:${hit.occurrence}`;
}

// ------------------------------------------------------------------- drawn text

/** As much of a DOM node as the text walk reads. */
export interface DrawnNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<DrawnNode>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * The text a drawn page holds under `root`, built the way the searched text is: text in document
 * order, a line break for each <br>, one stand-in for each formula. `runs` place every text node
 * in it, for turning a match back into a DOM range.
 */
export function drawnText<N extends DrawnNode>(root: N, isFormula: (node: N) => boolean): { text: string; runs: { node: N; start: number }[] } {
  let text = '';
  const runs: { node: N; start: number }[] = [];
  const visit = (node: N) => {
    for (const child of Array.from(node.childNodes) as N[]) {
      if (child.nodeType === TEXT_NODE) {
        runs.push({ node: child, start: text.length });
        text += child.nodeValue ?? '';
      } else if (child.nodeType === ELEMENT_NODE) {
        if (child.nodeName === 'BR') text += '\n';
        else if (isFormula(child)) text += FORMULA_GAP;
        else visit(child);
      }
    }
  };
  visit(root);
  return { text, runs };
}

// ------------------------------------------------------------------------- keys

/** As much of a keyboard event as the find shortcuts read. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
}

/** Ctrl+F (⌘F): F by the letter it types, or by its place when the layout types no Latin letter
 * there (a Korean layout gives ㄹ). Another layout's letter in that place is its own shortcut. */
function isCtrlF(event: KeyLike): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === 'f' || (event.code === 'KeyF' && !/^[a-z]$/i.test(event.key));
}

/** A key that belongs to an input method still composing a syllable. */
function composing(event: KeyLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * Whether the focused element keeps the keyboard to itself: a form field (a box being typed in, a
 * slider that takes PageUp and PageDown), editable text, or anything in an editor open over the
 * page — a memo being edited, or another dialog. The app's shortcuts stay out.
 */
export function keepsKeysToItself(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown };
  if (element.isContentEditable === true) return true;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true;
  return typeof element.closest === 'function' && element.closest('[role="dialog"], [role="alertdialog"]') != null;
}

/** Whether a key press anywhere in the reader opens the find bar. */
export function shouldOpenFind(event: KeyLike, target: unknown): boolean {
  return !event.defaultPrevented && !composing(event) && isCtrlF(event) && !keepsKeysToItself(target);
}

/** Whether an Esc pressed outside the find bar — on the page, in a pane, on a toolbar button —
 * closes it: not one a box, a memo or another dialog keeps, nor one a panel has already used. */
export function shouldCloseFind(event: KeyLike, target: unknown): boolean {
  if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey) return false;
  return !event.defaultPrevented && !composing(event) && !keepsKeysToItself(target);
}

export type FindBarAction = 'next' | 'previous' | 'close' | 'select';

/** The find bar's own keys: Enter for the next result, Shift+Enter for the one before, Esc to
 * close, Ctrl+F to select the query again. None while a syllable is being composed. */
export function findBarKey(event: KeyLike): FindBarAction | null {
  if (composing(event)) return null;
  if (isCtrlF(event)) return 'select';
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Enter') return event.shiftKey ? 'previous' : 'next';
  if (event.key === 'Escape') return 'close';
  return null;
}

// ----------------------------------------------------------------------- status

/** What the find bar knows about its results. */
export interface FindSummary {
  /** The original's text is still being read: nothing is counted yet. */
  loading: boolean;
  hits: number;
  /** The current result's place among all of them, from 0; -1 when none is current. */
  index: number;
  counts: Record<Pane, number>;
  current: { pane: Pane; page: number } | null;
  /** Original pages whose text could not be read, so their results are missing from the count. */
  unreadPages: number[];
}

export interface FindDescription {
  /** "3/15": which result of how many; empty before anything is typed. */
  position: string;
  /** How many results each pane holds, e.g. "원문 12"; null while nothing is counted. A "+"
   * marks a count that misses original pages whose text could not be read. */
  labels: Record<Pane, string> | null;
  panes: string;
  /** What a screen reader is told. */
  announcement: string;
}

/** The find bar's count, its per-pane line, and what a screen reader is told. */
export function describeFind(query: string, summary: FindSummary): FindDescription {
  if (findPattern(query) === null) return { position: '', labels: null, panes: '', announcement: '' };
  if (summary.loading) return { position: '…', labels: null, panes: '', announcement: '찾는 중입니다.' };
  const { counts, unreadPages } = summary;
  const unread = unreadPages.length > 0 ? ` 원문 ${unreadPages.join(', ')}쪽의 글자를 읽지 못해 그 쪽의 원문 결과는 세지 못했습니다.` : '';
  const labels = { source: `${PANE_NAMES.source} ${counts.source}${unreadPages.length > 0 ? '+' : ''}`, translation: `${PANE_NAMES.translation} ${counts.translation}` };
  const panes = `${labels.source} · ${labels.translation}`;
  if (summary.hits === 0) return { position: '0/0', labels, panes, announcement: `결과가 없습니다.${unread}` };
  const position = `${summary.index >= 0 ? summary.index + 1 : 0}/${summary.hits}`;
  const where = summary.index >= 0 && summary.current !== null ? `${summary.index + 1}번째, ${PANE_NAMES[summary.current.pane]} ${summary.current.page}쪽` : '현재 결과 없음';
  return { position, labels, panes, announcement: `결과 ${summary.hits}개 중 ${where}. ${PANE_NAMES.source} ${counts.source}개, ${PANE_NAMES.translation} ${counts.translation}개.${unread}` };
}
