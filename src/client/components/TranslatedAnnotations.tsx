import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import type { AnnotationInput, AnnotationMode, Block, Highlight, Translation } from '../../shared/contracts';
import { ANNOTATION_LAYOUT_EVENT, annotationSurface, translatedHighlightRegions, translatedSelection, translationLayoutSignature, translationGeometrySignature, translationsOnPage } from '../lib/annotations';
import { HighlightLayer } from './HighlightLayer';
import { InkSurface } from './InkSurface';
import { EraserSurface } from './EraserSurface';
import { SelectionToolbar } from './AnnotationTools';
import { trackPresses } from './SelectionQuote';
import type { EraserSize } from '../lib/eraser';
import { KOREAN_PAGE_LAYOUT_EVENT } from '../lib/korean-page';

export interface TranslatedAnnotationsProps {
  containerRef:RefObject<HTMLDivElement|null>; page:number; zoom:number; blocks:Block[]; translations:Translation[];
  /** The job's model (null without a job): a note sits on the translation the page shows. */
  modelId:string|null;
  highlights?:Highlight[]; annotationMode?:AnnotationMode; annotationColor?:Highlight['color'];
  annotationEraserSize?:EraserSize;
  onCreateAnnotation?(input:AnnotationInput, openNote?:boolean):void;
  onOpenHighlight?(highlight:Highlight):void; onAsk?(text:string):void;
  onEraseAnnotation?(highlightId:string):void;
}

export function TranslatedAnnotations({ containerRef, page, zoom, blocks, translations, modelId, highlights = [], annotationMode = 'select', annotationColor = 'yellow', annotationEraserSize, onCreateAnnotation, onOpenHighlight, onAsk, onEraseAnnotation }: TranslatedAnnotationsProps): JSX.Element {
  const [positioned, setPositioned] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState<{ input:AnnotationInput; position:{ left:number; top:number } } | null>(null);
  const frame = useRef<number|null>(null);
  const closeSelection = useCallback(() => setSelection(null), []);
  const signature = useMemo(() => translationLayoutSignature(translationsOnPage(translations, blocks, page),blocks.filter((b)=>b.regions.some((r)=>r.page===page))), [translations, blocks, page]);
  const [geometrySignature,setGeometrySignature]=useState('');
  const [fontsReady,setFontsReady]=useState(()=>typeof document==='undefined'||document.fonts?.status!=='loading');
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      setFontsReady(document.fonts?.status!=='loading');
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

  useEffect(() => {
    closeSelection();
    if (annotationMode !== 'select' || !onCreateAnnotation) return;
    const measure = () => {
      frame.current = null;
      const container = containerRef.current;
      if (!container) return;
      const selected = window.getSelection();
      const input = translatedSelection(container, page, selected);
      if (!input || !selected?.rangeCount) { setSelection(null); return; }
      const box = container.getBoundingClientRect();
      setSelection({ input, position:{ left:box.left+Math.min(...input.rects.map(rect=>rect.x))*box.width, top:box.top+Math.max(...input.rects.map(rect=>rect.y+rect.height))*box.height } });
    };
    const schedule = () => { if (!presses.pressed && frame.current === null) frame.current = requestAnimationFrame(measure); };
    const presses = trackPresses(document, (e) => e.target instanceof Node && (containerRef.current?.contains(e.target) ?? false) && !(e.target instanceof Element && e.target.closest('.annotation-selection-toolbar')), { onPress:closeSelection, onRelease:schedule });
    document.addEventListener('selectionchange', schedule);
    return () => { presses.dispose(); document.removeEventListener('selectionchange', schedule); if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, [containerRef, page, zoom, annotationMode, onCreateAnnotation, closeSelection]);

  return <>
    <HighlightLayer highlights={positioned} onOpen={(h) => onOpenHighlight?.(h)} />
    {selection && onCreateAnnotation ? <SelectionToolbar selection={selection.input} position={selection.position} color={annotationColor} onCreate={onCreateAnnotation} onAsk={onAsk} onClose={closeSelection} /> : null}
    {annotationMode === 'pen' && onCreateAnnotation && geometrySignature ? <InkSurface page={page} surface="translation" color={annotationColor} layoutSignature={signature+geometrySignature} onCreate={onCreateAnnotation} disabled={!fontsReady} /> : null}
    {annotationMode === 'erase' && onEraseAnnotation ? <EraserSurface page={page} highlights={positioned} onErase={onEraseAnnotation} size={annotationEraserSize} /> : null}
  </>;
}
