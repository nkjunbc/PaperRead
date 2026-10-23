import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type CSSProperties } from 'react';
import type { AnnotationInput, AnnotationMode, Block, Highlight, Region, Translation } from '../../shared/contracts';
import { pageRenderSize, regionToPixels, sourceClickRegions, type Size } from '../lib/geometry';
import {
  PAGE_MARGIN_BOTTOM,
  PAGE_MARGIN_TOP,
  PAGE_MARGIN_X,
  COLUMN_GUTTER,
  KOREAN_PAGE_LAYOUT_EVENT,
  buildKoreanLayout,
  fitKoreanPageHeight,
  groupKoreanSegments,
  koreanFontSizePx,
  koreanPageFallbackHeight,
  koreanPageHeight,
  type KoreanFlowItem,
  type KoreanPageFit,
} from '../lib/korean-page';
import { intrinsicSize, type PDFDocumentProxy } from '../lib/pdf';
import { visiblePageWindow } from '../lib/geometry';
import { scrollShiftForResize, scrollTopForDescendant } from '../lib/sync';
import { TranslatedAnnotations } from './TranslatedAnnotations';
import { TranslatedInline, useOtherPageImage } from './TranslatedInline';
import { SelectableSourceMath } from './SelectableSourceMath';
import { translationRuns } from '../lib/translation-text';
import type { EraserSize } from '../lib/eraser';

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

