import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Block, Highlight, Region } from '../../shared/contracts';
import type { Size } from '../lib/geometry';
import { hitTestBlock, pageRenderSize, visiblePageWindow } from '../lib/geometry';
import { selectionToRegions, sweepSelection, type Point, type SpanBox } from '../lib/highlights';
import { intrinsicSize, type PDFDocumentProxy } from '../lib/pdf';
import { HighlightLayer } from './HighlightLayer';

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
  /** Forwarded onto the page container; used for drag-driven highlight creation. */
  onMouseDown?(event: React.MouseEvent<HTMLDivElement>): void;
  onMouseUp?(event: React.MouseEvent<HTMLDivElement>): void;
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
export function PageCanvas({ doc, page, zoom, dpr, ariaLabel, size, onSize, registerPage, children, onMouseDown, onMouseUp }: PageCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderedSize, setRenderedSize] = useState<Size | null>(null);
  const box = size ?? renderedSize;

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;

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
      try {
        await render.promise;
      } catch {
        /* superseded by a newer zoom or unmounted */
      }
    })();

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
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    >
      <canvas ref={canvasRef} aria-label={ariaLabel ?? `${page}쪽 원문`} />
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

  useEffect(() => {
    let cancelled = false;
    let layer: { cancel(): void } | null = null;

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
      try {
        await instance.render();
      } catch {
        /* superseded by a newer zoom or unmounted */
      }
    })();

    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [doc, page, zoom]);

  return <div className="textLayer" ref={containerRef} data-testid={`text-layer-${page}`} />;
}

interface PageViewProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: number;
  dpr: number;
  size: Size;
  blocks: Block[];
  highlights: Highlight[];
  onSize(page: number, size: Size): void;
  registerPage(page: number, element: HTMLDivElement | null): void;
  onSelectBlock(block: Block): void;
  onCreateHighlight(page: number, rects: Region[], text: string): void;
  onOpenHighlight(highlight: Highlight): void;
}

/**
 * One rendered PDF page: the canvas background, a selectable text layer, the
 * page's saved highlights, and click-to-navigate hit-testing.
 *
 * Navigation no longer uses an overlaid click-target button (spec: it would
 * intercept the mousedown a text selection needs to start). Instead a plain
 * click — one that did not drag — is hit-tested against the page's readable
 * blocks directly, and a drag becomes a highlight of the lines it swept.
 */
function PageView({ doc, page, zoom, dpr, size, blocks, highlights, onSize, registerPage, onSelectBlock, onCreateHighlight, onOpenHighlight }: PageViewProps): JSX.Element {
  const pageHighlights = useMemo(() => highlights.filter((h) => h.page === page), [highlights, page]);
  // Where the drag began, in viewport pixels; null while no button is down on this page.
  const dragStart = useRef<Point | null>(null);

  // A drag released outside this page (over another page, the gutter, the other pane)
  // never reaches this page's mouseup; the start point must not survive to pair with an
  // unrelated later release here.
  useEffect(() => {
    const clear = () => {
      dragStart.current = null;
    };
    window.addEventListener('mouseup', clear);
    return () => window.removeEventListener('mouseup', clear);
  }, []);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStart.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const container = event.currentTarget;
      const pageBox = container.getBoundingClientRect();
      const start = dragStart.current;
      dragStart.current = null;
      if (start === null) return; // the button went down on another page: not this page's gesture
      const end: Point = { x: event.clientX, y: event.clientY };
      const dragged = Math.hypot(end.x - start.x, end.y - start.y) > 3;
      // A plain click on a saved highlight opens its note (the box's own click handler);
      // it must not also hit-test the page beneath and jump the other pane. A drag that
      // happens to end over a box is still a drag.
      if (!dragged && (event.target as HTMLElement).closest('.highlight-box') !== null) return;

      if (dragged) {
        // The highlight follows the swept lines, not the browser's DOM-order selection;
        // the native selection is only cleared so it does not linger under the new box.
        const spans: SpanBox[] = Array.from(container.querySelectorAll<HTMLElement>('.textLayer span')).map((span) => {
          const rect = span.getBoundingClientRect();
          return { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, text: span.textContent ?? '' };
        });
        const swept = sweepSelection(spans, start, end);
        window.getSelection()?.removeAllRanges();
        if (swept === null) return;
        // pdf.js emits C0 codes for glyphs it cannot map to Unicode (math symbols); the
        // stored excerpt is one line of prose, never raw control characters.
        const text = swept.text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        const regions = selectionToRegions(swept.rects, { left: pageBox.left, top: pageBox.top, width: pageBox.width, height: pageBox.height }, page);
        if (regions !== null && text.length > 0) onCreateHighlight(page, regions, text);
        return;
      }

      // A plain click: hit-test for navigation.
      const xRatio = (event.clientX - pageBox.left) / pageBox.width;
      const yRatio = (event.clientY - pageBox.top) / pageBox.height;
      const block = hitTestBlock(blocks, page, xRatio, yRatio);
      if (block !== null) onSelectBlock(block);
    },
    [blocks, page, onCreateHighlight, onSelectBlock],
  );

  return (
    <PageCanvas doc={doc} page={page} zoom={zoom} dpr={dpr} size={size} onSize={onSize} registerPage={registerPage} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
      <TextLayerOverlay doc={doc} page={page} zoom={zoom} />
      <HighlightLayer highlights={pageHighlights} onOpen={onOpenHighlight} />
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
  onSelectBlock(block: Block): void;
  onCreateHighlight(page: number, rects: Region[], text: string): void;
  onOpenHighlight(highlight: Highlight): void;
}

/**
 * The left pane: the original PDF.
 *
 * Pages outside the window are kept as sized placeholders so the scrollbar and
 * every page offset stay correct without rendering the whole document.
 */
export function PdfPages(props: PdfPaneProps): JSX.Element {
  const { doc, pageCount, currentPage, zoom, blocks, highlights, pageIntrinsicSize, onSize, registerPage, bodyRef, onScroll, onSelectBlock, onCreateHighlight, onOpenHighlight } = props;
  const dpr = useMemo(() => Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1), []);
  const live = useMemo(() => new Set(visiblePageWindow(currentPage, pageCount, 1)), [currentPage, pageCount]);

  if (doc === null) {
    return (
      <div className="pane-body" ref={bodyRef} onScroll={onScroll}>
        <p className="empty">원본 PDF를 아직 불러오지 않았습니다.</p>
      </div>
    );
  }

  return (
    <div className="pane-body" ref={bodyRef} onScroll={onScroll} data-testid="pdf-body">
      {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) =>
        live.has(page) ? (
          <PageView
            key={page}
            doc={doc}
            page={page}
            zoom={zoom}
            dpr={dpr}
            size={pageRenderSize(pageIntrinsicSize(page), zoom)}
            blocks={blocks}
            highlights={highlights}
            onSize={onSize}
            registerPage={registerPage}
            onSelectBlock={onSelectBlock}
            onCreateHighlight={onCreateHighlight}
            onOpenHighlight={onOpenHighlight}
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
  );
}

export default PdfPages;
