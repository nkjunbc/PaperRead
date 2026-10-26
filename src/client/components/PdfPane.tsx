import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { AnnotationInput, AnnotationMode, Block, Highlight } from '../../shared/contracts';
import type { Size } from '../lib/geometry';
import { hitTestBlock, pageRenderSize, visiblePageWindow } from '../lib/geometry';
import { sweepPages, type PagePoint, type Point, type SpanBox } from '../lib/highlights';
import { PEN_WIDTH, annotationSurface, copyPaintedSelection, highlighterInputs, measuredPdfSpans, sourceSelection, type SourceSelection } from '../lib/annotations';
import type { CardAnchor } from '../lib/annotation-session';
import { intrinsicSize, type PDFDocumentProxy } from '../lib/pdf';
import { HighlightLayer } from './HighlightLayer';
import { SelectionMenu } from './AnnotationTools';
import { InkSurface } from './InkSurface';
import { EraserSurface } from './EraserSurface';
import type { EraserSize } from '../lib/eraser';

export interface PageCanvasProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: number;
  /** Device pixel ratio, capped so a 4x zoom on a HiDPI screen stays affordable. */
  dpr: number;
  /** Defaults to the original-page label; a translated pane overrides it. */
  ariaLabel?: string;
  /** The page's size at this zoom when already known, held from the first render so the box
   * never shrinks to an empty canvas while the page loads. */
  size?: Size;
  onSize(page: number, size: Size): void;
  registerPage(page: number, element: HTMLDivElement | null): void;
  /** Whatever the caller wants absolutely-positioned over the rendered page. */
  children?: ReactNode;
}

/**
 * The page background alone: draws the original page into a canvas, tracks its
 * intrinsic size, and scales it for the current zoom and device pixel ratio.
 *
 * This is the one place zoom math happens for a page. Any overlay passed as
 * `children` shares the same sized box instead of recomputing zoom on its own.
 *
 * Only pages inside the visible window are mounted, so a 40-page paper never
 * rasterises 40 canvases at once.
 */
export function PageCanvas({ doc, page, zoom, dpr, ariaLabel, size, onSize, registerPage, children }: PageCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderedSize, setRenderedSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const box = size ?? renderedSize;

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    setFailed(false);

    void (async () => {
      const proxy = await doc.getPage(page);
      if (cancelled) return;
      const intrinsic = intrinsicSize(proxy);
      const rendered = pageRenderSize(intrinsic, zoom);
      setRenderedSize(rendered);
      onSize(page, intrinsic);

      const canvas = canvasRef.current;
      if (canvas === null) return;
      const context = canvas.getContext('2d');
      if (context === null) return;

      canvas.width = Math.floor(rendered.width * dpr);
      canvas.height = Math.floor(rendered.height * dpr);
      canvas.style.width = `${rendered.width}px`;
      canvas.style.height = `${rendered.height}px`;

      const render = proxy.render({ canvas, canvasContext: context, viewport: proxy.getViewport({ scale: zoom * dpr }) });
      task = render;
      await render.promise;
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, dpr, onSize]);

  return (
    <div
      className="pdf-page"
      data-page={page}
      ref={(element) => registerPage(page, element)}
      style={box === null ? undefined : { width: box.width, height: box.height }}
    >
      <canvas ref={canvasRef} aria-label={ariaLabel ?? `${page}쪽 원문`} />
      {failed ? <p role="alert">{page}쪽 원문을 불러오지 못했습니다.</p> : null}
      {children}
    </div>
  );
}

interface TextLayerOverlayProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: number;
}

/**
 * A transparent, selectable text layer over the rendered page canvas.
 *
 * pdf.js positions and sizes each span itself once `--total-scale-factor` is
 * set to the same zoom the canvas rendered at, so this stays a thin wrapper:
 * mount a container, hand it to `TextLayer`, and let the browser's own
 * selection machinery do the rest.
 */
