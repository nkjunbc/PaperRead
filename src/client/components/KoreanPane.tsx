import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { Block, Translation } from '../../shared/contracts';
import { pageRenderSize, regionToPixels, sourceClickRegions, type Size } from '../lib/geometry';
import {
  PAGE_MARGIN_BOTTOM,
  PAGE_MARGIN_TOP,
  PAGE_MARGIN_X,
  buildKoreanLayout,
  groupKoreanSegments,
  koreanFontSizePx,
  koreanPageFallbackHeight,
  koreanPageHeight,
  type KoreanFlowItem,
} from '../lib/korean-page';
import { intrinsicSize, type PDFDocumentProxy } from '../lib/pdf';
import { visiblePageWindow } from '../lib/geometry';
import { scrollShiftForResize, scrollTopForDescendant } from '../lib/sync';

/** A one-time full-page render of the original PDF, rasterised for cropping figures/tables/
 * equations/references out of it and — on a source-only page — for showing it unchanged.
 *
 * Null until the render for this page at this zoom is ready. A render made for the previous
 * zoom is never handed out, not even for the one commit before the effect below drops it: the
 * page would be drawn — and measured and reported — at its old size, and every pane position
 * worked out for the new zoom in that commit (App keeps the reader's place across a zoom change)
 * would be off by the difference. */
function useSourcePageImage(doc: PDFDocumentProxy, page: number, zoom: number, dpr: number): { url: string; size: Size } | null {
  const [state, setState] = useState<{ url: string; size: Size; doc: PDFDocumentProxy; page: number; zoom: number; dpr: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    setState(null);

    void (async () => {
      const proxy = await doc.getPage(page);
      if (cancelled) return;
      const intrinsic = intrinsicSize(proxy);
      const rendered = pageRenderSize(intrinsic, zoom);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(rendered.width * dpr));
      canvas.height = Math.max(1, Math.floor(rendered.height * dpr));
      const context = canvas.getContext('2d');
      if (context === null) return;
      const render = proxy.render({ canvas, canvasContext: context, viewport: proxy.getViewport({ scale: zoom * dpr }) });
      task = render;
      try {
        await render.promise;
      } catch {
        return; // superseded by a newer zoom, or unmounted
      }
      if (cancelled) return;
      setState({ url: canvas.toDataURL(), size: rendered, doc, page, zoom, dpr });
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, dpr]);

  return state !== null && state.doc === doc && state.page === page && state.zoom === zoom && state.dpr === dpr ? state : null;
}

const FONT_STACK: Record<Block['fontFamily'], string> = {
  serif: "'Noto Serif KR', 'Batang', serif",
  sans: "'Pretendard', 'Malgun Gothic', sans-serif",
};

/** How a paragraph was chosen: a click on its text, which may be the first of a double-click
 * that selects a word, or a key or a button, which cannot. */
export type SelectVia = 'text' | 'control';

interface TextFlowProps {
  item: Extract<KoreanFlowItem, { kind: 'text' }>;
  renderedPageHeight: number;
  onSelectBlock(block: Block, via: SelectVia): void;
}

/** True when the reader has text selected inside `node` — a drag to quote, not a click. */
function selectingIn(node: Node): boolean {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  return node.contains(selection.anchorNode) || node.contains(selection.focusNode);
}

/** One translated paragraph/heading/caption. */
function TextFlow({ item, renderedPageHeight, onSelectBlock }: TextFlowProps): JSX.Element {
  const size = koreanFontSizePx(item.block, renderedPageHeight);
  const style = {
    fontFamily: FONT_STACK[item.block.fontFamily],
    fontWeight: item.block.fontWeight === 'bold' ? 700 : 400,
    fontSize: `${size}px`,
    textAlign: item.align === 'center' ? ('center' as const) : undefined,
  };
  return (
    <p
      className={`kr-text kr-${item.block.kind}`}
      style={style}
      data-block-id={item.block.blockId}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        // Selecting words to quote them ends in a click on the same paragraph; that is not a jump.
        // Nor are the second and third clicks of a double- or triple-click, which select.
        if (event.detail > 1 || selectingIn(event.currentTarget)) return;
        onSelectBlock(item.block, 'text');
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectBlock(item.block, 'control');
      }}
    >
      {item.text ?? ''}
    </p>
  );
}

interface SourceCropProps {
  item: Extract<KoreanFlowItem, { kind: 'source' }>;
  image: { url: string; size: Size };
}

/** A figure/table/equation/reference, cropped from the original page's own render and placed
 * inline at its reading-order position — never re-drawn as a translation. */
