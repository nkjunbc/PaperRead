import { createHash } from 'node:crypto';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Block, Coverage, Region } from '../../shared/contracts';
import { SourceError } from '../arxiv/index';

export const EXTRACTION_VERSION = 'pdfjs6-lines-v4';
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export interface ExtractionOptions { maxPages?: number; maxBytes?: number }
export interface PdfExtraction { blocks: Block[]; coverage: Coverage; extractionVersion: string }
/** The page-1 heading set in the largest type, offered as a title only when arXiv metadata
 * is missing. A heuristic, so real metadata always wins and nothing here is ever a claim
 * about the paper's authors. */
export function inferTitle(blocks: readonly Block[]): string | null {
  let best: Block | null = null;
  for (const block of blocks) {
    if (block.kind !== 'heading' || block.regions[0]?.page !== 1) continue;
    const text = block.sourceText.replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 300) continue;
    if (best === null || block.fontSize > best.fontSize) best = block;
  }
  return best === null ? null : best.sourceText.replace(/\s+/g, ' ').trim();
}
interface Item { str:string; transform:number[]; width:number; height:number; fontName?:string }
interface Font { ascent?:number; descent?:number; vertical?:boolean; fontFamily?:string }
const clamp = (n:number) => Math.max(0, Math.min(1,n));
/** pdf.js only exposes a coarse generic family here (not the PDF font name); anything that
 * isn't explicitly sans-serif is treated as serif. Coarse, but enough for the impression match. */
const toFontFamily = (family?:string):'serif'|'sans' => family==='sans-serif' ? 'sans' : 'serif';
interface PageLike { commonObjs: { has(id:string):boolean; get(id:string):unknown } }
/** Bold lives on the resolved font object, not on the text item's style entry, and that object
 * is only populated once the page's operator list has been evaluated — the caller must fetch
 * the operator list before reading text content. */
function fontWeightFor(page:PageLike, fontName:string):'normal'|'bold' {
  try {
    if (!page.commonObjs.has(fontName)) return 'normal';
    const font = page.commonObjs.get(fontName) as { bold?: boolean; name?: string } | null;
    if (font?.bold) return 'bold';
    // pdf.js flags only fonts whose descriptor says so; URW and Computer Modern bold faces
    // ("NimbusRomNo9L-Medi", "CMBX10") carry it in the name alone.
    return typeof font?.name === 'string' && /bold|black|heavy|semibold|demibold|-medi\b|cmbx|cmssbx|cmb\d|ptmb|sfbx/i.test(font.name) ? 'bold' : 'normal';
  } catch { return 'normal'; }
}

function rectangle(box:number[], page:number, points:number[][]):Region {
  if (box.length !== 4 || ![...box,...points.flat()].every(Number.isFinite) || box[2]<=box[0] || box[3]<=box[1] || !Number.isInteger(page) || page<1) throw new Error('Invalid PDF geometry');
  const x = clamp((Math.min(...points.map(p=>p[0]))-box[0])/(box[2]-box[0]));
  const right = clamp((Math.max(...points.map(p=>p[0]))-box[0])/(box[2]-box[0]));
  const y = clamp((box[3]-Math.max(...points.map(p=>p[1])))/(box[3]-box[1]));
  const bottom = clamp((box[3]-Math.min(...points.map(p=>p[1])))/(box[3]-box[1]));
  if (right<=x || bottom<=y) throw new Error('Empty PDF geometry');
  return {page,x,y,width:right-x,height:bottom-y};
}
/** A horizontal rule (a table's top, mid or bottom line): wide and hairline-thin. Unlike
 * `rectangle` this tolerates zero height, since a rule drawn as a line has none. */
function thinRule(box:number[], page:number, points:number[][]):Region|null {
  if(box.length!==4 || ![...box,...points.flat()].every(Number.isFinite) || box[2]<=box[0] || box[3]<=box[1]) return null;
  const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
  const x=clamp((Math.min(...xs)-box[0])/(box[2]-box[0])), right=clamp((Math.max(...xs)-box[0])/(box[2]-box[0]));
  const y=clamp((box[3]-Math.max(...ys))/(box[3]-box[1])), bottom=clamp((box[3]-Math.min(...ys))/(box[3]-box[1]));
  if(right-x<.08 || bottom-y>.006) return null;
  return {page,x,y,width:right-x,height:Math.max(bottom-y,.001)};
}
/** PDF.js text transforms are unrotated PDF user-space, not viewport coordinates. */
export function textItemRegion(item:Item, box:number[], page:number, font:Font):Region {
  const [a,b,c,d,e,f] = item.transform;
  const length = Math.hypot(a,b);
  if (!length || ![a,b,c,d,e,f,item.width,item.height].every(Number.isFinite)) throw new Error('Invalid text transform');
  const ascent = font.ascent ?? .85, descent = font.descent ?? -.25;
  const dx = a/length*item.width, dy = b/length*item.width;
  return rectangle(box,page,[[e+c*descent,f+d*descent],[e+c*ascent,f+d*ascent],
    [e+dx+c*descent,f+dy+d*descent],[e+dx+c*ascent,f+dy+d*ascent]]);
}
/** One horizontal run of text. `em` is the run's font size as a fraction of the page width, so
 * every "how far apart" rule below scales with the paper's own type size instead of a fixed
 * page fraction — a column gutter is ~1.5–2em in every common template, a word space ≤ 0.6em. */
interface Line { text:string; region:Region; size:number; baseline:number; uncertain:boolean; pieces:{x:number;text:string}[]; fontFamily:'serif'|'sans'; fontWeight:'normal'|'bold'; fontSize:number; em:number; chars:number; boldChars:number; sizeChars:Record<string,number>; leadX:number; leadBold:boolean; baselineChars:number }
interface Draft { kind:Block['kind']; text:string; regions:Region[]; uncertain:boolean; fontFamily:'serif'|'sans'; fontWeight:'normal'|'bold'; fontSize:number; pageOrdinal:number; chars:number; boldChars:number; sizeChars:Record<string,number> }
/** The body type size (points, to the half point) of the characters counted: the size that sets
 * the most of them, the larger one on a tie ("PE_pos.": three body glyphs, three subscript ones).
 * A footnote reads 9pt beside body text's 10pt, whatever marker it opens with. */
function bodySize(sizeChars:Record<string,number>):number {
  let best=0, most=-1;
  for(const [size,chars] of Object.entries(sizeChars)) if(chars>most || (chars===most && Number(size)>best)) { best=Number(size); most=chars; }
  return best;
}
const mergeSizes=(a:Record<string,number>, b:Record<string,number>)=>{
  const out={...a};
  for(const [size,chars] of Object.entries(b)) out[size]=(out[size]??0)+chars;
  return out;
};
const normalizeText = (s:string) => s.replace(/\s+/g,' ').trim();
function union(regions:Region[]):Region {
  const first=regions[0], x=Math.min(...regions.map(r=>r.x)), y=Math.min(...regions.map(r=>r.y));
  return {page:first.page,x,y,width:Math.max(...regions.map(r=>r.x+r.width))-x,height:Math.max(...regions.map(r=>r.y+r.height))-y};
}
/** Text is always rebuilt from the x-sorted pieces, so a superscript attached later lands where
 * it sits on the page instead of at the end of the line. */
function absorb(host:Line, piece:Line):void {
  host.pieces.push(...piece.pieces);
  host.pieces.sort((a,b)=>a.x-b.x);
  host.text=normalizeText(host.pieces.map(p=>p.text).join(' '));
  host.region=union([host.region,piece.region]);
  host.uncertain ||= piece.uncertain;
  // The line's em and type size follow its running text, so one oversized operator glyph cannot
  // widen the gap the line may bridge into the next column, and a footnote marker ("4", "∗")
  // opening the line does not set the size the whole footnote is judged and rendered by.
  const total=host.chars+piece.chars;
  if(total>0) {
    host.em=(host.em*host.chars+piece.em*piece.chars)/total;
    host.fontSize=(host.fontSize*host.chars+piece.fontSize*piece.chars)/total;
  }
  host.chars=total; host.boldChars+=piece.boldChars;
  host.sizeChars=mergeSizes(host.sizeChars,piece.sizeChars);
  // Whether the line opens in bold is decided by its leftmost run, whatever order it came in.
  if(piece.leadX<host.leadX) { host.leadX=piece.leadX; host.leadBold=piece.leadBold; }
  // The line's baseline is its running text's, not that of a raised radical or big operator
  // that happens to open it; the space between paragraphs is measured baseline to baseline.
  if(piece.baselineChars>host.baselineChars) { host.baseline=piece.baseline; host.baselineChars=piece.baselineChars; }
}
/** A word space in the line's own type size, capped below the narrowest common column gutter.
 * A bold run-in heading ("Evaluation.") is followed by a deliberately wider space. */
