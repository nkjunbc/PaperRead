import { useLayoutEffect, useMemo, useState, type JSX, type RefObject } from 'react';
import type { AnnotationInput, AnnotationMode, Block, Highlight, Translation } from '../../shared/contracts';
import { ANNOTATION_LAYOUT_EVENT, PEN_WIDTH, annotationSurface, translatedHighlightRegions, translationLayoutSignature, translationGeometrySignature, translationsOnPage } from '../lib/annotations';
import { HighlightLayer } from './HighlightLayer';
import { InkSurface } from './InkSurface';
import { EraserSurface } from './EraserSurface';
import type { EraserSize } from '../lib/eraser';
import { KOREAN_PAGE_LAYOUT_EVENT } from '../lib/korean-page';

export interface TranslatedAnnotationsProps {
  containerRef:RefObject<HTMLDivElement|null>; page:number; zoom:number; blocks:Block[]; translations:Translation[];
  /** The job's model (null without a job): a note sits on the translation the page shows. */
  modelId:string|null;
  /** The page still shows the original: the highlighter, pen and eraser have no translation to work on. */
  sourceOnly?:boolean;
  highlights?:Highlight[];
  /** Records not saved yet, on any page: sweeps waiting for the service, a new memo's selection. */
  drafts?:AnnotationInput[];
  annotationMode?:AnnotationMode;
  penColor?:Highlight['color']; penWidth?:number;
  annotationEraserSize?:EraserSize;
  onCreateAnnotations?(inputs:AnnotationInput[]):void;
  onOpenHighlight?(highlight:Highlight):void;
  onEraseAnnotation?(highlightId:string):void;
}

/** The highlights, memo marks and pen strokes of one Korean page, and its pen and eraser. A
 * highlight is drawn only where its quote still is; ink only on the layout it was drawn on. */
export function TranslatedAnnotations({ containerRef, page, zoom, blocks, translations, modelId, sourceOnly = false, highlights = [], drafts = [], annotationMode = 'select', penColor = 'blue', penWidth = PEN_WIDTH.initial, annotationEraserSize, onCreateAnnotations, onOpenHighlight, onEraseAnnotation }: TranslatedAnnotationsProps): JSX.Element {
  const [positioned, setPositioned] = useState<Highlight[]>([]);
  const [pageWidth, setPageWidth] = useState(0);
  const signature = useMemo(() => translationLayoutSignature(translationsOnPage(translations, blocks, page),blocks.filter((b)=>b.regions.some((r)=>r.page===page))), [translations, blocks, page]);
  const [geometrySignature,setGeometrySignature]=useState('');
  const [fontsReady,setFontsReady]=useState(()=>typeof document==='undefined'||document.fonts?.status!=='loading');
  const blocked = sourceOnly && annotationMode !== 'select';
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      setFontsReady(document.fonts?.status!=='loading');
      setPageWidth(container.getBoundingClientRect().width);
      const hasInk=annotationMode==='pen'||highlights.some((h)=>h.page===page&&h.surface==='translation'&&h.kind==='ink');
      const geometry=hasInk?translationGeometrySignature(container):'';
      setGeometrySignature(geometry);
      const measuredSignature=signature+geometry;
      if(container.dataset.annotationLayoutSignature!==measuredSignature) {
        container.dataset.annotationLayoutSignature=measuredSignature;
        document.dispatchEvent(new Event(ANNOTATION_LAYOUT_EVENT));
      }
      const next = highlights.filter((h) => h.page === page && annotationSurface(h) === 'translation').flatMap((h) => {
        if (h.kind === 'ink') return h.layoutSignature === signature+geometry ? [h] : [];
        const rects = translatedHighlightRegions(container, h,blocks,translations,modelId);
        return rects ? [{ ...h, rects }] : [];
      });
      setPositioned(next);
    };
    measure();
    container.addEventListener(KOREAN_PAGE_LAYOUT_EVENT,measure);
    const observer = new ResizeObserver(measure); observer.observe(container);
    let active = true;
    void document.fonts?.ready.then(() => { if (active) measure(); });
    document.fonts?.addEventListener('loadingdone',measure);
    document.fonts?.addEventListener('loadingerror',measure);
    const loading=()=>setFontsReady(false);
    document.fonts?.addEventListener('loading',loading);
    return () => { active = false; observer.disconnect(); container.removeEventListener(KOREAN_PAGE_LAYOUT_EVENT,measure); document.fonts?.removeEventListener('loadingdone',measure); document.fonts?.removeEventListener('loadingerror',measure); document.fonts?.removeEventListener('loading',loading); delete container.dataset.annotationLayoutSignature; document.dispatchEvent(new Event(ANNOTATION_LAYOUT_EVENT)); };
  }, [containerRef, highlights, page, signature, zoom, translations,blocks,modelId,annotationMode]);

  // A draft was made on a translation; a page showing the original has none to draw it on.
  return <>
    <HighlightLayer highlights={positioned} drafts={sourceOnly ? [] : drafts.filter((draft) => draft.page === page && draft.surface === 'translation')} pageWidth={pageWidth} onOpen={(h) => onOpenHighlight?.(h)} />
    {blocked ? <div className="annotation-unavailable-page"><p>번역이 끝난 쪽에서 쓸 수 있습니다</p></div> : null}
    {!blocked && annotationMode === 'pen' && onCreateAnnotations && geometrySignature ? <InkSurface page={page} surface="translation" color={penColor} width={penWidth} pageWidth={pageWidth} layoutSignature={signature+geometrySignature} onCreate={(input) => onCreateAnnotations([input])} disabled={!fontsReady} /> : null}
    {!blocked && annotationMode === 'erase' && onEraseAnnotation ? <EraserSurface page={page} highlights={positioned} onErase={onEraseAnnotation} size={annotationEraserSize} /> : null}
  </>;
}
