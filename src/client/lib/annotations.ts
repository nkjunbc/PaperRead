import type { AnnotationInput, AnnotationSurface, Block, Highlight, InkPoint, TextAnchor, Translation } from '../../shared/contracts';
import { selectTranslations } from '../../shared/translations';
import { selectionToRegions, type PixelRect, type SpanBox } from './highlights';
import { renderedTranslationText, sourceMathText, translationTextParts } from './translation-text';

export function annotationSurface(highlight: Highlight): AnnotationSurface { return highlight.surface ?? 'original'; }
/** Contains only a page's layout identity, never document text or account information. */
export const ANNOTATION_LAYOUT_EVENT='paperread-annotation-layout';

/** A moved quote is safe only when there is exactly one match in its original paragraph. */
export function resolveTextAnchor(text: string, anchor: TextAnchor): { start: number; end: number } | null {
  if (text.slice(anchor.start, anchor.end) === anchor.quote) return { start: anchor.start, end: anchor.end };
  const start = text.indexOf(anchor.quote);
  if (start < 0 || text.indexOf(anchor.quote, start + 1) >= 0) return null;
  return { start, end: start + anchor.quote.length };
}

/** Old annotations counted no text for math images. Map their exact legacy offsets rather
 * than searching the new string, which could point at another occurrence of the same word. */
export function resolveTranslationAnchor(translation:Translation|undefined,block:Block|undefined,anchor:TextAnchor):{start:number;end:number}|null {
  if(block?.kind==='equation'&&!block.translatable)return resolveTextAnchor(sourceMathText(block.sourceText),anchor);
  if(translation?.status!=='completed'||translation.text===null)return null;
  if(anchor.textVersion===2)return resolveTextAnchor(renderedTranslationText(translation.text,translation.promptVersion,block),anchor);
  const offsets=resolveTextAnchor(renderedTranslationText(translation.text,translation.promptVersion),anchor);
  if(!offsets)return null;
  let legacyPosition=0,start=offsets.start,end=offsets.end;
  for(const part of translationTextParts(translation.text,translation.promptVersion,block)) {
    if(part.math) {
      if(legacyPosition<=offsets.start)start+=part.text.length;
      if(legacyPosition<offsets.end)end+=part.text.length;
    }else legacyPosition+=part.text.length;
  }
  return {start,end};
}

