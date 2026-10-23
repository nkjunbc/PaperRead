import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type Ref, type RefObject } from 'react';
import type { Block, Translation } from '../../shared/contracts';
import {
  countByPane,
  describeFind,
  drawnText,
  findBarKey,
  findHits,
  findPattern,
  firstHitFrom,
  hitKey,
  shouldCloseFind,
  shouldOpenFind,
  sourcePageText,
  sourceUnits,
  stepHit,
  translationUnits,
  type DrawnNode,
  type FindSummary,
} from '../lib/find';
import type { PDFDocumentProxy } from '../lib/pdf';
import type { Pane } from '../lib/sync';

/** The browser's own marks over the text (CSS Custom Highlight API): no page is rewritten. */
const MARKS = 'paperread-find';
const CURRENT_MARK = 'paperread-find-current';
/** Room kept clear at the top of a pane, where this bar floats, and at its foot. */
const CLEAR_TOP = 72;
const CLEAR_BOTTOM = 24;
/** The bar's distance from the pane heads above it and from the scroll bar beside it. */
const GAP = 8;
const SCOPE_NOTE = '한국어 쪽은 번역이 끝난 문단만 찾습니다. 한국어 쪽에 원문 지면이 대신 보이는 쪽은 원문에서만 찾습니다.';

type SourceTexts = (string | null)[];
const sourceTextCache = new WeakMap<PDFDocumentProxy, Promise<SourceTexts>>();

/** Every original page's text, read once per document, so the counts cover pages never drawn.
 * A page whose text cannot be read is null. */
function readSourceTexts(doc: PDFDocumentProxy): Promise<SourceTexts> {
  let texts = sourceTextCache.get(doc);
  if (texts === undefined) {
    texts = Promise.all(
      Array.from({ length: doc.numPages }, async (_, index) => {
        try {
          const page = await doc.getPage(index + 1);
          return sourcePageText((await page.getTextContent()).items);
        } catch {
          return null;
        }
      }),
    );
    sourceTextCache.set(doc, texts);
  }
  return texts;
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : null;
}

function clearMarks(): void {
  const registry = highlightRegistry();
  registry?.delete(MARKS);
  registry?.delete(CURRENT_MARK);
}

const isFormula = (node: DrawnNode) => node instanceof Element && node.matches('.kr-inline-math, .kr-inline-math-missing');

/** The searched text a drawn page holds: an original page's text layer, or each translated
 * paragraph of a Korean page drawn in Korean. Placeholders and original-image pages hold none. */
function drawnUnits(pane: Pane, body: HTMLElement): { page: number; blockId: string | null; root: HTMLElement }[] {
  const units: { page: number; blockId: string | null; root: HTMLElement }[] = [];
  if (pane === 'source') {
    for (const page of body.querySelectorAll<HTMLElement>(':scope > .pdf-page[data-page]')) {
      const layer = page.querySelector<HTMLElement>(':scope > .textLayer');
      if (layer !== null) units.push({ page: Number(page.dataset.page), blockId: null, root: layer });
    }
    return units;
  }
  for (const page of body.querySelectorAll<HTMLElement>(':scope > .kr-page[data-page]:not(.kr-placeholder):not(.kr-source-only)')) {
    for (const paragraph of page.querySelectorAll<HTMLElement>('.kr-text[data-block-id]')) {
      units.push({ page: Number(page.dataset.page), blockId: paragraph.dataset.blockId ?? null, root: paragraph });
    }
  }
  return units;
}

/** DOM ranges for matches in a drawn text, in order; null where a match cannot be placed. */
function matchRanges(runs: readonly { node: DrawnNode; start: number }[], matches: readonly { start: number; end: number }[]): (Range | null)[] {
  const end = (index: number) => runs[index].start + (runs[index].node.nodeValue?.length ?? 0);
  const ranges: (Range | null)[] = [];
  let first = 0;
  for (const match of matches) {
    // The text node holding the match's first character, then the one holding its last.
    while (first < runs.length && end(first) <= match.start) first += 1;
    let last = first;
    while (last < runs.length && end(last) < match.end) last += 1;
    if (last >= runs.length || runs[first].start > match.start) {
      ranges.push(null);
      continue;
    }
    const range = document.createRange();
    range.setStart(runs[first].node as Node, match.start - runs[first].start);
    range.setEnd(runs[last].node as Node, match.end - runs[last].start);
    ranges.push(range);
  }
  return ranges;
}