function SourceCrop({ item, image }: SourceCropProps): JSX.Element {
  const rect = regionToPixels(item.region, image.size);
  const style = {
    width: rect.width,
    height: rect.height,
    // Where the original set it across the column: centred, or indented from the text edge.
    marginLeft: item.align === 'center' ? 'auto' : item.inset * image.size.width,
    marginRight: item.align === 'center' ? 'auto' : undefined,
    backgroundImage: `url(${image.url})`,
    backgroundSize: `${image.size.width}px ${image.size.height}px`,
    backgroundPosition: `-${rect.left}px -${rect.top}px`,
  };
  return <div className={`kr-source kr-${item.block.kind}`} style={style} data-block-id={item.block.blockId} aria-label={`${item.block.kind} 원문`} />;
}

function FlowItemView({ item, renderedPageHeight, image, onSelectBlock }: { item: KoreanFlowItem; renderedPageHeight: number; image: { url: string; size: Size } | null; onSelectBlock(block: Block, via: SelectVia): void }): JSX.Element | null {
  if (item.kind === 'text') return <TextFlow item={item} renderedPageHeight={renderedPageHeight} onSelectBlock={onSelectBlock} />;
  if (image === null) return null;
  return <SourceCrop item={item} image={image} />;
}

interface KoreanPageViewProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: number;
  dpr: number;
  blocks: Block[];
  translations: Translation[];
  /** The box the page held as a placeholder, kept until it is drawn so nothing below it moves. */
  placeholder: Size;
  onHeight(page: number, heightPx: number): void;
  onSelectBlock(block: Block, via: SelectVia): void;
}

/**
 * One Korean page: the source body area cleared and re-flowed with translated prose, figures
 * and tables cropped from the original in their reading-order spot, equations/references kept
 * verbatim. A page with no translatable block shows the original page unchanged.
 *
 * The page's rendered height is not known in advance — translated text can run longer than the
 * original, and cropped figures add their own height — so this component measures its own
 * rendered height after layout and reports it upward for the next stage's page-boundary math.
 */