function annotationHash(value:unknown):string {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Content plus the source geometry/typography and renderer format, independent of zoom. */
export function translationLayoutSignature(translations: Translation[], blocks:Block[] = []): string {
  const content = translations.filter((t) => t.status === 'completed').map((t) => [t.blockId, t.text ?? '',t.promptVersion]).sort((a, b) => a[0].localeCompare(b[0]));
  const layout = blocks.map((b) => ({id:b.blockId,order:b.order,kind:b.kind,regions:b.regions,font:b.fontFamily,weight:b.fontWeight,size:b.fontSize,spans:b.sourceSpans ?? []})).sort((a,b) => a.order-b.order);
  return annotationHash({format:'paperread-ink-layout-2',content,layout});
}

/** Computed font-family still names Pretendard while the browser is drawing its fallback. */
export function loadedFontIdentity(fontFamily:string,fonts:Iterable<FontFace>):string[] {
  const normalize=(value:string)=>value.replace(/['"]/g,'').trim().toLowerCase();
  const families=new Set(fontFamily.split(',').map(normalize));
  return Array.from(fonts).filter((font)=>font.status==='loaded'&&families.has(normalize(font.family))).map((font)=>`${normalize(font.family)}:${font.style}:${font.weight}:${font.stretch}`).sort();
}

/** Actual line break offsets catch font/reflow changes. Coordinate rounding ignores harmless
 * subpixel differences across zooms while content/font/line identities remain exact. */
export function translationGeometrySignature(container:HTMLElement):string {
  const page=container.getBoundingClientRect();
  if(page.width<=0)return annotationHash([]);
  const paragraphs=Array.from(container.querySelectorAll<HTMLElement>('.kr-text')).map((paragraph)=>{
    const style=getComputedStyle(paragraph);
    const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);
    const breaks:number[]=[];
    let index=0, rowTop=-Infinity, rowBottom=-Infinity;
    let node:Node|null;
    while((node=walker.nextNode())) {
      if(node.parentElement?.closest('.kr-math-text'))continue;
      const text=node.textContent??'';
      for(let at=0;at<text.length;) {
        const length=(text.codePointAt(at)??0)>0xffff?2:1;
        const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+length);
        const rect=range.getBoundingClientRect();
        if(rect.width>0&&rect.height>0) {
          const center=rect.top+rect.height/2;
          if(center<rowTop||center>rowBottom){breaks.push(index+at);rowTop=rect.top;rowBottom=rect.bottom;}
        }
        at+=length;
      }
      index+=text.length;
    }
    return {id:paragraph.dataset.blockId,breaks,font:style.fontFamily,loadedFonts:loadedFontIdentity(style.fontFamily,document.fonts),weight:style.fontWeight,lineHeight:Math.round(parseFloat(style.lineHeight)/parseFloat(style.fontSize)*100)/100};
  });
  const fit=['--kr-font-scale','--kr-line-height','--kr-paragraph-gap'].map(name=>container.style.getPropertyValue(name));
  return annotationHash({ratio:Math.round(page.height/page.width*100)/100,paragraphs,fit});
}

export function translationsOnPage(translations: Translation[], blocks: Block[], page: number): Translation[] {
  const ids = new Set(blocks.filter((block) => block.regions[0]?.page === page).map((block) => block.blockId));
  return translations.filter((t) => ids.has(t.blockId));
}

/** `modelId` is the job's model (null without a job): a note is checked against the translation
 * the Korean page shows for its paragraph. */
export function annotationUnavailable(highlight: Highlight, translations: Translation[], blocks: Block[], renderedLayoutSignature: string | undefined, modelId: string | null): boolean {
  if (annotationSurface(highlight) !== 'translation') return false;
  if (highlight.kind === 'ink') {
    if(renderedLayoutSignature!==undefined)return highlight.layoutSignature!==renderedLayoutSignature;
    return !highlight.layoutSignature?.startsWith(translationLayoutSignature(translationsOnPage(translations, blocks, highlight.page),blocks.filter((b)=>b.regions.some((r)=>r.page===highlight.page))));
  }
  const shown = selectTranslations(blocks, translations, modelId);
  return !highlight.anchors?.every((anchor) => resolveTranslationAnchor(shown.get(anchor.blockId),blocks.find(block=>block.blockId===anchor.blockId),anchor)!==null);
}

/** Measure each UTF-16 character with Range; pdf.js CSS scaling is already reflected here. */
export function measuredPdfSpans(container: HTMLElement, pageRelative = false): SpanBox[] {
  const origin = pageRelative ? container.getBoundingClientRect() : { left:0, top:0 };
  return Array.from(container.querySelectorAll<HTMLElement>('.textLayer span')).filter((span) => !span.querySelector('span')).map((span) => {
    const rect = span.getBoundingClientRect();
    const glyphs: NonNullable<SpanBox['glyphs']> = [];
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      for (let start = 0; start < text.length;) {
        const length = (text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + length);
        const glyph = range.getBoundingClientRect();
        if (glyph.width > 0 && glyph.height > 0) glyphs.push({ text: text.slice(start, start + length), rect: { left: glyph.left-origin.left, top: glyph.top-origin.top, width: glyph.width, height: glyph.height } });
        start += length;
      }
    }
    return { text: span.textContent ?? '', rect: { left: rect.left-origin.left, top: rect.top-origin.top, width: rect.width, height: rect.height }, ...(glyphs.length > 0 ? { glyphs } : {}) };
  });
}

function rangeForOffsets(element: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let cursor = 0;
  let foundStart = false;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!foundStart && start <= cursor + length) { range.setStart(node, Math.max(0, start - cursor)); foundStart = true; }
    if (foundStart && end <= cursor + length) { range.setEnd(node, Math.max(0, end - cursor)); return range; }
    cursor += length;
  }
  return null;
}

const ANNOTATION_TEXT_SELECTOR='.kr-text[data-block-id], .kr-math-block[data-block-id]';

/** Touching the boundary after a formula is not selecting that formula. */
export function rangeContainsText(range:Range,node:Node|null):boolean {
  if(!node||!range.intersectsNode(node))return false;
  const length=node.textContent?.length??0;
  const start=range.startContainer===node?range.startOffset:0;
  const end=range.endContainer===node?range.endOffset:length;
  return end>start;
}