function TextLayerOverlay({ doc, page, zoom }: TextLayerOverlayProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let layer: { cancel(): void } | null = null;
    setFailed(false);

    void (async () => {
      const proxy = await doc.getPage(page);
      if (cancelled) return;
      const container = containerRef.current;
      if (container === null) return;
      container.replaceChildren();
      container.style.setProperty('--total-scale-factor', String(zoom));
      container.style.setProperty('--scale-round-x', '1px');
      container.style.setProperty('--scale-round-y', '1px');
      container.style.setProperty('--min-font-size', '1');
      const viewport = proxy.getViewport({ scale: zoom });
      const instance = new TextLayer({ textContentSource: proxy.streamTextContent(), container, viewport });
      layer = instance;
      await instance.render();
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [doc, page, zoom]);

  return <>
    <div className="textLayer" ref={containerRef} data-testid={`text-layer-${page}`} />
    {failed ? <p role="alert">{page}쪽 텍스트를 불러오지 못했습니다.</p> : null}
  </>;
}

interface PageViewProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: number;
  dpr: number;
  size: Size;
  highlights: Highlight[];
  /** Records not saved yet and the selection being made, on any page. */
  drafts: AnnotationInput[];
  preview: AnnotationInput[];
  onSize(page: number, size: Size): void;
  registerPage(page: number, element: HTMLDivElement | null): void;
  onOpenHighlight(highlight: Highlight): void;
  annotationMode: AnnotationMode;
  penColor: Highlight['color'];
  penWidth: number;
  annotationEraserSize?: EraserSize;
  onCreateAnnotations?(inputs: AnnotationInput[]): void;
  onEraseAnnotation?(highlightId: string): void;
}

const onPage = (inputs: AnnotationInput[], page: number) => inputs.filter((input) => input.page === page && (input.surface ?? 'original') === 'original');

/**
 * One rendered PDF page: the canvas background, a selectable text layer, and the page's
 * highlights, memo marks and pen strokes, with the pen or the eraser when one is on. Selecting
 * and highlighting belong to the whole pane (PdfPages): a drag may run on to the next page.
 */
function PageView({ doc, page, zoom, dpr, size, highlights, drafts, preview, onSize, registerPage, onOpenHighlight, annotationMode, penColor, penWidth, annotationEraserSize, onCreateAnnotations, onEraseAnnotation }: PageViewProps): JSX.Element {
  const pageHighlights = useMemo(() => highlights.filter((h) => h.page === page && annotationSurface(h) === 'original'), [highlights, page]);
  return (
    <PageCanvas doc={doc} page={page} zoom={zoom} dpr={dpr} size={size} onSize={onSize} registerPage={registerPage}>
      <TextLayerOverlay doc={doc} page={page} zoom={zoom} />
      <HighlightLayer highlights={pageHighlights} drafts={onPage(drafts, page)} preview={onPage(preview, page)} pageWidth={size.width} onOpen={onOpenHighlight} />
      {annotationMode === 'pen' && onCreateAnnotations ? <InkSurface page={page} surface="original" color={penColor} width={penWidth} pageWidth={size.width} onCreate={(input) => onCreateAnnotations([input])} /> : null}
      {annotationMode === 'erase' && onEraseAnnotation ? <EraserSurface page={page} highlights={pageHighlights} onErase={onEraseAnnotation} size={annotationEraserSize} /> : null}
    </PageCanvas>
  );
}

export interface PdfPaneProps {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  zoom: number;
  blocks: Block[];
  highlights: Highlight[];
  /** Native PDF dimensions, known for every page up front: a page is the same size drawn or
   * not, so moving the drawn window never moves what the reader is looking at. */
  pageIntrinsicSize(page: number): Size;
  onSize(page: number, size: Size): void;
  registerPage(page: number, element: HTMLDivElement | null): void;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onScroll(): void;
  onSelectPage(page: number): void;
  onOpenHighlight(highlight: Highlight): void;
  annotationMode?: AnnotationMode;
  highlighterColor?: Highlight['color'];
  /** The share of each marked line's height the highlighter paints. */
  highlighterThickness?: number;
  penColor?: Highlight['color'];
  /** The pen's thickness as a share of the page width. */
  penWidth?: number;
  annotationEraserSize?: EraserSize;
  /** Records not saved yet: sweeps waiting for the service, a new memo's selection. */
  drafts?: AnnotationInput[];
  /** Save these records at once, one per page. */
  onCreateAnnotations?(inputs: AnnotationInput[]): void;
  /** Open a memo card on a selection; `anchor` is the selection's right end. */
  onStartMemo?(inputs: AnnotationInput[], anchor: CardAnchor): void;
  onAsk?(text: string): void;
  onEraseAnnotation?(highlightId: string): void;
}