/** Where a pane must scroll for a result to be in plain view: where it is, when it already is. */
function revealTop(body: HTMLElement, range: Range): number {
  const rect = range.getBoundingClientRect();
  const box = body.getBoundingClientRect();
  if (rect.left < box.left || rect.right > box.right) {
    body.scrollLeft = Math.max(0, body.scrollLeft + rect.left - box.left - (body.clientWidth - rect.width) / 2);
  }
  if (rect.top >= box.top + CLEAR_TOP && rect.bottom <= box.bottom - CLEAR_BOTTOM) return body.scrollTop;
  return Math.max(0, body.scrollTop + rect.top - box.top - body.clientHeight / 3);
}

function Chevron({ up }: { up: boolean }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={up ? 'M2 11.5l6-7 6 7' : 'M2 4.5l6 7 6-7'} />
    </svg>
  );
}

function Cross(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M2 2l12 12M14 2 2 14" />
    </svg>
  );
}

export interface FindBarViewProps {
  query: string;
  summary: FindSummary;
  inputRef?: Ref<HTMLInputElement>;
  onQueryChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}

/** The bar itself: the query, which result of how many and how many in each pane, and the moves. */
export function FindBarView({ query, summary, inputRef, onQueryChange, onKeyDown, onStep, onClose }: FindBarViewProps): JSX.Element {
  const statusId = useId();
  const described = describeFind(query, summary);
  const currentPane = summary.current?.pane ?? null;
  const scope = summary.unreadPages.length > 0 ? `${SCOPE_NOTE} 원문 ${summary.unreadPages.join(', ')}쪽은 글자를 읽지 못해 세지 못했습니다.` : SCOPE_NOTE;
  return (
    <div className="find-bar" role="search" aria-label="원문과 한국어에서 찾기" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="find-bar__input"
        type="text"
        value={query}
        placeholder="원문·한국어에서 찾기"
        aria-label="찾을 말"
        aria-describedby={statusId}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {described.position !== '' ? (
        <span className="find-bar__count" aria-hidden="true" title={scope}>
          <span className="find-bar__position">{described.position}</span>
          {described.labels !== null ? (
            <span className="find-bar__panes">
              <span className={currentPane === 'source' ? 'is-current' : undefined}>{described.labels.source}</span>
              {' · '}
              <span className={currentPane === 'translation' ? 'is-current' : undefined}>{described.labels.translation}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      <span id={statusId} className="sr-only" role="status">
        {described.announcement}
      </span>
      <span className="find-bar__rule" aria-hidden="true" />
      <button type="button" className="find-bar__button" aria-label="이전 결과" title="이전 결과 (Shift+Enter)" disabled={summary.hits === 0} onClick={() => onStep(-1)}>
        <Chevron up />
      </button>
      <button type="button" className="find-bar__button" aria-label="다음 결과" title="다음 결과 (Enter)" disabled={summary.hits === 0} onClick={() => onStep(1)}>
        <Chevron up={false} />
      </button>
      <button type="button" className="find-bar__button" aria-label="찾기 닫기" title="닫기 (Esc)" onClick={onClose}>
        <Cross />
      </button>
    </div>
  );
}

export interface FindBarProps {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  blocks: Block[];
  translations: Translation[];
  /** The job's model (null without a job): the translation the Korean page shows. */
  modelId: string | null;
  /** The page being read: a new search starts from it. */
  currentPage: number;
  sourceBody: RefObject<HTMLDivElement | null>;
  koreanBody: RefObject<HTMLDivElement | null>;
  /** Show a result's pane and bring it to the result: to its page's top while the result is not
   * drawn yet (`top` null), then to `top` in the pane's own scroll coordinates. */
  onReveal(pane: Pane, page: number, top: number | null): void;
}

/**
 * Find in the paper (Ctrl+F): the original pane's text on every page, and the Korean pane's
 * translated paragraphs on every page it draws in Korean. Counts cover the whole document — the
 * original's text is read from the PDF, not from the few pages drawn — and every result says
 * which pane it is in. Results on drawn pages are marked; moving to one scrolls its pane there.
 * Rendered inside the reader, which it floats over.
 */
export function FindBar({ doc, pageCount, blocks, translations, modelId, currentPage, sourceBody, koreanBody, onReveal }: FindBarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  // The current result, by where it is; `reveal` counts the moves that take the reader to it.
  const [current, setCurrent] = useState<{ key: string; reveal: number } | null>(null);
  const [source, setSource] = useState<{ doc: PDFDocumentProxy; texts: SourceTexts } | null>(null);
  const [place, setPlace] = useState<{ top: number; right: number; maxWidth: number } | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const searched = useRef<string | null>(null);
  const pendingReveal = useRef<{ key: string; requested: boolean } | null>(null);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  useEffect(() => {
    if (!open || doc === null) return;
    let cancelled = false;
    void readSourceTexts(doc).then((texts) => {
      if (!cancelled) setSource({ doc, texts });
    });
    return () => {
      cancelled = true;
    };
  }, [open, doc]);
  const sourceTexts = source !== null && source.doc === doc ? source.texts : null;
  const ready = sourceTexts !== null;

  const units = useMemo(
    () => (open && sourceTexts !== null ? [...sourceUnits(sourceTexts), ...translationUnits(blocks, translations, pageCount, modelId)] : []),
    [open, sourceTexts, blocks, translations, pageCount, modelId],
  );
  const pattern = useMemo(() => findPattern(query), [query]);
  const hits = useMemo(() => findHits(units, query), [units, query]);
  const keys = useMemo(() => hits.map(hitKey), [hits]);
  const counts = useMemo(() => countByPane(hits), [hits]);
  const currentIndex = current === null ? -1 : keys.indexOf(current.key);

  // A new search starts at the first result on the page being read (or after it) and goes there.
  // When only the results changed — a translation arrived — the current one stays, unless it is
  // gone; then the first from the page being read takes its place, without moving the reader.
  useEffect(() => {
    if (!open) return;
    const search = ready && pattern !== null ? pattern.source : null;
    const fresh = searched.current !== search;
    searched.current = search;
    if (search === null || hits.length === 0) {
      setCurrent(null);
      return;
    }
    if (!fresh && current !== null && keys.includes(current.key)) return;
    const key = keys[firstHitFrom(hits, currentPageRef.current)];
    setCurrent((value) => ({ key, reveal: (value?.reveal ?? 0) + (fresh ? 1 : 0) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, pattern, hits, keys]);

  // Each move to a result waits until the result is drawn, then brings the reader to it.
  const reveal = current?.reveal ?? 0;
  useEffect(() => {
    pendingReveal.current = current === null || reveal === 0 ? null : { key: current.key, requested: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const paint = useRef<() => void>(() => {});
  paint.current = () => {
    const registry = highlightRegistry();
    const marks: Range[] = [];
    let currentRange: Range | null = null;
    const currentKey = currentIndex >= 0 ? keys[currentIndex] : null;
    if (open && ready && pattern !== null) {
      for (const [pane, body] of [['source', sourceBody.current], ['translation', koreanBody.current]] as const) {
        if (body === null) continue;
        for (const unit of drawnUnits(pane, body)) {
          const drawn = drawnText<DrawnNode>(unit.root, isFormula);
          const matches = Array.from(drawn.text.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length }));
          matchRanges(drawn.runs, matches).forEach((range, occurrence) => {
            if (range === null) return;
            if (hitKey({ pane, page: unit.page, blockId: unit.blockId, occurrence }) === currentKey) currentRange = range;
            else marks.push(range);
          });
        }
      }
    }
    if (registry !== null) {
      if (marks.length > 0) registry.set(MARKS, new Highlight(...marks));
      else registry.delete(MARKS);
      if (currentRange !== null) {
        const mark = new Highlight(currentRange);
        mark.priority = 1;
        registry.set(CURRENT_MARK, mark);
      } else registry.delete(CURRENT_MARK);
    }

    const pending = pendingReveal.current;
    if (pending === null || pending.key !== currentKey || currentIndex < 0) return;
    const hit = hits[currentIndex];
    const body = hit.pane === 'source' ? sourceBody.current : koreanBody.current;
    if (body === null) return;
    if (currentRange !== null) {
      pendingReveal.current = null;
      onReveal(hit.pane, hit.page, revealTop(body, currentRange));
    } else if (!pending.requested) {
      // Not drawn yet: its page first; the result itself once that page is drawn.
      pending.requested = true;
      onReveal(hit.pane, hit.page, null);
    }
  };

  useEffect(() => {
    if (open) paint.current();
  }, [open, ready, pattern, hits, current]);

  // Pages are drawn, re-drawn at a new zoom, and translated while the bar is open: every change
  // to either pane's pages paints the marks again, at most once a frame. Closing clears them.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const schedule = () => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          paint.current();
        });
      }
    };
    const observer = new MutationObserver(schedule);
    for (const body of [sourceBody.current, koreanBody.current]) {
      if (body !== null) observer.observe(body, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      clearMarks();
    };
  }, [open, sourceBody, koreanBody]);

  // The bar floats at the top right of the reading panes: under every pane head it would cover
  // (a head takes a second row in a narrow pane), clear of the right pane's scroll bar, and no
  // wider than the reader.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const reader = layer?.parentElement ?? null;
    if (!open || layer === null || reader === null) return;
    const measure = () => {
      const box = reader.getBoundingClientRect();
      const korean = koreanBody.current;
      const right = (korean === null ? 0 : Math.max(0, box.right - korean.getBoundingClientRect().right) + korean.offsetWidth - korean.clientWidth) + GAP;
      const left = box.right - right - layer.offsetWidth;
      let top = 0;
      for (const body of [sourceBody.current, korean]) {
        const rect = body?.getBoundingClientRect();
        if (rect !== undefined && rect.left < box.right - right && rect.right > left) top = Math.max(top, rect.top - box.top);
      }
      top += GAP;
      const maxWidth = Math.max(0, box.width - right - GAP);
      setPlace((old) => (old !== null && old.top === top && old.right === right && old.maxWidth === maxWidth ? old : { top, right, maxWidth }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [reader, layer, sourceBody.current, koreanBody.current]) {
      if (node !== null) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [open, sourceBody, koreanBody]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusRequest]);

  const show = useCallback(() => {
    const active = document.activeElement;
    if (!(layerRef.current?.contains(active) ?? false)) opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setOpen(true);
    setFocusRequest((count) => count + 1);
  }, []);

  const close = useCallback(() => {
    const back = opener.current;
    // Focus in the bar goes back to where it came from; focus elsewhere stays where it is.
    const inBar = layerRef.current?.contains(document.activeElement) ?? false;
    opener.current = null;
    searched.current = null;
    pendingReveal.current = null;
    setOpen(false);
    setCurrent(null);
    if (inBar && back !== null && back.isConnected) back.focus({ preventScroll: true });
  }, []);

  // Ctrl+F opens the bar wherever the paper is being read, and Esc closes it from the page, a pane
  // or a toolbar as well as from the bar itself — except while a box is being typed in, a memo or
  // another dialog has the keyboard, or the reader is hidden or covered. The document hears a key
  // after the focused panel's own handlers (React's, on the root inside it), so an Esc a panel has
  // used is left alone, and before App's shortcuts on the window: the Esc that closes the bar stops
  // there, and the question panel, which App closes on an Esc from the page, takes the next one.
  useEffect(() => {
    if (doc === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const opening = shouldOpenFind(event, event.target);
      if (!opening && !(open && shouldCloseFind(event, event.target))) return;
      const layer = layerRef.current;
      if (layer === null || layer.closest('[hidden], [inert]') !== null) return;
      if (document.querySelector('[aria-modal="true"]:not([hidden])') !== null) return;
      event.preventDefault();
      if (opening) {
        show();
        return;
      }
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [doc, open, show, close]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const index = stepHit(currentIndex, keys.length, direction);
      if (index < 0) return;
      setCurrent((value) => ({ key: keys[index], reveal: (value?.reveal ?? 0) + 1 }));
    },
    [currentIndex, keys],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const action = findBarKey({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      });
      if (action === null) return;
      // Enter on one of the bar's buttons is that button's own press.
      if ((action === 'next' || action === 'previous') && event.target !== inputRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'close') close();
      else if (action === 'select') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else step(action === 'next' ? 1 : -1);
    },
    [close, step],
  );

  const summary: FindSummary = {
    loading: !ready,
    hits: hits.length,
    index: currentIndex,
    counts,
    current: currentIndex >= 0 ? { pane: hits[currentIndex].pane, page: hits[currentIndex].page } : null,
    unreadPages: sourceTexts === null ? [] : sourceTexts.flatMap((text, index) => (text === null ? [index + 1] : [])),
  };

  return (
    <div className="find-layer" ref={layerRef} style={place === null ? undefined : { top: place.top, right: place.right, maxWidth: place.maxWidth }}>
      {open ? <FindBarView query={query} summary={summary} inputRef={inputRef} onQueryChange={setQuery} onKeyDown={onKeyDown} onStep={step} onClose={close} /> : null}
    </div>
  );
}