function mathRectsInRange(element:HTMLElement,range:Range):PixelRect[] {
  return Array.from(element.querySelectorAll<HTMLElement>('.kr-math-text')).filter(math=>rangeContainsText(range,math.firstChild)).map(math=>math.parentElement!.getBoundingClientRect());
}

/** `modelId` is the job's model (null without a job): a note is drawn on the translation the
 * Korean page shows for its paragraph. */
export function translatedHighlightRegions(container: HTMLElement, highlight: Highlight, blocks: Block[], translations: Translation[], modelId: string | null): Highlight['rects'] | null {
  if (highlight.kind === 'ink') return highlight.rects;
  if (!highlight.anchors?.length) return null;
  const shown = selectTranslations(blocks, translations, modelId);
  const rects: PixelRect[] = [];
  for (const anchor of highlight.anchors) {
    // Compare data attributes directly: block IDs never become CSS selectors.
    const paragraph = Array.from(container.querySelectorAll<HTMLElement>(ANNOTATION_TEXT_SELECTOR)).find((p) => p.dataset.blockId === anchor.blockId);
    if (!paragraph) return null;
    const offsets = resolveTranslationAnchor(shown.get(anchor.blockId),blocks.find(b=>b.blockId===anchor.blockId),anchor);
    if (!offsets) return null;
    const range = rangeForOffsets(paragraph, offsets.start, offsets.end);
    if (!range) return null;
    rects.push(...Array.from(range.getClientRects()));
    rects.push(...mathRectsInRange(paragraph,range));
  }
  return selectionToRegions(rects, container.getBoundingClientRect(), highlight.page);
}

export function translatedSelection(container: HTMLElement, page: number, selection: Selection | null): AnnotationInput | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  const anchors: TextAnchor[] = [];
  const rects: PixelRect[] = [];
  let remaining = 2000;
  for (const paragraph of container.querySelectorAll<HTMLElement>(ANNOTATION_TEXT_SELECTOR)) {
    if (!range.intersectsNode(paragraph) || remaining <= 0) continue;
    const text = paragraph.textContent ?? '';
    const offset = (node: Node, position: number) => {
      const prefix = document.createRange(); prefix.selectNodeContents(paragraph); prefix.setEnd(node, position); return prefix.toString().length;
    };
    const start = paragraph.contains(range.startContainer) ? offset(range.startContainer, range.startOffset) : 0;
    const end = Math.min(paragraph.contains(range.endContainer) ? offset(range.endContainer, range.endOffset) : text.length, start + remaining);
    if (end <= start) continue;
    const quote = text.slice(start, end);
    if (!quote.trim()) continue;
    const selected = rangeForOffsets(paragraph, start, end);
    if (!selected) continue;
    anchors.push({ blockId: paragraph.dataset.blockId!, start, end, quote, textVersion:2 });
    rects.push(...Array.from(selected.getClientRects()));
    rects.push(...mathRectsInRange(paragraph,selected));
    remaining -= quote.length;
  }
  if (anchors.length === 0) return null;
  const regions = selectionToRegions(rects, container.getBoundingClientRect(), page);
  if (!regions) return null;
  return { page, surface: 'translation', kind: 'highlight', rects: regions, text: anchors.map((a) => a.quote).join(' ').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000), anchors };
}

/** Store a stroke compactly so a long gesture stays inside the HTTP body limit. */
export function inkToAnnotation(points: InkPoint[], page: number, surface: AnnotationSurface, color: Highlight['color'], layoutSignature?: string): AnnotationInput | null {
  if (points.length < 2) return null;
  const keep = points.length <= 1200 ? points : Array.from({ length: 1200 }, (_, i) => points[Math.round(i * (points.length - 1) / 1199)]);
  const round = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100000) / 100000;
  const bounded = keep.map((p) => ({ x: round(p.x), y: round(p.y) }));
  const width = 0.003;
  const minX = Math.max(0, Math.min(...bounded.map((p) => p.x)) - width);
  const minY = Math.max(0, Math.min(...bounded.map((p) => p.y)) - width);
  const maxX = Math.min(1, Math.max(...bounded.map((p) => p.x)) + width);
  const maxY = Math.min(1, Math.max(...bounded.map((p) => p.y)) + width);
  return { page, surface, kind: 'ink', text: '필기', color, rects: [{ page, x: minX, y: minY, width: maxX - minX, height: maxY - minY }], strokes: [{ points: bounded, width }], ...(layoutSignature ? { layoutSignature } : {}) };
}