const RUN_IN_GAP_EM = 2.5;
const isRunInHeading=(l:Line)=>l.chars>0 && l.boldChars/l.chars>=.8 && /[.:]$/.test(l.text);
const joinGap=(a:Line,b:Line)=>isRunInHeading(a) ? Math.max(a.em,b.em)*RUN_IN_GAP_EM : Math.min(Math.max(a.em,b.em)*SAME_LINE_GAP_EM,.024);
/** Where the two columns of a two-column page meet: the typical right edge of full left-column
 * lines and the typical left edge of right-column lines. Null on a one-column page. */
interface Gutter { left:number; right:number }
const medianOf=(values:number[])=>{ const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)]; };
function gutterOf(lines:Line[]):Gutter|null {
  const leftEnds=lines.filter(l=>l.region.x<.4 && l.region.x+l.region.width<=.52 && l.region.width>.25).map(l=>l.region.x+l.region.width);
  const wideRight=lines.filter(l=>l.region.x>=.48 && l.region.width>.25);
  if(leftEnds.length<4 || wideRight.length<4) return null;
  const left=medianOf(leftEnds);
  // The right column's edge is where its leftmost lines start (a reference list's "[n]"
  // labels, a heading), not where its indented body lines start: take a low percentile.
  const rightStarts=lines.filter(l=>l.region.x>left+.005 && l.region.x<.6).map(l=>l.region.x).sort((a,b)=>a-b);
  const right=rightStarts.find((x,i)=>rightStarts[i+1]!==undefined && rightStarts[i+1]-x<.004);
  return right!==undefined && right>left ? {left,right} : null;
}
/** On a two-column page a closing bracket can sit right at the gutter, closer to the other
 * column's first word than a word space; a piece ending at the left column's edge may not
 * join one starting at the right column's edge unless the two are practically touching. */
const crossesGutter=(a:Line,b:Line,gutter:Gutter|null)=>{
  if(gutter===null || b.region.x<gutter.right-.004 || a.region.x+a.region.width>=gutter.right+.02) return false;
  const apart=b.region.x-(a.region.x+a.region.width)>Math.max(a.em,b.em)*.4;
  // A left-column piece: either a real gap sits between the pieces, or the piece already
  // reaches into the gutter zone — a wide left-column equation poking at the right column.
  if(a.region.x<gutter.left) return apart || a.region.x+a.region.width>=gutter.left;
  // A piece that starts inside the gutter zone is a left-column overhang (a wide equation's
  // closing ")," set past the column edge); it may not bridge a real gap into the right column.
  return a.region.x<gutter.right-.004 && apart;
};
/** Items on one baseline become one line only while the horizontal gap between them is a word
 * space, never a column gutter. The old fixed 3.5%-of-page gap silently glued the two columns
 * of narrow-gutter papers into one full-width line, which then broke every paragraph. */
const SAME_LINE_GAP_EM = 1.2;
function linesFromItems(items:Line[], gutter:Gutter|null=null):Line[] {
  const lines:Line[]=[];
  const sorted=[...items].sort((a,b)=>a.baseline-b.baseline);
  const rows:Line[][]=[];
  for(const item of sorted) {
    const row=rows.at(-1);
    if(row && Math.abs(row[0].baseline-item.baseline)<Math.min(row[0].region.height,item.region.height)*.4) row.push(item);
    else rows.push([item]);
  }
  for(const item of rows.flatMap(row=>row.sort((a,b)=>a.region.x-b.region.x))) {
    const line=lines.findLast(l=>Math.abs(l.baseline-item.baseline)<Math.min(l.region.height,item.region.height)*.4 && item.region.x>=l.region.x-l.em*.2 && item.region.x-(l.region.x+l.region.width)<joinGap(l,item) && !crossesGutter(l,item,gutter));
    if (line) absorb(line,item);
    else lines.push({...item,pieces:[...item.pieces]});
  }
  return lines;
}
/** A radical sign or a large operator is drawn on its own baseline and height; the words after
 * it are then stranded on that glyph's line. A second pass joins lines that overlap vertically
 * and sit a word space apart, whichever baseline each was first grouped on. */
function mergeAdjacentLines(lines:Line[], gutter:Gutter|null=null):Line[] {
  const sorted=[...lines].sort((a,b)=>a.region.x-b.region.x || a.region.y-b.region.y);
  for(let merged=true; merged;) {
    merged=false;
    for(let i=0;i<sorted.length && !merged;i++) {
      for(let j=0;j<sorted.length;j++) {
        if(i===j) continue;
        const a=sorted[i], b=sorted[j];
        const overlap=Math.min(a.region.y+a.region.height,b.region.y+b.region.height)-Math.max(a.region.y,b.region.y);
        if(overlap<Math.min(a.region.height,b.region.height)*.5) continue;
        const gap=b.region.x-(a.region.x+a.region.width);
        if(gap<-Math.max(a.em,b.em)*.2 || gap>=joinGap(a,b) || crossesGutter(a,b,gutter)) continue;
        absorb(a,b); sorted.splice(j,1); merged=true; break;
      }
    }
  }
  return sorted;
}
/** Superscripts, subscripts, hats and affiliation markers are emitted on their own raised or
 * lowered baseline. Left alone they become one-glyph "paragraphs" scattered between the real
 * ones; here each is pulled into the line it visually belongs to. */
const isTiny=(l:Line)=>l.text.replace(/\s/g,'').length<=4 && l.region.width<l.em*3;
function attachFragments(lines:Line[]):Line[] {
  const hosts=lines.filter(l=>!isTiny(l));
  const kept:Line[]=[];
  for(const line of lines) {
    if(!isTiny(line)) { kept.push(line); continue; }
    const cy=line.region.y+line.region.height/2;
    let best:Line|undefined, bestDistance=Infinity;
    for(const host of hosts) {
      if(line.region.x<host.region.x-host.em || line.region.x+line.region.width>host.region.x+host.region.width+host.em) continue;
      if(cy<host.region.y-host.region.height*.25 || cy>host.region.y+host.region.height*1.25) continue;
      const distance=Math.abs(cy-(host.region.y+host.region.height/2));
      if(distance<bestDistance) { best=host; bestDistance=distance; }
    }
    if(best) absorb(best,line);
    else kept.push(line);
  }
  // A lone glyph with no letters or digits (a stray "+" whose base never rendered as text)
  // shows nothing useful even as a crop.
  return kept.filter(l=>!(l.text.replace(/\s/g,'').length<=1 && !/[\p{L}\p{N}]/u.test(l.text)));
}
const wordCount=(text:string)=>text.split(/\s+/).filter(w=>/\p{L}{2,}/u.test(w)).length;
const letterRatio=(text:string)=>{ const solid=text.replace(/\s/g,''); return solid.length ? (solid.match(/\p{L}/gu)?.length??0)/solid.length : 0; };
const MATH_MARKS=/[=∑∫≠≤≥±×÷√∂∇∞→←∈∉⊂⊆∀∃λθαβγδεσμπΣΠΩω^]/u;
const EQUATION_TAG=/\(\d+[a-z]?\)\s*$/;
/** A list item's bullet: itemize's "•" and its nested marks, or a nested "–" item. */
const BULLET=/^(?:[•◦▪▫‣∙●○■□]|–(?=\s))\s*\S/;
/** "(3)" closes a display equation; "Eq. (3)" or "Section (2)" closing a line is prose. */
const hasEquationTag=(text:string)=>EQUATION_TAG.test(text) && !/\b(?:eqs?|equations?|sections?|secs?|figs?|figures?|tables?|refs?)\.?\s*\(\d+[a-z]?\)\s*$/i.test(text);
/** Prose is what a translator can read as a sentence fragment: mostly letters, more than one
 * real word. Everything else on a page — the pieces of a display equation, axis ticks, an
 * equation number — is a fragment, and fragments are kept as original-appearance crops. */
