export type TranslationRun = { kind:'text'; text:string } | { kind:'bold'; text:string } | { kind:'math'; index:number };
/** Only formatting emitted by the translation protocol; no HTML is interpreted. */
export function translationRuns(text:string,promptVersion='paperread-ko-v2'):TranslationRun[] {
  if(promptVersion!=='paperread-ko-v2')return [{kind:'text',text}];
  const runs:TranslationRun[]=[];
  // Keep the same emphasis boundaries accepted by the server's format gate.
  const pattern=/\[\[PR-MATH-(\d+)\]\]|\*\*(?=\S)([\s\S]*?\S|\S)\*\*/g;
  let offset=0;
  for(const match of text.matchAll(pattern)){
    if(match.index!>offset)runs.push({kind:'text',text:text.slice(offset,match.index)});
    runs.push(match[1]===undefined?{kind:'bold',text:match[2]}:{kind:'math',index:Number(match[1])});
    offset=match.index!+match[0].length;
  }
  if(offset<text.length)runs.push({kind:'text',text:text.slice(offset)});
  return runs;
}
/** Use only PDF-extracted source text; do not invent TeX for a cropped formula. */
export function sourceMathText(text:string):string { return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g,' '); }
export function inlineMathText(block:Pick<Block,'sourceText'|'sourceSpans'>|undefined,index:number):string {
  const span=block?.sourceSpans?.[index];
  return block&&span?.kind==='math'?sourceMathText(block.sourceText.slice(span.start,span.end)):'';
}
export function translationTextParts(text:string,promptVersion='paperread-ko-v2',block?:Pick<Block,'sourceText'|'sourceSpans'>):{text:string;math:boolean}[] {
  return translationRuns(text,promptVersion).flatMap(run=>run.kind==='bold'?translationTextParts(run.text,promptVersion,block):[{text:run.kind==='math'?inlineMathText(block,run.index):run.text,math:run.kind==='math'}]);
}
/** Exactly the paragraph's selectable textContent. Without a block this yields legacy
 * image-only text, used solely to map old saved offsets into the current renderer. */
export function renderedTranslationText(text:string,promptVersion='paperread-ko-v2',block?:Pick<Block,'sourceText'|'sourceSpans'>):string {
  return translationTextParts(text,promptVersion,block).map(run=>run.text).join('');
}
import type { Block } from '../../shared/contracts';
