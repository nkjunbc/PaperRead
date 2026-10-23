import type { Region, SourceSpan } from '../../shared/contracts';

export interface SourcePiece { x:number; text:string; region:Region; bold:boolean; math:boolean; em:number }
const clean = (text:string) => text.replace(/\s+/g, ' ').trim();
export const union = (regions:Region[]):Region => {
  const x=Math.min(...regions.map(r=>r.x)),y=Math.min(...regions.map(r=>r.y));
  return {page:regions[0].page,x,y,width:Math.max(...regions.map(r=>r.x+r.width))-x,height:Math.max(...regions.map(r=>r.y+r.height))-y};
};
/** Explicit mathematical fonts only. An ordinary italic prose face is not evidence of math. */
export function mathematicalFont(name:unknown):boolean {
  return typeof name==='string' && /(?:^|[+_-])(?:cmmi\d*|cmsy\d*|cmex\d*|msam\d*|msbm\d*|cmmib\d*|mtmi|mtsy|mtex|symbol|stix.*math|latinmodernmath)(?:$|[-_])/i.test(name);
}
/** Short non-word runs beside a proved mathematical run can be scripts/operators in that
 * same formula. Never absorb prose simply because it was set in an italic face. */
function mathNeighbour(text:string):boolean {
  const value=clean(text);
  // Two-letter prose (We, as, if, or, ...) is not proof of a mathematical run.
  // A measured mathematical font can still own multi-letter identifiers itself.
  // Spacing accents (hat, tilde, bar, dot, umlaut, caron) come from a roman face but sit on a variable.
  return value.length>0 && value.length<=32 && !/[A-Za-z]{2}/.test(value) && /^[0-9A-Za-z\s()[\]{}=+−\-*/.,:<>|!^_%ˆ˜¯˙¨ˇ]+$/.test(value);
}

/** Offsets are into the same x-ordered, whitespace-normalized text used by the line parser.
 * Formula appearance comes from its observed PDF region; no TeX is inferred here. */
export function sourceSpansForPieces(pieces:readonly SourcePiece[],lineText:string):SourceSpan[] {
  const runs=pieces.map(piece=>({...piece,text:clean(piece.text)})).filter(piece=>piece.text.length>0);
  if(runs.map(piece=>piece.text).join(' ')!==clean(lineText))return [];
  const offsets:number[]=[];let offset=0;
  for(const run of runs){offsets.push(offset);offset+=run.text.length+1;}
  const emailLine=/@\s*[A-Za-z0-9]/.test(lineText);
  const seeds=runs.map((run,index)=>run.math
    // Symbol/CMSY also supplies list markers. Exclude a line-leading marker
    // followed by prose, but keep the same glyph between mathematical terms.
    && !(index===0 && /^[•◦▪▫‣⁃●○■□◆◇▶►]+$/.test(run.text) && /\b[A-Za-z]{2,}\b/.test(runs.slice(1).map(piece=>piece.text).join(' ')))
    // Grouped author addresses often typeset only their braces in CMSY.
    && !(emailLine && /^[{}]+$/.test(run.text)));
  const maths=new Set<number>();
  const adjacent=(a:SourcePiece,b:SourcePiece)=>a.region.page===b.region.page && b.region.x-(a.region.x+a.region.width)<Math.max(a.em,b.em)*1.2;
  for(let i=0;i<runs.length;i++)if(seeds[i]){
    maths.add(i);
    for(let j=i-1;j>=0&&mathNeighbour(runs[j].text)&&adjacent(runs[j],runs[j+1]);j--)maths.add(j);
    for(let j=i+1;j<runs.length&&mathNeighbour(runs[j].text)&&adjacent(runs[j-1],runs[j]);j++)maths.add(j);
  }
  const spans:SourceSpan[]=[];
  for(let i=0;i<runs.length;){
    const kind=maths.has(i)?'math':runs[i].bold?'bold':null;
    if(kind===null){i++;continue;}
    let end=i;
    while(end+1<runs.length && adjacent(runs[end],runs[end+1]) && (kind==='math'?maths.has(end+1):runs[end+1].bold&&!maths.has(end+1)))end++;
    spans.push({start:offsets[i],end:offsets[end]+runs[end].text.length,kind,regions:[union(runs.slice(i,end+1).map(run=>run.region))]});
    i=end+1;
  }
  return spans;
}
export const offsetSourceSpans=(spans:readonly SourceSpan[],offset:number):SourceSpan[]=>spans.map(span=>({...span,start:span.start+offset,end:span.end+offset}));
