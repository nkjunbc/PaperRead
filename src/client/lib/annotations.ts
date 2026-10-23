import type { AnnotationInput, AnnotationSurface, Block, Highlight, InkPoint, TextAnchor, Translation } from '../../shared/contracts';
import { selectTranslations } from '../../shared/translations';
import { keepsKeysToItself } from './find';
import { selectionToRegions, type PageSweep, type PixelRect, type SpanBox } from './highlights';
import type { Size } from './geometry';
import { inlineMathText, renderedTranslationText, sourceMathText, translationTextParts } from './translation-text';

export function annotationSurface(highlight: Highlight): AnnotationSurface { return highlight.surface ?? 'original'; }
/** Contains only a page's layout identity, never document text or account information. */
export const ANNOTATION_LAYOUT_EVENT='paperread-annotation-layout';

/** A note is drawn only where it was made: its quote at exactly its stored offsets. A quote
 * found anywhere else in a changed paragraph is lost, never relocated, so nothing is ever
 * drawn over text the reader did not mark. */
export function resolveTextAnchor(text: string, anchor: TextAnchor): { start: number; end: number } | null {
  return text.slice(anchor.start, anchor.end) === anchor.quote ? { start: anchor.start, end: anchor.end } : null;
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

/** Content plus the source geometry/typography and renderer format, independent of zoom and of
 * the blocks' ids: an extraction that names the same blocks anew, or rejoins their source text,
 * keeps the page's ink. Blocks and their translations are keyed by the blocks' order, and a
 * formula by what the Korean page draws of it (its region and text), not its source offsets. */
export function translationLayoutSignature(translations: Translation[], blocks:Block[]): string {
  const orderOf = new Map(blocks.map((b) => [b.blockId, b.order]));
  const content = translations.filter((t) => t.status === 'completed' && orderOf.has(t.blockId)).map((t) => [orderOf.get(t.blockId)!, t.text ?? '',t.promptVersion] as const).sort((a, b) => a[0]-b[0]);
  const layout = blocks.map((b) => ({order:b.order,kind:b.kind,regions:b.regions,font:b.fontFamily,weight:b.fontWeight,size:b.fontSize,spans:(b.sourceSpans ?? []).map((span,index) => ({kind:span.kind,regions:span.regions,text:inlineMathText(b,index)}))})).sort((a,b) => a.order-b.order);
  return annotationHash({format:'paperread-ink-layout-3',content,layout});
}

/** Computed font-family still names Pretendard while the browser is drawing its fallback. */
export function loadedFontIdentity(fontFamily:string,fonts:Iterable<FontFace>):string[] {
  const normalize=(value:string)=>value.replace(/['"]/g,'').trim().toLowerCase();
  const families=new Set(fontFamily.split(',').map(normalize));
  return Array.from(fonts).filter((font)=>font.status==='loaded'&&families.has(normalize(font.family))).map((font)=>`${normalize(font.family)}:${font.style}:${font.weight}:${font.stretch}`).sort();
}

/** Actual line break offsets catch font/reflow changes. Coordinate rounding ignores harmless
 * subpixel differences across zooms while content/font/line identities remain exact. The
 * paragraphs are taken in page order, never by their blocks' ids. */
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
    return {breaks,font:style.fontFamily,loadedFonts:loadedFontIdentity(style.fontFamily,document.fonts),weight:style.fontWeight,lineHeight:Math.round(parseFloat(style.lineHeight)/parseFloat(style.fontSize)*100)/100};
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

/** The part of a selection on one Korean page. A selection that crosses pages gives each page
 * its own part, made from the paragraphs of that page it covers. */
export function translatedSelection(container: HTMLElement, page: number, selection: Selection | null): AnnotationInput | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(container)) return null;
  const anchors: TextAnchor[] = [];
  const rects: PixelRect[] = [];
  for (const paragraph of container.querySelectorAll<HTMLElement>(ANNOTATION_TEXT_SELECTOR)) {
    if (!range.intersectsNode(paragraph)) continue;
    const text = paragraph.textContent ?? '';
    const offset = (node: Node, position: number) => {
      const prefix = document.createRange(); prefix.selectNodeContents(paragraph); prefix.setEnd(node, position); return prefix.toString().length;
    };
    const start = paragraph.contains(range.startContainer) ? offset(range.startContainer, range.startOffset) : 0;
    const end = paragraph.contains(range.endContainer) ? offset(range.endContainer, range.endOffset) : text.length;
    if (end <= start) continue;
    const quote = text.slice(start, end);
    if (!quote.trim()) continue;
    const selected = rangeForOffsets(paragraph, start, end);
    if (!selected) continue;
    anchors.push({ blockId: paragraph.dataset.blockId!, start, end, quote, textVersion:2 });
    rects.push(...Array.from(selected.getClientRects()));
    rects.push(...mathRectsInRange(paragraph,selected));
  }
  if (anchors.length === 0) return null;
  const regions = selectionToRegions(rects, container.getBoundingClientRect(), page);
  if (!regions) return null;
  return { page, surface: 'translation', kind: 'highlight', rects: regions, text: excerptOf(proseText(anchors.map((a) => a.quote).join(' '))), anchors };
}

/** Text as one line of prose. pdf.js emits C0 codes for glyphs it cannot map to Unicode (math
 * symbols); prose never holds raw control characters. */
export function proseText(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** The longest text a record keeps. Its rects or anchors mark all of the selection; the text is
 * what the card and the notebook show of it. */
export const EXCERPT_LIMIT = 2000;

/** A record's text: `prose` whole, or when it is longer than a record keeps its start and "…",
 * so it never looks complete when it is not. The cut never splits a character in two. */
export function excerptOf(prose: string): string {
  if (prose.length <= EXCERPT_LIMIT) return prose;
  let end = EXCERPT_LIMIT - 1;
  const last = prose.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${prose.slice(0, end).trimEnd()}…`;
}

/** All the text a selection or record marks, as one line of prose: what a copy or a question
 * takes. On the Korean side the anchors hold every word of it, in document order; a record on
 * the original keeps only its text. */
export function markedText(marks: readonly Pick<AnnotationInput, 'text' | 'anchors'>[]): string {
  return marks.map((mark) => (mark.anchors?.length ? proseText(mark.anchors.map((anchor) => anchor.quote).join(' ')) : mark.text)).join(' ');
}

/** A sweep over the original pages: the records it makes, one per page with its rects as page
 * ratios, and all the text it swept in reading order, for a copy or a question. */
export interface SourceSelection {
  inputs: AnnotationInput[];
  text: string;
}

/** The selection a sweep makes. A page whose size was not measured is left out of both. */
export function sourceSelection(sweeps: PageSweep[], sizeOf: (page: number) => Size | undefined): SourceSelection {
  const inputs: AnnotationInput[] = [];
  const texts: string[] = [];
  for (const { page, rects, text } of sweeps) {
    const size = sizeOf(page);
    if (size === undefined) continue;
    const regions = selectionToRegions(rects, { left: 0, top: 0, width: size.width, height: size.height }, page);
    const prose = proseText(text);
    if (regions === null || prose.length === 0) continue;
    inputs.push({ page, rects: regions, text: excerptOf(prose), surface: 'original', kind: 'highlight' });
    texts.push(prose);
  }
  return { inputs, text: texts.join(' ') };
}

/** As much of a copy event as `copyPaintedSelection` reads. */
export interface CopyEventLike {
  target: unknown;
  clipboardData: Pick<DataTransfer, 'setData'> | null;
  preventDefault(): void;
}

/**
 * A copy (Ctrl+C, or the browser's own command) while the original's painted selection shows
 * takes all of its text: the select tool keeps the browser from selecting there, so the browser
 * has nothing of its own to copy. A copy in a box being typed in or a dialog, or of text the
 * browser itself has selected, is left to the browser.
 */
export function copyPaintedSelection(event: CopyEventLike, text: string, selection: Pick<Selection, 'isCollapsed'> | null): void {
  if (event.clipboardData === null || keepsKeysToItself(event.target) || (selection !== null && !selection.isCollapsed)) return;
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
}

/** Pen thickness as a share of the page width, so a stroke keeps its size against the text at
 * every zoom. The default is the thinnest Edge pen at 100%, about 2.4px on a Letter page. */
export const PEN_WIDTH = { min: 0.002, max: 0.012, step: 0.001, initial: 0.003 } as const;

/** The highlighter's thickness: the share of each marked line's height it paints, up from the
 * line's bottom edge. It starts at the whole line. */
export const HIGHLIGHTER_THICKNESS = { min: 0.2, max: 1, step: 0.1, initial: 1 } as const;

/** One highlighter stroke's records, every page of it in the same colour and thickness. A
 * thickness of the whole line is not stored: the record marks the whole line as one made
 * without one does. */
export function highlighterInputs(inputs: AnnotationInput[], color: Highlight['color'], thickness: number = HIGHLIGHTER_THICKNESS.initial): AnnotationInput[] {
  return inputs.map((input) => ({ ...input, color, ...(thickness < 1 ? { thickness } : {}) }));
}

/** Store a stroke compactly so a long gesture stays inside the HTTP body limit. */
export function inkToAnnotation(points: InkPoint[], page: number, surface: AnnotationSurface, color: Highlight['color'], layoutSignature?: string, width: number = PEN_WIDTH.initial): AnnotationInput | null {
  if (points.length < 2) return null;
  const keep = points.length <= 1200 ? points : Array.from({ length: 1200 }, (_, i) => points[Math.round(i * (points.length - 1) / 1199)]);
  const round = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100000) / 100000;
  const bounded = keep.map((p) => ({ x: round(p.x), y: round(p.y) }));
  // The stored box covers the painted stroke: half its thickness on either side of the line.
  const margin = width / 2;
  const minX = Math.max(0, Math.min(...bounded.map((p) => p.x)) - margin);
  const minY = Math.max(0, Math.min(...bounded.map((p) => p.y)) - margin);
  const maxX = Math.min(1, Math.max(...bounded.map((p) => p.x)) + margin);
  const maxY = Math.min(1, Math.max(...bounded.map((p) => p.y)) + margin);
  return { page, surface, kind: 'ink', text: '필기', color, rects: [{ page, x: minX, y: minY, width: maxX - minX, height: maxY - minY }], strokes: [{ points: bounded, width }], ...(layoutSignature ? { layoutSignature } : {}) };
}