/** A press on the original pages, followed until it is let go. */
interface Gesture {
  pointerId: number;
  /** The press, in viewport pixels and on its page. */
  from: Point;
  start: PagePoint;
  /** The pointer now, in viewport pixels. */
  at: Point;
  moved: boolean;
  /** What the drag selects so far, kept while the pointer strays off the text. */
  swept: SourceSelection;
  dispose(): void;
}

/** The drawn page under a viewport point, or the nearest drawn page above or below it. */
function pageAt(body: HTMLElement, x: number, y: number): PagePoint | null {
  let best: PagePoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of body.querySelectorAll<HTMLElement>(':scope > .pdf-page[data-page]:not(.pdf-placeholder)')) {
    const box = element.getBoundingClientRect();
    const distance = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { page: Number(element.dataset.page), point: { x: x - box.left, y: y - box.top } };
    }
  }
  return best;
}

/** The right end of a selection's last line, in viewport pixels: where Edge opens a new memo. */
function rightEnd(body: HTMLElement, inputs: AnnotationInput[], fallback: CardAnchor): CardAnchor {
  const last = inputs.at(-1);
  const rect = last?.rects.at(-1);
  const element = last === undefined ? null : body.querySelector<HTMLElement>(`:scope > .pdf-page[data-page="${last.page}"]`);
  if (rect === undefined || element === null) return fallback;
  const box = element.getBoundingClientRect();
  return { left: box.left + (rect.x + rect.width) * box.width, top: box.top + rect.y * box.height };
}

/**
 * The left pane: the original PDF.
 *
 * Pages outside the window are kept as sized placeholders so the scrollbar and
 * every page offset stay correct without rendering the whole document.
 *
 * Selecting and highlighting follow the printed lines, not the browser's selection: pdf.js
 * lays its runs out in content-stream order, so a native selection between two nearby lines
 * can take in half a page of another column. A drag is swept line by line in reading order,
 * page by page when it crosses pages (lib/highlights). With the select tool, letting go offers
 * the selection menu, and while it shows a copy (Ctrl+C) takes the swept text; with the
 * highlighter, the swept lines are saved at once. A press that does
 * not move opens the highlight under it, or — with the select tool — jumps the other pane to
 * the paragraph, after a moment in which a double-click (a word selection) can still cancel it.
 */