function isProse(line:Line):boolean {
  const words=wordCount(line.text), ratio=letterRatio(line.text);
  return (words>=5 && ratio>=.5) || (words>=3 && ratio>=.6) || (words>=2 && ratio>=.75);
}
/** A short line of letters directly under a prose line, at the same left edge, is that
 * paragraph's last words ("agents."), not a stray fragment. */
function continuesProse(line:Line, previous:Line|undefined, proseWidth=0):boolean {
  if(previous===undefined) return false;
  // A display equation carries its number, or stands much taller than a text line.
  if(hasEquationTag(line.text) || line.region.height>previous.region.height*2.2) return false;
  if(line.region.y-(previous.region.y+previous.region.height)>=previous.region.height*1.2) return false;
  if(Math.abs(line.region.x-previous.region.x)>=.035) return false;
  const text=line.text, words=wordCount(text), ratio=letterRatio(text);
  // A full line packed with inline math ("p_g ≈ 1/k. For 4-choice with G = 16, Eq. (6)") is
  // still a line of its paragraph, even when a radical makes it a little taller: a display
  // equation never fills the measure with words.
  if(proseWidth>0 && line.region.width>=proseWidth*.85 && ratio>=.4 && words>=3) return true;
  if(line.region.height>previous.region.height*1.6) return false;
  // A paragraph's last words: "architectures [38, 24, 15].", "(3.5 days).", "[38, 2, 9].".
  const tail=/\.$/.test(text) && (words>=1 || ratio>=.4 || /^\[[\d,\s]+\]\.$/.test(text) || (/^[a-z]/.test(text) && text.length<=30));
  return ratio>=.75 || words>=2 || tail;
}
/** A wordy display equation ("MultiHead(Q, K, V) = Concat(head_1, ..., head_h) W^O", "where
 * head_i = Attention(...)") reads like prose to the letter-ratio test, but it is set off from
 * the measure and centred. It stays a crop; a translator must not rewrite it. */