function KoreanPageView({ doc, page, zoom, dpr, blocks, translations, placeholder, onHeight, onSelectBlock }: KoreanPageViewProps): JSX.Element {
  const image = useSourcePageImage(doc, page, zoom, dpr);
  const layout = useMemo(() => buildKoreanLayout(blocks, translations, page), [blocks, translations, page]);
  const segments = useMemo(() => groupKoreanSegments(layout.items, layout.columnCount), [layout]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reportedHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    reportedHeight.current = null;
  }, [layout, zoom]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (node === null || image === null) return;
    const height = node.scrollHeight;
    if (reportedHeight.current === height) return;
    reportedHeight.current = height;
    onHeight(page, height);
  });

  if (image === null) {
    return (
      <div className="kr-page kr-placeholder" data-page={page} ref={containerRef} style={{ width: placeholder.width, height: placeholder.height }}>
        {page}쪽
      </div>
    );
  }

  const renderedPageHeight = image.size.height;
  const marginX = PAGE_MARGIN_X * image.size.width;
  const marginTop = PAGE_MARGIN_TOP * renderedPageHeight;
  const marginBottom = PAGE_MARGIN_BOTTOM * renderedPageHeight;

  if (layout.sourceOnly) {
    return (
      <div className="kr-page kr-source-only" data-page={page} ref={containerRef} style={{ width: image.size.width, height: image.size.height }}>
        <img src={image.url} alt={`${page}쪽 원문`} style={{ width: image.size.width, height: image.size.height, display: 'block' }} />
        {sourceClickRegions(blocks, page).map(({ block, region }, index) => (
          <button
            key={`${block.blockId}-${index}`}
            type="button"
            className="source-block-target"
            aria-label={`${page}쪽 ${block.kind}`}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
            onClick={() => onSelectBlock(block, 'control')}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="kr-page"
      data-page={page}
      ref={containerRef}
      style={{ width: image.size.width, padding: `${marginTop}px ${marginX}px ${marginBottom}px` }}
    >
      {segments.map((segment, index) =>
        segment.type === 'full' ? (
          <div className="kr-row kr-row-full" key={index}>
            <FlowItemView item={segment.item} renderedPageHeight={renderedPageHeight} image={image} onSelectBlock={onSelectBlock} />
          </div>
        ) : (
          <div className="kr-row kr-row-columns" key={index}>
            <div className="kr-column">
              {segment.left.map((item) => (
                <FlowItemView key={item.block.blockId} item={item} renderedPageHeight={renderedPageHeight} image={image} onSelectBlock={onSelectBlock} />
              ))}
            </div>
            {segment.right.length > 0 ? (
              <div className="kr-column">
                {segment.right.map((item) => (
                  <FlowItemView key={item.block.blockId} item={item} renderedPageHeight={renderedPageHeight} image={image} onSelectBlock={onSelectBlock} />
                ))}
              </div>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}

export interface KoreanPaneProps {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  zoom: number;
  blocks: Block[];
  translations: Translation[];
  /** Shared with boundary calculation so virtual placeholders never diverge. */
  pageHeights: Map<number, number>;
  /** Native PDF dimensions shared by placeholder and boundary calculations. */
  pageIntrinsicSize(page: number): Size;
  /** The measured rendered height of a live page, in pixels — the next stage uses this to
   * compute the Korean pane's own page boundaries. */
  onPageHeight(page: number, heightPx: number): void;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onScroll(): void;
  /** Called just before the pane shifts its own scroll position to keep the reader's place. */
  onAdjustScroll?(): void;
  onSelectBlock(block: Block, via: SelectVia): void;
}

/**
 * The right pane: a Korean page per original page, in the same document order.
 *
 * Only pages inside the visible window are mounted — the same window the source pane uses —
 * so a long paper never lays out every Korean page at once (spec R06). Pages outside the
 * window are held with a fixed-size placeholder so the scrollbar keeps a sane proportion even
 * though a Korean page's true height is not known until it is actually drawn.
 */
export function KoreanPages(props: KoreanPaneProps): JSX.Element {
  const { doc, pageCount, currentPage, zoom, blocks, translations, pageHeights, pageIntrinsicSize, onPageHeight, bodyRef, onScroll, onAdjustScroll, onSelectBlock } = props;
  const dpr = useMemo(() => Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1), []);
  const live = useMemo(() => new Set(visiblePageWindow(currentPage, pageCount, 1)), [currentPage, pageCount]);
  const [, setHeightVersion] = useState(0);
  const fallbackHeight = useCallback((page: number) => koreanPageFallbackHeight(pageIntrinsicSize(page), zoom), [pageIntrinsicSize, zoom]);
  const placeholderSize = useCallback(
    (page: number): Size => ({ width: pageRenderSize(pageIntrinsicSize(page), zoom).width, height: koreanPageHeight(pageHeights.get(page), fallbackHeight(page)) }),
    [fallbackHeight, pageHeights, pageIntrinsicSize, zoom],
  );
  // Every drawn or re-laid-out page reports here, whether or not its height moved: the scroll
  // link re-reads its paragraph positions. The page held its last measured (or placeholder)
  // height until now; the pane is shifted by the change above the reader's view so the
  // content they are looking at stays where it is. The browser's own scroll anchoring is
  // off for the pane (styles.css), so this is the only correction.
  const reportHeight = useCallback(
    (page: number, height: number) => {
      const cachedHeight = pageHeights.get(page);
      const body = bodyRef.current;
      const node = body?.querySelector<HTMLElement>(`:scope > [data-page="${page}"]`) ?? null;
      if (body !== null && node !== null) {
        const top = scrollTopForDescendant(node.getBoundingClientRect().top, body.getBoundingClientRect().top, body.scrollTop);
        const shift = scrollShiftForResize(top, koreanPageHeight(cachedHeight, fallbackHeight(page)), height, body.scrollTop);
        if (Math.abs(shift) >= 0.5) {
          onAdjustScroll?.();
          body.scrollTop += shift;
        }
      }
      onPageHeight(page, height);
      if (cachedHeight !== height) setHeightVersion((version) => version + 1);
    },
    [bodyRef, fallbackHeight, onAdjustScroll, onPageHeight, pageHeights],
  );

  if (doc === null) {
    return (
      <div className="pane-body" ref={bodyRef} onScroll={onScroll}>
        <p className="empty">원본 PDF를 아직 불러오지 않았습니다.</p>
      </div>
    );
  }

  return (
    <div className="pane-body" ref={bodyRef} onScroll={onScroll} data-testid="korean-body">
      {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) =>
        live.has(page) ? (
          <KoreanPageView
            key={page}
            doc={doc}
            page={page}
            zoom={zoom}
            dpr={dpr}
            blocks={blocks}
            translations={translations}
            placeholder={placeholderSize(page)}
            onHeight={reportHeight}
            onSelectBlock={onSelectBlock}
          />
        ) : (
          <div key={page} className="kr-page kr-placeholder" data-page={page} style={placeholderSize(page)}>
            {page}쪽
          </div>
        ),
      )}
    </div>
  );
}

export default KoreanPages;