interface InlineSourceProps { imagePage:number; doc:PDFDocumentProxy; zoom:number; dpr:number }
interface TextFlowProps extends InlineSourceProps {
  image: {url:string;size:Size};
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
function TextFlow({ item, renderedPageHeight, onSelectBlock, image, imagePage, doc, zoom, dpr }: TextFlowProps): JSX.Element {
  const size = koreanFontSizePx(item.block, renderedPageHeight);
  const style = {
    fontFamily: FONT_STACK[item.block.fontFamily],
    fontWeight: translationRuns(item.text??'',item.promptVersion??'').some(run=>run.kind==='bold') ? 400 : item.block.fontWeight === 'bold' ? 700 : 400,
    fontSize: `calc(${size}px * var(--kr-font-scale, 1))`,
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
        if (event.target instanceof Element && event.target.closest('.kr-inline-math, .kr-inline-math-missing')) return;
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
      <TranslatedInline text={item.text??''} promptVersion={item.promptVersion??''} block={item.block} image={image} imagePage={imagePage} doc={doc} zoom={zoom} dpr={dpr}/>
    </p>
  );
}

interface SourceCropProps extends Omit<InlineSourceProps, 'imagePage'> {
  item: Extract<KoreanFlowItem, { kind: 'source' }>;
  image: { url: string; size: Size };
}

/** One part of a crop that runs on into the next column or page, cut from its own page's
 * render: one from another page is held at its size until that page is drawn. */
function SourcePart({ region, image, imagePage, doc, zoom, dpr }: InlineSourceProps & { region: Region; image: { url: string; size: Size } }): JSX.Element {
  const extra = useOtherPageImage(doc, region.page, imagePage, zoom, dpr);
  const source = region.page === imagePage ? image : extra ?? null;
  const size = source?.size ?? image.size;
  const rect = regionToPixels(region, size);
  const style = {
    width: rect.width,
    height: rect.height,
    backgroundImage: source === null ? undefined : `url(${source.url})`,
    backgroundSize: `${size.width}px ${size.height}px`,
    backgroundPosition: `-${rect.left}px -${rect.top}px`,
  };
  if (extra === null) return <div className="kr-source-part kr-source-part-missing" style={style} title={`원문 이미지를 불러오지 못했습니다. 원문 ${region.page}쪽을 확인해 주세요.`} />;
  return <div className="kr-source-part" style={style} />;
}

/** A figure/table/equation/reference, cropped from the original page's own render and placed
 * inline at its reading-order position — never re-drawn as a translation. A crop that runs on
 * into the next column or page is one piece, its parts stacked in reading order and all set
 * at its first part's place across the column. */
export function SourceCrop({ item, image, doc, zoom, dpr }: SourceCropProps): JSX.Element {
  if (item.continued.length > 0) {
    const style = {
      width: 'fit-content',
      marginLeft: item.align === 'center' ? 'auto' : item.inset * image.size.width,
      marginRight: item.align === 'center' ? 'auto' : undefined,
    };
    const parts = [item.region, ...item.continued].map((region, index) => (
      <SourcePart key={index} region={region} image={image} imagePage={item.region.page} doc={doc} zoom={zoom} dpr={dpr} />
    ));
    if (item.block.kind === 'equation') return <SelectableSourceMath sourceText={item.block.sourceText} blockId={item.block.blockId} page={item.region.page} style={style}>{parts}</SelectableSourceMath>;
    return <div className={`kr-source kr-${item.block.kind}`} style={style} data-block-id={item.block.blockId} aria-label={`${item.block.kind} 원문`}>{parts}</div>;
  }
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
  if (item.block.kind === 'equation') return <SelectableSourceMath sourceText={item.block.sourceText} blockId={item.block.blockId} page={item.region.page} style={style} />;
  return <div className={`kr-source kr-${item.block.kind}`} style={style} data-block-id={item.block.blockId} aria-label={`${item.block.kind} 원문`} />;
}

function FlowItemView({ item, renderedPageHeight, image, onSelectBlock, imagePage, doc, zoom, dpr }: InlineSourceProps & { item: KoreanFlowItem; renderedPageHeight: number; image: { url: string; size: Size } | null; onSelectBlock(block: Block, via: SelectVia): void }): JSX.Element | null {
  if (image === null) return null;
  if (item.kind === 'text') return <TextFlow item={item} renderedPageHeight={renderedPageHeight} onSelectBlock={onSelectBlock} image={image} imagePage={imagePage} doc={doc} zoom={zoom} dpr={dpr}/>;
  return <SourceCrop item={item} image={image} doc={doc} zoom={zoom} dpr={dpr} />;
}

interface KoreanPageViewProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: number;
  dpr: number;
  blocks: Block[];
  translations: Translation[];
  /** The job's model, or null when the paper has no job: only its translations are shown. */
  modelId: string | null;
  /** The box the page held as a placeholder, kept until it is drawn so nothing below it moves. */
  placeholder: Size;
  onHeight(page: number, heightPx: number): void;
  onSelectBlock(block: Block, via: SelectVia): void;
  highlights?:Highlight[];
  annotationMode?:AnnotationMode;
  annotationColor?:Highlight['color'];
  annotationEraserSize?:EraserSize;
  onCreateAnnotation?(input:AnnotationInput, openNote?:boolean):void;
  onOpenHighlight?(highlight:Highlight):void;
  onAsk?(text:string):void;
  onEraseAnnotation?(highlightId:string):void;
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
function KoreanPageView(props: KoreanPageViewProps): JSX.Element {
  const { doc, page, zoom, dpr, blocks, translations, modelId, placeholder, onHeight, onSelectBlock } = props;
  const image = useSourcePageImage(doc, page, zoom, dpr);
  const layout = useMemo(() => buildKoreanLayout(blocks, translations, page, modelId), [blocks, translations, page, modelId]);
  const segments = useMemo(() => groupKoreanSegments(layout.items, layout.columnCount), [layout]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reportedHeight = useRef<number | null>(null);
  const annotations = <TranslatedAnnotations containerRef={containerRef} page={page} zoom={zoom} blocks={blocks} translations={translations} modelId={modelId} highlights={props.highlights} annotationMode={props.annotationMode} annotationColor={props.annotationColor} annotationEraserSize={props.annotationEraserSize} onCreateAnnotation={props.onCreateAnnotation} onOpenHighlight={props.onOpenHighlight} onAsk={props.onAsk} onEraseAnnotation={props.onEraseAnnotation} />;

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (node === null || image === null) return;
    let active=true;
    const apply=(fit:KoreanPageFit)=>{
      node.style.setProperty('--kr-font-scale',String(fit.fontScale));
      node.style.setProperty('--kr-line-height',String(fit.lineHeight));
      node.style.setProperty('--kr-paragraph-gap',`${fit.paragraphGap}em`);
      node.style.setProperty('--kr-source-gap',`${fit.paragraphGap*image.size.height*.012}px`);
    };
    const measure=()=>{
      if(!active)return;
      if(!layout.sourceOnly) {
        const fit=fitKoreanPageHeight(image.size.height,candidate=>{
          apply(candidate);
          return node.getBoundingClientRect().height;
        });
        apply(fit);
        node.dataset.fitScale=String(fit.fontScale);
      }
      // Only the final typography is observable outside this synchronous layout pass.
      // No ResizeObserver writes to this page, so its own fit cannot schedule a fit loop.
      node.dispatchEvent(new Event(KOREAN_PAGE_LAYOUT_EVENT));
      const height=Math.max(node.getBoundingClientRect().height,node.scrollHeight);
      if(reportedHeight.current===height)return;
      reportedHeight.current=height;
      onHeight(page,height);
    };
    measure();
    // A webfont can finish after the first layout. Refit using its actual glyph metrics.
    void document.fonts?.ready.then(measure);
    document.fonts?.addEventListener('loadingdone',measure);
    document.fonts?.addEventListener('loadingerror',measure);
    return()=>{active=false;document.fonts?.removeEventListener('loadingdone',measure);document.fonts?.removeEventListener('loadingerror',measure);};
  },[image,layout,onHeight,page]);

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
        {annotations}
      </div>
    );
  }

  return (
    <div
      className="kr-page"
      data-page={page}
      ref={containerRef}
      style={{ width: image.size.width, minHeight:renderedPageHeight, padding: `${marginTop}px ${marginX}px ${marginBottom}px`, '--kr-column-gap':`${COLUMN_GUTTER*image.size.width}px` } as CSSProperties}
    >
      {segments.map((segment, index) =>
        segment.type === 'full' ? (
          <div className="kr-row kr-row-full" key={index}>
            <FlowItemView item={segment.item} renderedPageHeight={renderedPageHeight} image={image} onSelectBlock={onSelectBlock} imagePage={page} doc={doc} zoom={zoom} dpr={dpr} />
          </div>
        ) : (
          <div className="kr-row kr-row-columns" key={index}>
            <div className="kr-column">
              {segment.left.map((item) => (
                <FlowItemView key={item.block.blockId} item={item} renderedPageHeight={renderedPageHeight} image={image} onSelectBlock={onSelectBlock} imagePage={page} doc={doc} zoom={zoom} dpr={dpr} />
              ))}
            </div>
            {segment.right.length > 0 ? (
              <div className="kr-column">
                {segment.right.map((item) => (
                  <FlowItemView key={item.block.blockId} item={item} renderedPageHeight={renderedPageHeight} image={image} onSelectBlock={onSelectBlock} imagePage={page} doc={doc} zoom={zoom} dpr={dpr} />
                ))}
              </div>
            ) : null}
          </div>
        ),
      )}
      {annotations}
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
  /** The job's model, or null when the paper has no job: only its translations are shown. */
  modelId: string | null;
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
  highlights?:Highlight[];
  annotationMode?:AnnotationMode;
  annotationColor?:Highlight['color'];
  annotationEraserSize?:EraserSize;
  onCreateAnnotation?(input:AnnotationInput, openNote?:boolean):void;
  onOpenHighlight?(highlight:Highlight):void;
  onAsk?(text:string):void;
  onEraseAnnotation?(highlightId:string):void;
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
            modelId={props.modelId}
            placeholder={placeholderSize(page)}
            onHeight={reportHeight}
            onSelectBlock={onSelectBlock}
            highlights={props.highlights}
            annotationMode={props.annotationMode}
            annotationColor={props.annotationColor}
            annotationEraserSize={props.annotationEraserSize}
            onCreateAnnotation={props.onCreateAnnotation}
            onOpenHighlight={props.onOpenHighlight}
            onAsk={props.onAsk}
            onEraseAnnotation={props.onEraseAnnotation}
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
