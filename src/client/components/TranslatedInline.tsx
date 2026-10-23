import { useEffect, useState, type JSX } from 'react';
import type { Block, Region } from '../../shared/contracts';
import { regionToPixels, type Size } from '../lib/geometry';
import type { PDFDocumentProxy } from '../lib/pdf';
import { inlineMathText, translationRuns } from '../lib/translation-text';
import { MathSelectionText, useMathSelection } from './SelectableSourceMath';

type PageImage={url:string;size:Size};
const pages=new WeakMap<PDFDocumentProxy,Map<string,Promise<PageImage>>>();
/** Cross-page paragraphs and crops alone need an extra render. Current-page math shares the
 * existing page image. Bound extra cached pages to avoid retaining a whole long paper in memory. */
function extraPageImage(doc:PDFDocumentProxy,page:number,zoom:number,dpr:number):Promise<PageImage>{
  let cache=pages.get(doc);if(!cache){cache=new Map();pages.set(doc,cache);}
  const key=`${page}:${zoom}:${dpr}`;
  const cached=cache.get(key);if(cached)return cached;
  const pending=(async()=>{
    const proxy=await doc.getPage(page),viewport=proxy.getViewport({scale:zoom*dpr});
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    const context=canvas.getContext('2d');if(!context)throw new Error('Canvas unavailable');
    await proxy.render({canvas,canvasContext:context,viewport}).promise;
    return {url:canvas.toDataURL(),size:{width:viewport.width/dpr,height:viewport.height/dpr}};
  })();
  cache.set(key,pending);
  while(cache.size>4)cache.delete(cache.keys().next().value!);
  void pending.catch(()=>{if(cache?.get(key)===pending)cache.delete(key);});
  return pending;
}

/** Icons have no text nodes: a failed image must keep selection offsets unchanged. */
export function MissingInlineMath({message,width='1em',height='1em',sourceText=''}:{message:string;width?:number|string;height?:number|string;sourceText?:string}):JSX.Element{
  const selection=useMathSelection(sourceText);
  return <span {...selection} ref={node=>{selection.ref.current=node;}} className="kr-inline-math-missing kr-math-selectable" role={sourceText?'button':'img'} tabIndex={sourceText?0:undefined} aria-label={message} title={message}
    style={{display:'inline-block',width,height,verticalAlign:'-0.2em',outline:'1px dotted currentColor'}}>
    <svg viewBox="0 0 20 20" width="100%" height="100%" aria-hidden="true" focusable="false" style={{display:'block'}}>
      <path d="M10 4v8M10 15v1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
    {sourceText?<MathSelectionText text={sourceText}/>:null}
  </span>;
}

/** The render of `page` when it is not `imagePage`, the page already drawn: undefined while it
 * loads (and for `imagePage` itself), null when it could not be drawn. */
export function useOtherPageImage(doc:PDFDocumentProxy,page:number,imagePage:number,zoom:number,dpr:number):PageImage|null|undefined{
  const [extra,setExtra]=useState<{image:PageImage|null;page:number;doc:PDFDocumentProxy;zoom:number;dpr:number}|null>(null);
  useEffect(()=>{
    if(page===imagePage)return;
    let cancelled=false;
    setExtra(null);
    void extraPageImage(doc,page,zoom,dpr)
      .then(next=>{if(!cancelled)setExtra({image:next,page,doc,zoom,dpr});})
      .catch(()=>{if(!cancelled)setExtra({image:null,page,doc,zoom,dpr});});
    return()=>{cancelled=true;};
  },[doc,page,imagePage,zoom,dpr]);
  if(page===imagePage)return undefined;
  return extra?.page===page&&extra.doc===doc&&extra.zoom===zoom&&extra.dpr===dpr?extra.image:undefined;
}

function InlineMath({region,sourceText,image,imagePage,doc,zoom,dpr}:{region:Region;sourceText:string;image:PageImage;imagePage:number;doc:PDFDocumentProxy;zoom:number;dpr:number}):JSX.Element{
  const selection=useMathSelection(sourceText);
  const extra=useOtherPageImage(doc,region.page,imagePage,zoom,dpr);
  const source=region.page===imagePage?image:extra??null;
  const size=source?.size??image.size;
  const rect=regionToPixels(region,size);
  if(extra===null)return <MissingInlineMath
    message={`수식 이미지를 불러오지 못했습니다. 원문 ${region.page}쪽을 확인해 주세요.`} width={rect.width} height={rect.height} sourceText={sourceText}/>;
  return <span {...selection} ref={node=>{selection.ref.current=node;}} className="kr-inline-math kr-math-selectable" role="button" tabIndex={0} aria-label={`원문 수식: ${sourceText}`} title="클릭하거나 드래그해 수식 선택 · 메모·질문"
    style={{display:'inline-block',width:rect.width,height:rect.height,verticalAlign:'-0.2em',backgroundImage:source?`url(${source.url})`:undefined,backgroundSize:`${size.width}px ${size.height}px`,backgroundPosition:`-${rect.left}px -${rect.top}px`,backgroundRepeat:'no-repeat'}}><MathSelectionText text={sourceText}/></span>;
}

export function TranslatedInline({text,promptVersion,block,image,imagePage,doc,zoom,dpr}:{text:string;promptVersion?:string;block:Block;image:PageImage;imagePage:number;doc:PDFDocumentProxy;zoom:number;dpr:number}):JSX.Element{
  return <>{translationRuns(text,promptVersion).map((run,index)=>{
    if(run.kind==='text')return run.text;
    if(run.kind==='bold')return <strong key={index}><TranslatedInline text={run.text} promptVersion={promptVersion} block={block} image={image} imagePage={imagePage} doc={doc} zoom={zoom} dpr={dpr}/></strong>;
    const span=block.sourceSpans?.[run.index];
    const sourceText=inlineMathText(block,run.index);
    if(!span||span.kind!=='math'||span.regions.length!==1)return <MissingInlineMath key={index} message="수식 원문을 확인해 주세요" sourceText={sourceText}/>;
    return <InlineMath key={index} region={span.regions[0]} sourceText={sourceText} image={image} imagePage={imagePage} doc={doc} zoom={zoom} dpr={dpr}/>;
  })}</>;
}
