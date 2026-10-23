import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { AnnotationInput, AnnotationMode, Block, Highlight, Region } from '../../shared/contracts';
import type { Size } from '../lib/geometry';
import { hitTestBlock, pageRenderSize, visiblePageWindow } from '../lib/geometry';
import { selectionToRegions, sweepSelection, type Point, type SpanBox } from '../lib/highlights';
import { annotationSurface, measuredPdfSpans } from '../lib/annotations';
import { intrinsicSize, type PDFDocumentProxy } from '../lib/pdf';
import { HighlightLayer } from './HighlightLayer';
import { SelectionToolbar } from './AnnotationTools';
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
  /** Forwarded onto the page container; used for drag-driven highlight creation. */
  onMouseDown?(event: React.MouseEvent<HTMLDivElement>): void;
  onMouseUp?(event: React.MouseEvent<HTMLDivElement>): void;
  onPointerDown?(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerMove?(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerUp?(event: React.PointerEvent<HTMLDivElement>): void;
  onDoubleClick?(event: React.MouseEvent<HTMLDivElement>): void;
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
export function PageCanvas({ doc, page, zoom, dpr, ariaLabel, size, onSize, registerPage, children, onMouseDown, onMouseUp, onPointerDown, onPointerMove, onPointerUp, onDoubleClick }: PageCanvasProps): JSX.Element {
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
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
  onCreateHighlight?(page: number, rects: Region[], text: string): void;
  onOpenHighlight(highlight: Highlight): void;
  annotationMode?: AnnotationMode;
  annotationColor?: Highlight['color'];
  annotationEraserSize?: EraserSize;
  onCreateAnnotation?(input: AnnotationInput, openNote?: boolean): void;
  onAsk?(text: string): void;
  onEraseAnnotation?(highlightId:string):void;
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
function PageView({ doc, page, zoom, dpr, size, blocks, highlights, onSize, registerPage, onSelectBlock, onCreateHighlight, onOpenHighlight, annotationMode = 'select', annotationColor = 'yellow', annotationEraserSize, onCreateAnnotation, onAsk, onEraseAnnotation }: PageViewProps): JSX.Element {
  const pageHighlights = useMemo(() => highlights.filter((h) => h.page === page && annotationSurface(h) === 'original'), [highlights, page]);
  // Page-local pixels: scrolling the pane during a drag must not move its first glyph.
  const dragStart = useRef<Point | null>(null);
  const measured = useRef<SpanBox[] | null>(null);
  const navigateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<Region[]>([]);
  const [selection, setSelection] = useState<{ input:AnnotationInput; position:{ left:number; top:number } } | null>(null);
  const closeSelection = useCallback(() => { setSelection(null); setPreview([]); }, []);
  const create = useCallback((input:AnnotationInput, openNote?:boolean) => {
    if (onCreateAnnotation) onCreateAnnotation(input, openNote);
    else onCreateHighlight?.(input.page, input.rects, input.text);
  }, [onCreateAnnotation, onCreateHighlight]);

  // A drag released outside this page (over another page, the gutter, the other pane)
  // never reaches this page's mouseup; the start point must not survive to pair with an
  // unrelated later release here.
  useEffect(() => {
    const clear = () => {
      if (dragStart.current !== null) setPreview([]);
      dragStart.current = null;
      measured.current = null;
    };
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    return () => { window.removeEventListener('pointerup', clear); window.removeEventListener('pointercancel', clear); if (navigateTimer.current) clearTimeout(navigateTimer.current); };
  }, []);
  useEffect(() => { closeSelection(); dragStart.current = null; measured.current = null; }, [zoom, annotationMode, closeSelection]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || annotationMode !== 'select' || (event.target as Element).closest('.annotation-selection-toolbar,.saved-ink')) return;
    if (navigateTimer.current) clearTimeout(navigateTimer.current);
    setSelection(null); setPreview([]); measured.current = null;
    const box=event.currentTarget.getBoundingClientRect();
    dragStart.current = { x: event.clientX-box.left, y: event.clientY-box.top };
  }, [annotationMode]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    const container = event.currentTarget;
    const box=container.getBoundingClientRect();
    const end={x:event.clientX-box.left,y:event.clientY-box.top};
    if (!start || Math.hypot(end.x - start.x, end.y - start.y) <= 3) return;
    if (event.pointerType === 'touch') { dragStart.current = null; return; }
    measured.current ??= measuredPdfSpans(container, true);
    const swept = sweepSelection(measured.current, start, end);
    window.getSelection()?.removeAllRanges();
    setPreview(swept ? selectionToRegions(swept.rects, {left:0,top:0,width:box.width,height:box.height}, page) ?? [] : []);
  }, [page]);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = event.currentTarget;
      const pageBox = container.getBoundingClientRect();
      const start = dragStart.current;
      dragStart.current = null;
      if (start === null) return; // the button went down on another page: not this page's gesture
      const end: Point = { x: event.clientX-pageBox.left, y: event.clientY-pageBox.top };
      const dragged = Math.hypot(end.x - start.x, end.y - start.y) > 3;
      // A plain click on a saved highlight opens its note (the box's own click handler);
      // it must not also hit-test the page beneath and jump the other pane. A drag that
      // happens to end over a box is still a drag.
      if (!dragged && (event.target as Element).closest('.highlight-box,.saved-ink,.annotation-selection-toolbar') !== null) return;

      if (dragged) {
        // The highlight follows the swept lines, not the browser's DOM-order selection;
        // the native selection is only cleared so it does not linger under the new box.
        const spans = measured.current ?? measuredPdfSpans(container, true);
        const swept = sweepSelection(spans, start, end);
        window.getSelection()?.removeAllRanges();
        if (swept === null) return;
        // pdf.js emits C0 codes for glyphs it cannot map to Unicode (math symbols); the
        // stored excerpt is one line of prose, never raw control characters.
        const text = swept.text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        const regions = selectionToRegions(swept.rects, { left: 0, top: 0, width: pageBox.width, height: pageBox.height }, page);
        if (regions !== null && text.length > 0) {
          setPreview(regions);
          setSelection({ input:{ page, rects:regions, text, surface:'original', kind:'highlight' }, position:{ left:event.clientX, top:event.clientY } });
        }
        return;
      }

      // Double/triple-click and keyboard selections are selections, never page jumps.
      const native=window.getSelection();
      if(native&&!native.isCollapsed&&native.rangeCount>0) {
        const range=native.getRangeAt(0);
        if(container.contains(range.startContainer)&&container.contains(range.endContainer)) {
          const span=range.startContainer.parentElement?.closest('.textLayer span');
          if(span?.contains(range.endContainer)) {
            const rects=selectionToRegions(Array.from(range.getClientRects()),pageBox,page);
            const text=native.toString().replace(/\p{Cc}/gu,' ').trim().slice(0,2000);
            if(rects&&text){setPreview(rects);setSelection({input:{page,rects,text,surface:'original'},position:{left:event.clientX,top:event.clientY}});}
          }
          return;
        }
      }

      // A plain click: hit-test for navigation.
      const xRatio = (event.clientX - pageBox.left) / pageBox.width;
      const yRatio = (event.clientY - pageBox.top) / pageBox.height;
      const block = hitTestBlock(blocks, page, xRatio, yRatio);
      if (block !== null) navigateTimer.current = setTimeout(() => { navigateTimer.current = null; onSelectBlock(block); }, 300);
    },
    [blocks, page, onSelectBlock],
  );

  const handleDoubleClick = useCallback((event:React.MouseEvent<HTMLDivElement>) => {
    if (navigateTimer.current) clearTimeout(navigateTimer.current);
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    const span = range.startContainer.parentElement?.closest('.textLayer span');
    if (!span || !span.contains(range.endContainer)) return;
    const rects = selectionToRegions(Array.from(range.getClientRects()), event.currentTarget.getBoundingClientRect(), page);
    const text = selected.toString().replace(/\p{Cc}/gu, ' ').trim().slice(0, 2000);
    if (rects && text) { setPreview(rects); setSelection({ input:{ page, rects, text, surface:'original' }, position:{ left:event.clientX, top:event.clientY } }); }
  }, [page]);

  return (
    <PageCanvas doc={doc} page={page} zoom={zoom} dpr={dpr} size={size} onSize={onSize} registerPage={registerPage} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onDoubleClick={handleDoubleClick}>
      <TextLayerOverlay doc={doc} page={page} zoom={zoom} />
      <HighlightLayer highlights={pageHighlights} onOpen={onOpenHighlight} />
      {preview.length > 0 ? <div className="annotation-selection-preview" aria-hidden="true">{preview.map((r, i) => <i key={i} style={{ left:`${r.x * 100}%`, top:`${r.y * 100}%`, width:`${r.width * 100}%`, height:`${r.height * 100}%` }} />)}</div> : null}
      {selection ? <SelectionToolbar selection={selection.input} position={selection.position} color={annotationColor} onCreate={create} onAsk={onAsk} onClose={closeSelection} /> : null}
      {annotationMode === 'pen' ? <InkSurface page={page} surface="original" color={annotationColor} onCreate={create} /> : null}
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
  onSelectBlock(block: Block): void;
  onCreateHighlight?(page: number, rects: Region[], text: string): void;
  onOpenHighlight(highlight: Highlight): void;
  annotationMode?: AnnotationMode;
  annotationColor?: Highlight['color'];
  annotationEraserSize?: EraserSize;
  onCreateAnnotation?(input: AnnotationInput, openNote?: boolean): void;
  onAsk?(text: string): void;
  onEraseAnnotation?(highlightId:string):void;
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
            annotationMode={props.annotationMode}
            annotationColor={props.annotationColor}
            annotationEraserSize={props.annotationEraserSize}
            onCreateAnnotation={props.onCreateAnnotation}
            onAsk={props.onAsk}
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
  );
}

export default PdfPages;