export function PdfPages(props: PdfPaneProps): JSX.Element {
  const { doc, pageCount, currentPage, zoom, highlights, pageIntrinsicSize, onSize, registerPage, bodyRef, onScroll, onOpenHighlight } = props;
  const mode = props.annotationMode ?? 'select';
  const dpr = useMemo(() => Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1), []);
  const live = useMemo(() => new Set(visiblePageWindow(currentPage, pageCount, 1)), [currentPage, pageCount]);
  const [preview, setPreview] = useState<AnnotationInput[]>([]);
  const [menu, setMenu] = useState<(SourceSelection & { position: CardAnchor; end: CardAnchor }) | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const navigateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A drag's window listeners outlive the render that started it; they read the props here.
  const latest = useRef(props);
  latest.current = props;

  const closeMenu = useCallback(() => {
    setMenu(null);
    setPreview([]);
  }, []);
  useEffect(() => {
    gesture.current?.dispose();
    closeMenu();
  }, [zoom, mode, closeMenu]);
  useEffect(() => () => {
    gesture.current?.dispose();
    if (navigateTimer.current !== null) clearTimeout(navigateTimer.current);
  }, []);
  // The painted selection is the page's own: a copy while it shows takes its text.
  useEffect(() => {
    if (menu === null) return;
    const copy = (event: ClipboardEvent) => copyPaintedSelection(event, menu.text, window.getSelection());
    document.addEventListener('copy', copy);
    return () => document.removeEventListener('copy', copy);
  }, [menu]);

  const offer = (swept: SourceSelection, body: HTMLElement, released: Point) => {
    const position = { left: released.x, top: released.y };
    setPreview(swept.inputs);
    setMenu({ ...swept, position, end: rightEnd(body, swept.inputs, position) });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch' || (mode !== 'select' && mode !== 'highlight')) return;
    const body = event.currentTarget;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null || target.closest('.memo-icon, .saved-ink') !== null) return;
    const pressed = target.closest<HTMLElement>('.pdf-page[data-page]');
    if (pressed === null || pressed.classList.contains('pdf-placeholder')) return;
    if (navigateTimer.current !== null) {
      clearTimeout(navigateTimer.current);
      navigateTimer.current = null;
    }
    gesture.current?.dispose();
    setMenu(null);
    setPreview([]);

    const highlighting = mode === 'highlight';
    const box = pressed.getBoundingClientRect();
    const spans = new Map<number, SpanBox[]>();
    const sizes = new Map<number, Size>();
    // A page's runs are measured once per drag, when the drag first reaches it; a page whose
    // text layer is not drawn yet is measured again on the next move.
    const spansOf = (page: number): SpanBox[] | undefined => {
      const known = spans.get(page);
      if (known !== undefined) return known;
      const element = body.querySelector<HTMLElement>(`:scope > .pdf-page[data-page="${page}"]:not(.pdf-placeholder)`);
      if (element === null) return undefined;
      const measured = measuredPdfSpans(element, true);
      if (measured.length === 0) return undefined;
      const drawn = element.getBoundingClientRect();
      sizes.set(page, { width: drawn.width, height: drawn.height });
      spans.set(page, measured);
      return measured;
    };
    const sweep = (from: PagePoint, to: PagePoint) => sourceSelection(sweepPages(spansOf, from, to), (page) => sizes.get(page));
    const state: Gesture = {
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      start: { page: Number(pressed.dataset.page), point: { x: event.clientX - box.left, y: event.clientY - box.top } },
      at: { x: event.clientX, y: event.clientY },
      moved: false,
      swept: { inputs: [], text: '' },
      dispose: () => undefined,
    };
    // The highlighter's colour and thickness as they are now, the same on every page of the sweep.
    const painted = (inputs: AnnotationInput[]) => highlighterInputs(inputs, latest.current.highlighterColor ?? 'yellow', latest.current.highlighterThickness);
    const update = () => {
      const end = pageAt(body, state.at.x, state.at.y);
      if (end === null) return;
      const swept = sweep(state.start, end);
      if (swept.inputs.length === 0) return;
      state.swept = swept;
      setPreview(highlighting ? painted(swept.inputs) : swept.inputs);
    };
    // A double-click selects a word natively; it is taken over as a sweep across that word.
    const takeWord = (released: Point): boolean => {
      const native = window.getSelection();
      if (native === null || native.isCollapsed || native.rangeCount === 0) return false;
      const range = native.getRangeAt(0);
      const pageOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.pdf-page[data-page]') ?? null;
      const element = pageOf(range.startContainer);
      if (element === null || element !== pageOf(range.endContainer) || !body.contains(element)) return false;
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      native.removeAllRanges();
      if (rects.length === 0) return true;
      const page = Number(element.dataset.page);
      const drawn = element.getBoundingClientRect();
      const first = rects[0];
      const last = rects[rects.length - 1];
      const swept = sweep(
        { page, point: { x: first.left - drawn.left + 0.5, y: first.top + first.height / 2 - drawn.top } },
        { page, point: { x: last.right - drawn.left - 0.5, y: last.top + last.height / 2 - drawn.top } },
      );
      if (swept.inputs.length > 0) offer(swept, body, released);
      return true;
    };
    const click = (released: Point) => {
      const current = latest.current;
      const select = (current.annotationMode ?? 'select') === 'select';
      if (select && takeWord(released)) return;
      const drawn = pressed.getBoundingClientRect();
      const page = Number(pressed.dataset.page);
      const x = (released.x - drawn.left) / drawn.width;
      const y = (released.y - drawn.top) / drawn.height;
      // The boxes let the pointer through to the text; a click is matched to them here.
      const hit = current.highlights
        .filter((h) => h.page === page && annotationSurface(h) === 'original' && h.kind !== 'ink')
        .reverse()
        .find((h) => h.rects.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height));
      if (hit !== undefined) {
        current.onOpenHighlight(hit);
        return;
      }
      if (!select) return;
      const block = hitTestBlock(current.blocks, page, x, y);
      if (block !== null) navigateTimer.current = setTimeout(() => {
        navigateTimer.current = null;
        latest.current.onSelectPage(page);
      }, 300);
    };
    const move = (moving: PointerEvent) => {
      if (moving.pointerId !== state.pointerId) return;
      state.at = { x: moving.clientX, y: moving.clientY };
      if (!state.moved) {
        if (Math.hypot(state.at.x - state.from.x, state.at.y - state.from.y) <= 3) return;
        state.moved = true;
        body.dataset.sweeping = '';
      }
      // The browser's own selection would follow the content-stream order: it never shows.
      const native = window.getSelection();
      if (native !== null && !native.isCollapsed) native.removeAllRanges();
      update();
    };
    const scrolled = () => { if (state.moved) update(); };
    const up = (released: PointerEvent) => {
      if (released.pointerId !== state.pointerId) return;
      state.at = { x: released.clientX, y: released.clientY };
      state.dispose();
      if (!state.moved) {
        click(state.at);
        return;
      }
      update();
      window.getSelection()?.removeAllRanges();
      if (state.swept.inputs.length === 0) {
        setPreview([]);
        return;
      }
      if (highlighting) {
        setPreview([]);
        latest.current.onCreateAnnotations?.(painted(state.swept.inputs));
        return;
      }
      offer(state.swept, body, state.at);
    };
    const cancel = (cancelled: PointerEvent) => {
      if (cancelled.pointerId !== state.pointerId) return;
      state.dispose();
      setPreview([]);
    };
    state.dispose = () => {
      delete body.dataset.sweeping;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      body.removeEventListener('scroll', scrolled);
      if (gesture.current === state) gesture.current = null;
    };
    // The highlighter never makes a native selection; the select tool's double-click does.
    if (highlighting) body.dataset.sweeping = '';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    body.addEventListener('scroll', scrolled);
    gesture.current = state;
  };

  if (doc === null) {
    return (
      <div className="pane-body" ref={bodyRef} onScroll={onScroll}>
        <p className="empty">원본 PDF를 아직 불러오지 않았습니다.</p>
      </div>
    );
  }

  return (
    <>
      <div className="pane-body" ref={bodyRef} onScroll={onScroll} onPointerDown={handlePointerDown} data-testid="pdf-body">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) =>
          live.has(page) ? (
            <PageView
              key={page}
              doc={doc}
              page={page}
              zoom={zoom}
              dpr={dpr}
              size={pageRenderSize(pageIntrinsicSize(page), zoom)}
              highlights={highlights}
              drafts={props.drafts ?? []}
              preview={preview}
              onSize={onSize}
              registerPage={registerPage}
              onOpenHighlight={onOpenHighlight}
              annotationMode={mode}
              penColor={props.penColor ?? 'blue'}
              penWidth={props.penWidth ?? PEN_WIDTH.initial}
              annotationEraserSize={props.annotationEraserSize}
              onCreateAnnotations={props.onCreateAnnotations}
              onEraseAnnotation={props.onEraseAnnotation}
            />
          ) : (
            <div
              key={page}
              className="pdf-page pdf-placeholder"
              data-page={page}
              ref={(element) => registerPage(page, element)}
              style={pageRenderSize(pageIntrinsicSize(page), zoom)}
            >
              {page}쪽
            </div>
          ),
        )}
      </div>
      {menu !== null ? (
        <SelectionMenu
          text={menu.text}
          position={menu.position}
          onHighlight={(color) => { props.onCreateAnnotations?.(highlighterInputs(menu.inputs, color)); closeMenu(); }}
          onMemo={() => { props.onStartMemo?.(menu.inputs, menu.end); closeMenu(); }}
          onAsk={props.onAsk === undefined ? undefined : () => { props.onAsk?.(menu.text); closeMenu(); }}
          onClose={closeMenu}
        />
      ) : null}
    </>
  );
}

export default PdfPages;