function isDisplayMath(line:Line, proseWidth:number, center:number):boolean {
  if(!/[=≈≤≥∑∫∈←→]/u.test(line.text)) return false;
  if(proseWidth>0 && line.region.width>=proseWidth*.9) return false;
  return line.region.x>.05 && Math.abs(line.region.x+line.region.width/2-center)<.08;
}
function isHeading(line:Line, median:number, references:boolean):boolean {
  if(line.size>median*1.25) return true;
  const short=line.text.length<70 && !/,/.test(line.text) && !/[.;]$/.test(line.text);
  // A numbered heading is never set smaller than the body: a footnote also opens with a bare
  // number ("1 We further quantify ..."), but in footnote-sized type.
  if(/^\d+(?:\.\d+)*\s+[A-Z]/.test(line.text) && short && line.size>=median*.95 && wordCount(line.text)<=9) return true;
  // An appendix heading is lettered ("A Proofs", "B.2 Details") and follows the reference list;
  // missing it would leave every appendix page classified as references.
  if(/^(?:appendix\s+)?[A-Z](?:\.\d+)*\s+[A-Z][a-z]/.test(line.text) && short && line.size>=median*.95 && wordCount(line.text)<=9) return true;
  // A lone capitalised word on its own line ("Abstract") is a heading, except inside the
  // reference list, where an entry can end on a bare word and a heading would switch the
  // list off for every entry after it.
  if(!references && /^[A-Z][a-z]{3,}$/.test(line.text)) return true;
  // A bold line is a heading unless it is a run-in heading with its sentence already attached
  // ("Effect on the count. With p_g → 0, ..."), which is the opening line of a paragraph.
  return line.chars>0 && line.boldChars/line.chars>=.8 && wordCount(line.text)<=8 && line.text.length<70 && !/[.,;]$/.test(line.text) && !/\.\s+[A-Z(]/.test(line.text);
}
type LineKind = 'heading'|'caption'|'reference'|'paragraph'|'fragment';
/** Small-caps headings arrive as "R EFERENCES": the first letter is a separate glyph run. */
const isReferencesHeading=(text:string)=>/^(?:r\s?eferences|b\s?ibliography)$/i.test(text.trim());
/** references is the running "are we past the References heading" flag; the caller turns it
 * off the moment a heading line is seen, so this function must recognize a heading before it
 * ever consults that flag. */
/** A caption opens with its label and a separator ("Figure 1:", "Table 2.", "TABLE I"); a body
 * sentence that merely begins "Table 2 reports ..." is a paragraph. */
const CAPTION_START=/^(?:figure|fig\.?|table)\s*(?:\d+|[ivx]+)[a-z]?\s*[:.\u2014\u2013-]/i;
const CAPTION_LABEL_ONLY=/^table\s+[ivx]+$/i;
function classify(line:Line, median:number, references:boolean):LineKind {
  if (CAPTION_START.test(line.text) || CAPTION_LABEL_ONLY.test(line.text)) return 'caption';
  if (isReferencesHeading(line.text)) return 'reference';
  if (isHeading(line,median,references)) return 'heading';
  if (references) return 'reference';
  return isProse(line) ? 'paragraph' : 'fragment';
}
/** How close two graphic fragments (page-fraction units) must be to count as one figure/table.
 * Not derived from any spec: tune against real papers if figures split apart or bleed together. */
const FIGURE_CLUSTER_GAP = .04;
function boxesClose(a:Region, b:Region, gap:number):boolean {
  return a.x < b.x+b.width+gap && b.x < a.x+a.width+gap && a.y < b.y+b.height+gap && b.y < a.y+a.height+gap;
}
/** Groups nearby graphic fragments into one region per visual figure/table, instead of unioning
 * every mark on the page into one box that would span (and crop) the body text between them. */
function clusterFigures(regions:Region[], gap:number):Region[] {
  const groups:Region[][] = regions.map(r=>[r]);
  for(let merged=true; merged;) {
    merged=false;
    for(let i=0;i<groups.length && !merged;i++) {
      for(let j=i+1;j<groups.length;j++) {
        if(boxesClose(union(groups[i]),union(groups[j]),gap)) { groups[i]=groups[i].concat(groups[j]); groups.splice(j,1); merged=true; break; }
      }
    }
  }
  return groups.map(union);
}
const centerInside=(line:Line, box:Region, pad:number)=>{
  const cx=line.region.x+line.region.width/2, cy=line.region.y+line.region.height/2;
  return cx>=box.x-pad && cx<=box.x+box.width+pad && cy>=box.y-pad && cy<=box.y+box.height+pad;
};
/** Horizontal extent of a band's own lines; an empty band (nothing to align against) falls
 * back to the full page width so it never wins a graphic assignment purely by default. */
function bandXRange(band:Line[]):[number,number] {
  if(!band.length) return [0,1];
  return [Math.min(...band.map(l=>l.region.x)), Math.max(...band.map(l=>l.region.x+l.region.width))];
}
function bandYRange(band:Line[]):[number,number] {
  if(!band.length) return [0,1];
  return [Math.min(...band.map(l=>l.region.y)), Math.max(...band.map(l=>l.region.y+l.region.height))];
}
/** Assigns a figure/table region to the column band whose text occupies the same horizontal
 * space, so a right-column graphic lands among the right column's own paragraphs, not the
 * left column's (which would otherwise win purely by being earlier in reading order). */
function assignBandIndex(fig:Region, ranges:[number,number][], yRanges:[number,number][]):number {
  let bestIdx=0, bestDistance=Infinity, bestOverlap=-1;
  for(let i=0;i<ranges.length;i++) {
    const [lo,hi]=ranges[i];
    const overlap=Math.max(0, Math.min(hi,fig.x+fig.width)-Math.max(lo,fig.x));
    const [top,bottom]=yRanges[i];
    const distance=Math.max(top-(fig.y+fig.height),fig.y-bottom,0);
    if(distance<bestDistance || distance===bestDistance && overlap>bestOverlap) {
      bestDistance=distance; bestOverlap=overlap; bestIdx=i;
    }
  }
  if(bestOverlap>0) return bestIdx;
  const center=fig.x+fig.width/2;
  let closestIdx=0, closestDist=Infinity;
  for(let i=0;i<ranges.length;i++) {
    const dist=Math.abs((ranges[i][0]+ranges[i][1])/2-center);
    if(dist<closestDist) { closestDist=dist; closestIdx=i; }
  }
  return closestIdx;
}
/** A line spans both columns only when it clearly crosses the midline on both sides; a wide
 * left-column equation that merely pokes past the middle still belongs to its column. */
const sideOf=(l:Line):'left'|'right'|'full' =>
  l.region.x<.42 && l.region.x+l.region.width>.58 ? 'full' : (l.region.x+l.region.width/2<.5 ? 'left' : 'right');
function layout(lines:Line[]):Line[][] {
  // Require several aligned lines of running prose on both sides; a single indentation isn't
  // a column, and neither are table cells or equation pieces that share a baseline — treating
  // those as columns split every full-width paragraph's short last line into its own block.
  const prose=lines.filter(l=>wordCount(l.text)>=3 && l.region.width>=.2);
  const left=prose.filter(l=>sideOf(l)==='left'), right=prose.filter(l=>sideOf(l)==='right');
  const paired=left.filter(l=>right.some(r=>Math.abs(r.region.y-l.region.y)<.03));
  const sorted=[...lines].sort((a,b)=>a.region.y-b.region.y);
  if(left.length<2 || right.length<2 || paired.length<2) return [sorted];
  // Consecutive full-width lines (title block, a wide caption) share one band, so they can
  // still join into one paragraph; a column run is split into its left and right stacks.
  const bands:Line[][]=[];
  let full:Line[]=[], pending:Line[]=[], adopted:Line[]=[];
  const flushFull=()=>{ if(full.length) { bands.push(full); full=[]; } };
  const flushPending=()=>{ if(pending.length) { bands.push(pending.filter(l=>sideOf(l)==='left'),pending.filter(l=>sideOf(l)==='right')); pending=[]; } };
  // Visual rows top to bottom, each row left to right, so the left half of a split line is
  // always met before its right half.
  const byBaseline=[...lines].sort((a,b)=>a.baseline-b.baseline), ordered:Line[]=[];
  for(let i=0;i<byBaseline.length;) {
    let j=i+1;
    while(j<byBaseline.length && byBaseline[j].baseline-byBaseline[i].baseline<Math.min(byBaseline[i].region.height,byBaseline[j].region.height)*.4) j++;
    ordered.push(...byBaseline.slice(i,j).sort((a,b)=>a.region.x-b.region.x));
    i=j;
  }
  for(const line of ordered) {
    // A full-width block keeps its short last line (a wide caption's tail) and both halves of
    // a line that a wide inline formula split at the gutter: they sit right under a full-width
    // line that runs on, at its left edge, or level with such a piece. Split off, they became
    // one-line "paragraphs" in each column.
    const above=full.at(-1);
    const tail=above!==undefined && pending.length===0 && !/[.!?]$/.test(above.text) && line.region.y>above.region.y
      && Math.abs(line.region.x-above.region.x)<.012 && line.region.y-(above.region.y+above.region.height)<above.region.height*1.2;
    const level=pending.length===0 && adopted.some(a=>Math.abs(a.baseline-line.baseline)<Math.min(a.region.height,line.region.height)*.4);
    if(sideOf(line)==='full') { flushPending(); full.push(line); adopted=[]; }
    else if(tail || level) { full.push(line); adopted.push(line); }
    else { flushFull(); adopted=[]; pending.push(line); }
  }
  flushPending(); flushFull();
  return bands.filter(b=>b.length);
}
interface TableCandidate { lines:Line[]; region:Region }
const isNumericCell=(text:string)=>/\d/.test(text) && letterRatio(text)<.5;
const lowercaseRatio=(text:string)=>{ const solid=text.replace(/\s/g,''); return solid.length ? (solid.match(/\p{Ll}/gu)?.length??0)/solid.length : 0; };
/** A line of running text — long, lowercase, filling half of a box — is never a table cell. */
const isRunningProse=(line:Line, box:Region)=>wordCount(line.text)>=8 && lowercaseRatio(line.text)>=.75 && line.region.width>=box.width*.5;
/**
 * A table is rows of short cells stacked in aligned columns, framed by its rules. Rows are
 * found per column of a two-column page, so the two columns' lines never form one row.
 * The grid then grows to the rules around it (a header sits above a mid-rule), to every
 * line that lands inside, and to the short non-sentence lines hugging it (a header cell, a
 * spanning column label, an author block's last name) — everything the crop must contain.
 * A framed block with only fragments between two rules of one width (an algorithm listing)
 * is kept the same way. A line of running prose inside the box means this is no table.
 */
function findTables(lines:Line[], kindOf:(l:Line)=>LineKind, gutter:Gutter|null, rules:Region[], proseWidth:number):TableCandidate[] {
  const side=(l:Line)=>gutter!==null && l.region.x>=gutter.right-.004 ? 1 : 0;
  const rows:Line[][]=[];
  for(const line of lines) {
    const row=rows.find(r=>Math.abs(r[0].baseline-line.baseline)<.005 && side(r[0])===side(line));
    if(row) row.push(line); else rows.push([line]);
  }
  const cellRows=rows
    .filter(r=>r.length>=2 && r.every(l=>l.region.width<.4) && (r.length>=3 || r.some(l=>isNumericCell(l.text))))
    .map(r=>[...r].sort((a,b)=>a.region.x-b.region.x))
    .sort((a,b)=>a[0].region.y-b[0].region.y);
  const candidates:Line[][][]=[];
  for(const row of cellRows) {
    const previous=candidates.at(-1), last=previous?.at(-1);
    if(previous && last && side(last[0])===side(row[0]) && row[0].region.y-Math.max(...last.map(l=>l.region.y+l.region.height))<.05) previous.push(row);
    else candidates.push([row]);
  }
  // Real grids keep their cells in columns: two consecutive rows share at least two cell
  // edges. Equation pieces from both columns on one baseline never line up that way.
  const edge=(c:Line,d:Line)=>Math.abs(c.region.x-d.region.x)<.02 || Math.abs(c.region.x+c.region.width/2-(d.region.x+d.region.width/2))<.02 || Math.abs(c.region.x+c.region.width-(d.region.x+d.region.width))<.02;
  const aligned=(a:Line[],b:Line[])=>a.filter(c=>b.some(d=>edge(c,d))).length>=2;
  const seeds:{lines:Line[]; region:Region}[]=candidates
    .filter(group=>group.length>=2 && group.some((row,i)=>i>0 && aligned(group[i-1],row)))
    .map(group=>({lines:group.flat(),region:union(group.flat().map(l=>l.region))}));
  // Two rules of one width, a hand's breadth apart, with nothing but fragments and short lines
  // between them, frame a block: an algorithm listing, a boxed example.
  const sortedRules=[...rules].sort((a,b)=>a.y-b.y);
  for(let i=0;i<sortedRules.length;i++) for(let j=i+1;j<sortedRules.length;j++) {
    const top=sortedRules[i], bottom=sortedRules[j];
    const overlap=Math.min(top.x+top.width,bottom.x+bottom.width)-Math.max(top.x,bottom.x);
    if(overlap<Math.min(top.width,bottom.width)*.8) continue;
    const gap=bottom.y-(top.y+top.height);
    if(gap<.015 || gap>.5) continue;
    const box=union([top,bottom]);
    const inside=lines.filter(l=>centerInside(l,box,0));
    if(inside.length<2 || inside.some(l=>isRunningProse(l,box))) continue;
    if(!inside.some(l=>kindOf(l)==='fragment' || /^\d+:/.test(l.text))) continue;
    seeds.push({lines:inside,region:box});
  }
  const wide=Math.max(proseWidth*.6,.3);
  const captionAbove=(line:Line)=>lines.some(c=>c!==line && kindOf(c)==='caption' && line.region.y>c.region.y && line.region.y-(c.region.y+c.region.height)<c.region.height*1.2 && Math.abs(c.region.x-line.region.x)<.035);
  const tables:TableCandidate[]=[];
  for(const seed of seeds) {
    const members=new Set(seed.lines);
    let box=seed.region;
    let table=true;
    for(let grown=true; grown && table;) {
      grown=false;
      for(const rule of rules) {
        const overlap=Math.min(rule.x+rule.width,box.x+box.width)-Math.max(rule.x,box.x);
        if(overlap<Math.min(rule.width,box.width)*.6 || rule.y<box.y-.035 || rule.y>box.y+box.height+.035) continue;
        const next=union([box,rule]);
        if(next.y<box.y-1e-6 || next.y+next.height>box.y+box.height+1e-6 || next.x<box.x-1e-6 || next.x+next.width>box.x+box.width+1e-6) { box=next; grown=true; }
      }
      for(const line of lines) {
        if(members.has(line)) continue;
        const kind=kindOf(line);
        if(kind==='caption' || kind==='reference') continue;
        const inside=centerInside(line,box,0);
        const cx=line.region.x+line.region.width/2;
        const gapY=Math.max(box.y-(line.region.y+line.region.height),line.region.y-(box.y+box.height),0);
        const hugging=!inside && cx>=box.x-.02 && cx<=box.x+box.width+.02 && gapY<=line.region.height*2.2
          && !/[.!?]$/.test(line.text) && line.region.width<wide && (kind!=='heading' || (!/^\d/.test(line.text) && wordCount(line.text)<=3 && line.region.width<.3)) && !captionAbove(line);
        if(!inside && !hugging) continue;
        if(inside && isRunningProse(line,box)) { table=false; break; }
        members.add(line); box=union([box,line.region]); grown=true;
      }
    }
    if(table) tables.push({lines:[...members],region:box});
  }
  // The two halves of a full-width table on a two-column page grew to the same rules, and a
  // framed seed overlaps the grid it frames: merge every pair of candidates whose boxes touch.
  for(let merged=true; merged;) {
    merged=false;
    for(let i=0;i<tables.length && !merged;i++) for(let j=i+1;j<tables.length;j++) {
      if(!boxesClose(tables[i].region,tables[j].region,.01)) continue;
      tables[i]={lines:[...new Set([...tables[i].lines,...tables[j].lines])],region:union([tables[i].region,tables[j].region])};
      tables.splice(j,1); merged=true; break;
    }
  }
  return tables;
}

/** Parse as inert data only. Never request annotations/actions/attachments or run PDF JS. */
export async function extractPdf(bytes:Uint8Array, paperKey:string, options:ExtractionOptions={}):Promise<PdfExtraction> {
  const maxPages=options.maxPages??300, maxBytes=options.maxBytes??50*1024*1024;
  if(!Number.isInteger(maxPages)||maxPages<1||!Number.isSafeInteger(maxBytes)||maxBytes<1) throw new SourceError('INVALID_INPUT','PDF 제한 설정이 올바르지 않습니다.');
  if(bytes.byteLength>maxBytes) throw new SourceError('TOO_LARGE','PDF 크기 제한을 초과했습니다.');
  if(!/^%PDF-\d\.\d/.test(Buffer.from(bytes.subarray(0,8)).toString('ascii'))) throw new SourceError('UNSUPPORTED_PDF','PDF가 아닌 응답입니다.',false,'NOT_PDF');
  if(!/%%EOF\s*$/.test(Buffer.from(bytes.subarray(Math.max(0,bytes.length-1024))).toString('ascii'))) throw new SourceError('UNSUPPORTED_PDF','PDF 파일이 손상되었거나 불완전합니다.',false,'DAMAGED_PDF');
  const task=getDocument({data:new Uint8Array(bytes), useSystemFonts:true, disableFontFace:true, stopAtErrors:true, verbosity:0, maxImageSize:16_000_000, isOffscreenCanvasSupported:false});
  try {
    const doc=await task.promise;
    if(doc.numPages>maxPages) throw new SourceError('TOO_LARGE','PDF 페이지 제한을 초과했습니다.');
    const drafts:Draft[]=[]; const unsupportedPages:number[]=[]; let textPages=0, references=false;
    for(let pageNum=1;pageNum<=doc.numPages;pageNum++) {
      const full:Region={page:pageNum,x:0,y:0,width:1,height:1};
      const page=await doc.getPage(pageNum);
      let ordinal=0;
      const push=(draft:Draft)=>{ drafts.push(draft); };
      const crop=(kind:'figure'|'table'|'equation'|'unsupported', region:Region, text=''):Draft=>({kind,text,regions:[region],uncertain:true,fontFamily:'serif',fontWeight:'normal',fontSize:0,pageOrdinal:ordinal++,chars:0,boldChars:0,sizeChars:{}});
      try {
        // Fetching the operator list first populates page.commonObjs with resolved font
        // objects (bold, etc.); getTextContent's per-item styles never carry that.
        const operators=await page.getOperatorList();
        const content=await page.getTextContent();
        const pageHeight=page.view[3]-page.view[1], pageWidth=page.view[2]-page.view[0];
        const raw:Line[]=[]; let failed=false;
        for(const item of content.items) {
          if(!('str' in item)||!item.str.trim()) continue;
          const [a,b,c,d]=item.transform;
          // Rotated text (the arXiv margin stamp, watermarks) is never article prose; keeping it
          // put a huge sideways "heading" in the middle of every first page.
          if(Math.abs(b)>Math.abs(a)*.02 || Math.abs(c)>Math.abs(d)*.02) continue;
          try {
            const font=content.styles[item.fontName] ?? {};
            const region=textItemRegion(item,page.view,pageNum,font);
            const text=item.str, solid=text.replace(/\s/g,'').length, bold=fontWeightFor(page,item.fontName);
            raw.push({
              text,pieces:[{x:region.x,text}],region,size:item.height,
              baseline:(page.view[3]-item.transform[5])/(page.view[3]-page.view[1]),
              uncertain:!!font.vertical || font.ascent===undefined || /[\uFFFD\u0000]/u.test(text),
              fontFamily:toFontFamily(font.fontFamily), fontWeight:bold,
              fontSize:pageHeight>0 ? clamp(item.height/pageHeight) : 0,
              em:pageWidth>0 ? item.height/pageWidth : .016, chars:solid, boldChars:bold==='bold'?solid:0,
              sizeChars:{[String(Math.round(item.height*2)/2)]:solid},
              leadX:region.x, leadBold:bold==='bold', baselineChars:solid,
            });
          } catch { failed=true; }
        }
        if(!raw.length) { unsupportedPages.push(pageNum); push(crop('unsupported',full)); continue; }
        textPages++;
        // A narrow 4% margin avoids swallowing first/last body lines on normal papers.
        const inMargins=(l:Line)=>l.region.y>=.04 && l.region.y+l.region.height<=.96;
        const gutter=gutterOf(linesFromItems(raw).filter(inMargins));
        const lines=attachFragments(mergeAdjacentLines(linesFromItems(raw,gutter).filter(inMargins),gutter));
        // The body size is the character-weighted median of the page's sentence-like lines: a
        // page of small-print table cells or figure labels must not make its own reference
        // entries look like oversized headings.
        const sentenceLike=lines.filter(l=>wordCount(l.text)>=3);
        const weighted=(sentenceLike.length>=5 ? sentenceLike : lines).flatMap(l=>Array<number>(Math.max(1,Math.min(200,l.chars))).fill(l.size)).sort((a,b)=>a-b), median=weighted[Math.floor(weighted.length/2)]??12;
        // Where the reference list starts and ends on this page is decided once, in reading
        // order, so every pass below sees the same answer. Otherwise the pass that sorts lines
        // into prose and crops still believes an appendix page is references while the pass
        // that builds blocks has already passed the appendix heading.
        const refsAt=new Map<Line,boolean>();
        {
          let flag:boolean=references;
          for(const band of layout(lines)) for(const line of [...band].sort((a,b)=>a.region.y-b.region.y)) {
            refsAt.set(line,flag);
            if(classify(line,median,flag)==='heading') flag=false;
            if(isReferencesHeading(line.text)) flag=true;
          }
          references=flag;
        }
        const kindOf=(l:Line):LineKind=>classify(l,median,refsAt.get(l)??references);
        // Preserve non-text marks conservatively; vector drawings may be tables or equations.
        const graphicRegions:Region[]=[]; const ruleRegions:Region[]=[];
        let matrix=[1,0,0,1,0,0]; const stack:number[][]=[];
        const point=(x:number,y:number)=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
        for(let i=0;i<operators.fnArray.length;i++) {
          const op=operators.fnArray[i], args=operators.argsArray[i];
          if(op===OPS.save) stack.push([...matrix]);
          else if(op===OPS.restore) matrix=stack.pop()??[1,0,0,1,0,0];
          else if(op===OPS.transform) {const [a,b,c,d,e,f]=args, m=matrix; matrix=[m[0]*a+m[2]*b,m[1]*a+m[3]*b,m[0]*c+m[2]*d,m[1]*c+m[3]*d,m[0]*e+m[2]*f+m[4],m[1]*e+m[3]*f+m[5]];}
          else {
            let bounds:number[]|undefined;
            if(op===OPS.constructPath && args[2]?.length===4) bounds=Array.from(args[2]);
            if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op)) bounds=[0,0,1,1];
            if(bounds) {
              const [x,y,r,b]=bounds, rule=thinRule(page.view,pageNum,[point(x,y),point(x,b),point(r,y),point(r,b)]);
              if(rule) ruleRegions.push(rule);
            }
            if(bounds) try {
              const [x,y,r,b]=bounds, region=rectangle(page.view,pageNum,[point(x,y),point(x,b),point(r,y),point(r,b)]);
              // A page-sized rectangle is a background fill, not a figure.
              if(region.width>.03&&region.height>.02&&region.width*region.height<.6) graphicRegions.push(region);
            } catch { /* hairline rules are not paragraph regions */ }
          }
        }
        // Cluster nearby marks into one region per visual figure/table. Text inside a figure
        // (axis ticks, legend labels) is part of the picture: the crop already shows it, so it
        // must not also surface as stray prose. A frame that encloses real paragraphs is not
        // a figure at all — those paragraphs stay text and the frame is dropped.
        // Table cells are found on the whole page first and kept out of the column inference:
        // a full-width grid's cells would otherwise read as paired left/right column lines.
        const pageProseWidth=Math.max(0,...lines.filter(l=>kindOf(l)==='paragraph').map(l=>l.region.width));
        const tableCandidates=findTables(lines,kindOf,gutter,ruleRegions,pageProseWidth);
        const tableLines=new Set(tableCandidates.flatMap(t=>t.lines));
        const free=lines.filter(l=>!tableLines.has(l));
        const figureClusters:Region[]=[]; const absorbed=new Set<Line>();
        for(const cluster of clusterFigures(graphicRegions,FIGURE_CLUSTER_GAP)) {
          const inside=free.filter(l=>centerInside(l,cluster,0));
          if(inside.filter(l=>wordCount(l.text)>=5).length>=3) continue;
          const mine=new Set<Line>(inside);
          for(const l of free) if(!absorbed.has(l) && kindOf(l)==='fragment' && !/[.!?]$/.test(l.text) && centerInside(l,cluster,l.region.height*1.5)) mine.add(l);
          // A sub-figure's title sits just above its drawing ("Scaled Dot-Product Attention"): a
          // short, unpunctuated line centred over the cluster is part of the picture, not prose.
          for(const l of free) {
            if(absorbed.has(l) || mine.has(l) || kindOf(l)==='heading' || kindOf(l)==='caption') continue;
            const cx=l.region.x+l.region.width/2, bottom=l.region.y+l.region.height;
            if(cx>=cluster.x && cx<=cluster.x+cluster.width && bottom<=cluster.y+l.region.height*.5 && cluster.y-bottom<l.region.height*1.6
              && wordCount(l.text)<=6 && l.region.width<Math.max(cluster.width*1.6,.2) && !/[.!?:,;]$/.test(l.text)) mine.add(l);
          }
          for(const l of mine) absorbed.add(l);
          // The crop shows every label it took out of the text flow, even one hanging just outside
          // the drawing; otherwise that label would vanish from the Korean page altogether.
          figureClusters.push(union([cluster,...[...mine].map(l=>l.region)]));
        }
        const bands=layout(free.filter(l=>!absorbed.has(l)));
        const bandRanges=bands.map(bandXRange);
        const bandYRanges=bands.map(bandYRange);
        // A table's border is emitted as a graphic by PDF.js. Absorb every nearby graphic
        // cluster into its table crop before assigning figures, so it cannot be emitted twice.
        const tables=tableCandidates.map(t=>t.region);
        const tableGraphicIndexes=new Set<number>();
        for(let ti=0;ti<tables.length;ti++) {
          for(let merged=true;merged;) {
            merged=false;
            for(let fi=0;fi<figureClusters.length;fi++) {
              if(tableGraphicIndexes.has(fi) || !boxesClose(tables[ti],figureClusters[fi],FIGURE_CLUSTER_GAP)) continue;
              tables[ti]=union([tables[ti],figureClusters[fi]]);
              tableGraphicIndexes.add(fi);
              merged=true;
            }
          }
        }
        const figuresByBand:Region[][]=bands.map(()=>[]);
        for(let fi=0;fi<figureClusters.length;fi++) {
          if(tableGraphicIndexes.has(fi)) continue;
          const fig=figureClusters[fi];
          figuresByBand[assignBandIndex(fig,bandRanges,bandYRanges)].push(fig);
        }
        const tablesByBand:Region[][]=bands.map(()=>[]);
        for(const table of tables) {
          tablesByBand[assignBandIndex(table,bandRanges,bandYRanges)].push(table);
        }
        for(let bi=0;bi<bands.length;bi++) {
          const band=bands[bi];
          const proseWidth=Math.max(0,...band.filter(l=>kindOf(l)==='paragraph').map(l=>l.region.width));
          type Entry = {y:number; line?:Line; figure?:Region; table?:Region; cluster?:Line[]};
          const entries:Entry[]=[
            ...figuresByBand[bi].map((figure):Entry=>({y:figure.y,figure})),
            ...tablesByBand[bi].map((table):Entry=>({y:table.y,table})),
          ];
          // The pieces of a display equation (numerator, denominator, limits, its number) are
          // separate lines; consecutive fragment lines become one equation crop, so the whole
          // equation appears once, intact, instead of as a scatter of one-symbol crops.
          const textLines=[...band].sort((a,b)=>a.region.y-b.region.y);
          const gapLimit=Math.max(.02,(median/pageHeight)*1.5);
          const bandCenter=(bandRanges[bi][0]+bandRanges[bi][1])/2;
          const clusters:Line[][]=[]; const prose:Line[]=[];
          let previousProse:Line|undefined;
          // Pieces of one visual line that a drawn glyph (a radical, a big operator) kept apart
          // are judged together: "|Â+| =" and "15 ≈ 3.87. By Eq. (6), the expected" make one
          // line of prose, though neither piece does on its own.
          // A piece raised by an accent ("ˆ + = 1 and Â − =") sorts above the start of its own line
          // ("SIGNBALANCE sets A"), so a piece may join its row on either side.
          const visual:Line[][]=[];
          for(const line of textLines) {
            const group=visual.find(g=>g.some(t=>{
              const overlap=Math.min(t.region.y+t.region.height,line.region.y+line.region.height)-Math.max(t.region.y,line.region.y);
              if(overlap<Math.min(t.region.height,line.region.height)*.5) return false;
              const gap=line.region.x>=t.region.x ? line.region.x-(t.region.x+t.region.width) : t.region.x-(line.region.x+line.region.width);
              return gap<Math.max(t.em,line.em)*2.5;
            }));
            if(group) group.push(line); else visual.push([line]);
          }
          const asOne=(group:Line[]):Line=>{
            if(group.length===1) return group[0];
            const pieces=[...group].sort((a,b)=>a.region.x-b.region.x);
            const chars=pieces.reduce((n,l)=>n+l.chars,0);
            return {...pieces[0],text:normalizeText(pieces.map(l=>l.text).join(' ')),region:union(pieces.map(l=>l.region)),chars,boldChars:pieces.reduce((n,l)=>n+l.boldChars,0),em:chars>0?pieces.reduce((n,l)=>n+l.em*l.chars,0)/chars:pieces[0].em,uncertain:pieces.some(l=>l.uncertain),pieces:pieces.flatMap(l=>l.pieces),sizeChars:pieces.reduce((m,l)=>mergeSizes(m,l.sizeChars),{} as Record<string,number>)};
          };
          // The pieces of one visual line are read left to right, whichever of them sits higher.
          const rowOf=new Map<Line,number>();
          for(const group of visual) {
            const whole=asOne(group);
            for(const piece of group) rowOf.set(piece,whole.region.y);
            let kind=classify(whole,median,refsAt.get(group[0])??references);
            if(kind==='paragraph' && isDisplayMath(whole,proseWidth,bandCenter)) kind='fragment';
            // A line that fills the measure with words is running text even when inline math makes
            // it look like a formula ("SIGNBALANCE sets Â+ = 1 and Â− = −sg[n+/n−] on top of ...").
            if(kind==='fragment' && proseWidth>0 && whole.region.width>=proseWidth*.9 && letterRatio(whole.text)>=.45 && wordCount(whole.text)>=4 && !hasEquationTag(whole.text)) kind='paragraph';
            if(kind!=='fragment' || continuesProse(whole,previousProse,proseWidth)) {
              prose.push(...group);
              previousProse=kind==='paragraph' || kind==='fragment' || kind==='reference' || kind==='caption' ? whole : undefined;
              continue;
            }
            const open=clusters.at(-1);
            const bottom=open ? Math.max(...open.map(l=>l.region.y+l.region.height)) : -Infinity;
            if(open && whole.region.y-bottom<=gapLimit && previousProse===undefined) open.push(...group); else clusters.push([...group]);
            previousProse=undefined;
          }
          // A short run of words level with an equation ("is the per-" beside a fraction) is
          // part of that equation's line, not a paragraph of its own.
          const clusterBox=(c:Line[])=>union(c.map(l=>l.region));
          for(let i=prose.length-1;i>=0;i--) {
            const line=prose[i], cy=line.region.y+line.region.height/2;
            if(line.region.width>=proseWidth*.6 || (kindOf(line)!=='paragraph' && kindOf(line)!=='fragment')) continue;
            // Level with the equation, or an underbrace label ("| {z }") hanging just below it.
            const host=clusters.find(c=>{ const box=clusterBox(c); return (cy>=box.y-line.region.height*.25 && cy<=box.y+box.height+line.region.height*.25) || (/[{}]/.test(line.text) && line.region.y>=box.y && line.region.y-(box.y+box.height)<line.region.height*1.5); });
            if(host) { host.push(line); prose.splice(i,1); }
          }
          clusters.sort((a,b)=>clusterBox(a).y-clusterBox(b).y);
          for(let i=1;i<clusters.length;i++) {
            const above=clusterBox(clusters[i-1]), below=clusterBox(clusters[i]);
            const between=prose.some(l=>{ const cy=l.region.y+l.region.height/2; return cy>above.y+above.height && cy<below.y; });
            if(below.y-(above.y+above.height)<=gapLimit && !between) { clusters[i-1].push(...clusters[i]); clusters.splice(i--,1); }
          }
          // Paragraphs set apart by vertical space instead of an indent (NeurIPS, ICLR) are told
          // apart by baseline pitch: the lines of one paragraph share the band's common pitch,
          // and the space between two paragraphs adds a clear extra step on top of it.
          const pitches:number[]=[];
          {
            const body=prose.filter(l=>kindOf(l)==='paragraph').sort((a,b)=>a.baseline-b.baseline);
            for(let i=1;i<body.length;i++) {
              const a=body[i-1], b=body[i], pitch=b.baseline-a.baseline;
              if(pitch>Math.min(a.region.height,b.region.height)*.5 && pitch<Math.max(a.region.height,b.region.height)*2.5 && Math.abs(b.region.x-a.region.x)<.035) pitches.push(pitch);
            }
            pitches.sort((a,b)=>a-b);
          }
          const commonPitch=pitches.length>=4 ? pitches[Math.floor(pitches.length*.4)] : NaN;
          for(const line of prose) entries.push({y:rowOf.get(line)??line.region.y,line});
          for(const cluster of clusters) entries.push({y:clusterBox(cluster).y,cluster});
          entries.sort((a,b)=>a.y-b.y || (a.line?.region.x??0)-(b.line?.region.x??0));
          let current:Draft|undefined, last:Line|undefined;
          for(const entry of entries) {
            if(entry.figure || entry.table || entry.cluster) {
              // A crop interrupts whatever paragraph/reference run was in progress; the
              // next line after it must start a fresh block, not silently rejoin across it.
              if(entry.figure) push(crop('figure',entry.figure));
              else if(entry.table) push(crop('table',entry.table));
              else {
                const text=normalizeText(entry.cluster!.map(l=>l.text).join(' '));
                push(crop(MATH_MARKS.test(text)||EQUATION_TAG.test(text)||/\d/.test(text) ? 'equation' : 'unsupported', union(entry.cluster!.map(l=>l.region)), text));
              }
              current=undefined; last=undefined;
              continue;
            }
            const line=entry.line!;
            const lineKind=kindOf(line);
            let kind:Block['kind']=lineKind==='fragment' ? 'paragraph' : lineKind;
            // The block's own left edge, not the previous line's start: a run-in heading
            // ("Evaluation.") followed by a wide space splits one visual line in two pieces.
            const blockLeft=current ? Math.min(...current.regions.map(r=>r.x)) : NaN;
            const sameVisualLine=last!==undefined && Math.min(line.region.y+line.region.height,last.region.y+last.region.height)-Math.max(line.region.y,last.region.y)>Math.min(line.region.height,last.region.height)*.5 && line.region.x-(last.region.x+last.region.width)<line.em*2;
            // A centred paragraph (a licence notice, a dedication) has no shared left edge; its
            // lines share the band's centre instead.
            const centred=(r:Region)=>Math.abs(r.x+r.width/2-bandCenter)<.03;
            const centredPair=last!==undefined && centred(line.region) && centred(last.region) && line.region.width<proseWidth*.9;
            const near=last!==undefined && (sameVisualLine || (line.region.y-(last.region.y+last.region.height)<last.region.height*1.2 && (Math.abs(line.region.x-blockLeft)<.035 || centredPair)));
            // A list item opens at its bullet and its later lines hang under the item's text; that
            // hanging indent is not a new paragraph, and the next bullet is always a new item.
            const startsItem=BULLET.test(line.text) && !sameVisualLine;
            const inItem=current!==undefined && BULLET.test(current.text);
            const hanging=inItem && !startsItem && line.region.x>blockLeft+line.em*.3;
            const leavesItem=inItem && !startsItem && !hanging && !sameVisualLine;
            // An indented first line after a short last line opens a new paragraph.
            const indented=last!==undefined && !sameVisualLine && !centredPair && !hanging && kind==='paragraph' && line.region.x-blockLeft>line.em*.6 && last.region.width<proseWidth*.9;
            // So does a clearly larger step than the band's common baseline pitch after a line that
            // stops short of the measure: the space between two unindented paragraphs. A line with
            // tall inline math also widens the pitch a little, but inside a justified paragraph.
            // Smaller type is another block: a footnote set right under the last body line joined
            // that paragraph (and was translated as part of it). The block's size is settled over
            // everything it holds so far, so a small-caps name opening it does not set it.
            const size=bodySize(line.sizeChars), blockSize=current===undefined ? 0 : bodySize(current.sizeChars);
            // A bold run-in heading at the margin ("Multi-turn search agents. Consider ...") after a
            // line that closed its sentence short of the justified measure opens a paragraph,
            // indent or not.
            const runIn=last!==undefined && !sameVisualLine && line.leadBold && line.boldChars<line.chars
              && /[.!?]$/.test(last.text) && last.region.width<proseWidth*.97;
            // A short tail ("PE_pos.", "[38, 24, 15].") has too few glyphs to tell its size by.
            const resized=current!==undefined && !sameVisualLine && line.chars>=12 && blockSize>0 && size>0 && size<blockSize*.93;
            const pitch=last===undefined ? 0 : line.baseline-last.baseline;
            const spaced=last!==undefined && !sameVisualLine && Number.isFinite(commonPitch) && pitch>commonPitch*1.3 && (last.region.width<proseWidth*.95 || pitch>commonPitch*1.45);
            // A caption's later lines no longer start with "Figure"; they continue the caption —
            // even after the reference list, where a stray line would otherwise read as an entry.
            if((kind==='paragraph' || kind==='reference') && current?.kind==='caption' && near && !indented && !spaced && !resized) kind='caption';
            // A heading that wraps ("C Justification of the MATH-7.5K / answer-shape categorization")
            // continues on a short lowercase line right under it, slightly indented or not.
            const headingContinues=current!==undefined && current.kind==='heading' && (kind==='paragraph' || kind==='heading') && last!==undefined && !sameVisualLine
              && line.region.y-(last.region.y+last.region.height)<last.region.height*1.2 && Math.abs(line.region.x-blockLeft)<.08
              && /^[a-z]/.test(line.text) && (proseWidth===0 || line.region.width<proseWidth*.7 || lineKind==='heading')
              // "A Open-answer mathematical reasoning:" wraps onto a bold "the small-spurious-advantage case".
              && (!/[.:;]$/.test(current.text) || (lineKind==='heading' && /:$/.test(current.text)));
            if(headingContinues) kind='heading';
            // A bold line that turned out to be a run-in heading — its sentence resumes on the next
            // line in lowercase ("evaluation. For a GRPO run ...") — opens a paragraph instead.
            if(current!==undefined && current.kind==='heading' && kind==='paragraph' && !headingContinues && near && /^[a-z]/.test(line.text) && !/[.:;?!]$/.test(current.text)) {
              current.kind='paragraph';
            }
            // A reference entry starts at its label ("[12]") or where the hanging indent returns to
            // the margin; the References heading itself never joins the first entry.
            const newEntry=kind==='reference' && last!==undefined && (/^\[\d+\]/.test(line.text) || line.region.x<last.region.x-line.em*.6 || (current!==undefined && isReferencesHeading(current.text)));
            const canJoin=current && current.kind===kind && (['paragraph','reference','caption'].includes(kind) || headingContinues) && (near || headingContinues) && (!indented || headingContinues) && !newEntry && !(spaced && (kind==='paragraph' || kind==='caption')) && !startsItem && !leavesItem && !resized && !runIn;
            if(canJoin) {current!.text=normalizeText(current!.text+' '+line.text);current!.regions.push(line.region);current!.uncertain ||= line.uncertain;current!.chars+=line.chars;current!.boldChars+=line.boldChars;current!.sizeChars=mergeSizes(current!.sizeChars,line.sizeChars);}
            else {
              // Multi-line paragraphs need one representative font impression. Face and size come
              // from the opening line; weight is settled over the whole block at the end, since a
              // bold run-in heading ("Encoder:") must not make its paragraph bold.
              current={kind,text:normalizeText(line.text),regions:[line.region],uncertain:line.uncertain,fontFamily:line.fontFamily,fontWeight:line.fontWeight,fontSize:line.fontSize,pageOrdinal:ordinal++,chars:line.chars,boldChars:line.boldChars,sizeChars:line.sizeChars};
              push(current);
            }
            last=line;
          }
        }
        // An item with unusable geometry is skipped; only a page with no readable line at all
        // is recorded as unsupported (a full-page crop beside real paragraphs is not a fallback).
        if(!lines.length) {unsupportedPages.push(pageNum);push(crop('unsupported',full));}
        else if(failed && !unsupportedPages.includes(pageNum)) { /* partial geometry loss: the readable lines stand on their own */ }
      } catch { if(!unsupportedPages.includes(pageNum)) unsupportedPages.push(pageNum); push(crop('unsupported',full)); }
      finally { page.cleanup(); }
    }
    // Repeated near-edge text and standalone folios are not article prose.
    const edge=(d:Draft)=>d.regions.every(r=>r.y<.12 || r.y>.88);
    const recurring=new Map<string,Set<number>>();
    for(const d of drafts) if(edge(d)&&d.text) {
      const key=d.text.replace(/\d+/g,'#');
      const pages=recurring.get(key)??new Set<number>();pages.add(d.regions[0].page);recurring.set(key,pages);
    }
    for(let i=drafts.length-1;i>=0;i--) {
      const d=drafts[i];
      if(edge(d) && (/^\d+$/.test(d.text) || (recurring.get(d.text.replace(/\d+/g,'#'))?.size??0)>=2)) drafts.splice(i,1);
    }
    // A paragraph that runs off the end of a column continues at the top of the next column or
    // page, past whatever the layout set in between: a float (figure, table, their caption) or
    // a footnote in smaller type. Only a sentence visibly left open that resumes in lowercase is
    // joined — never claim more certainty than that — and the paragraph keeps the page and
    // ordinal it started on. Split, each half reached the translator as a broken sentence.
    const isFloat=(d:Draft)=>d.kind==='figure' || d.kind==='table' || d.kind==='caption';
    for(let i=0;i<drafts.length;i++) {
      const prev=drafts[i];
      if(prev.kind!=='paragraph' || /[.!?:]$/.test(prev.text)) continue;
      const a=prev.regions.at(-1)!;
      const footnote=(d:Draft)=>d.kind==='paragraph' && bodySize(d.sizeChars)>0 && bodySize(d.sizeChars)<bodySize(prev.sizeChars)*.93 && d.regions[0].page===a.page && d.regions[0].y>a.y;
      let j=i+1;
      while(j<drafts.length && (isFloat(drafts[j]) || footnote(drafts[j]))) j++;
      const next=drafts[j];
      if(next===undefined || next.kind!=='paragraph' || !/^[a-z]/.test(next.text)) continue;
      const b=next.regions[0];
      // The next page, or the next column of this page: it starts well to the right, higher up.
      if(b.page!==a.page+1 && !(b.page===a.page && b.x-a.x>.25 && b.y<a.y)) continue;
      prev.text=normalizeText(prev.text+' '+next.text); prev.regions.push(...next.regions); prev.uncertain=true;
      prev.chars+=next.chars; prev.boldChars+=next.boldChars; prev.sizeChars=mergeSizes(prev.sizeChars,next.sizeChars);
      drafts.splice(j,1); i--;
    }
    const blocks=drafts.map((d,order):Block=>({blockId:sha256(`${paperKey}:${EXTRACTION_VERSION}:${order}:${d.text}`).slice(0,32),paperKey,order,kind:d.kind,sourceText:d.text,sourceHash:sha256(d.text),regions:d.regions,alignment:d.uncertain?'uncertain':'exact',translatable:['paragraph','heading','caption'].includes(d.kind)&&!!d.text,fontFamily:d.fontFamily,fontWeight:d.chars>0 ? (d.boldChars/d.chars>=.5 ? 'bold' : 'normal') : d.fontWeight,fontSize:d.fontSize,pageOrdinal:d.pageOrdinal}));
    return {blocks,coverage:{totalPages:doc.numPages,textPages,unsupportedPages},extractionVersion:EXTRACTION_VERSION};
  } catch(error) {
    if(error instanceof SourceError) throw error;
    throw new SourceError('UNSUPPORTED_PDF','PDF 파일을 안전하게 해석할 수 없습니다.',false,'DAMAGED_PDF');
  } finally { await task.destroy(); }
}
