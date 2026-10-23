import { useEffect, useRef, type CSSProperties, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { sourceMathText } from '../lib/translation-text';
import { rangeContainsText } from '../lib/annotations';

/** One native selection shared by copy, annotation anchors and question quotes. */
export function useMathSelection(text:string) {
  const ref=useRef<HTMLElement|null>(null);
  const pressed=useRef<{x:number;y:number}|null>(null);
  useEffect(()=>{
    const update=()=>{
      const node=ref.current;
      const content=node?.querySelector('.kr-math-text');
      const selection=window.getSelection();
      const selected=!!(content&&selection&&!selection.isCollapsed&&selection.rangeCount&&rangeContainsText(selection.getRangeAt(0),content.firstChild));
      if(node)node.toggleAttribute('data-math-selected',selected);
    };
    document.addEventListener('selectionchange',update);
    return()=>document.removeEventListener('selectionchange',update);
  },[]);
  const select=()=>{
    const content=ref.current?.querySelector('.kr-math-text');
    const selection=window.getSelection();
    if(!content||!selection||!text.trim())return;
    const range=document.createRange();range.selectNodeContents(content);
    selection.removeAllRanges();selection.addRange(range);
    ref.current?.setAttribute('data-math-selected','');
  };
  return {
    ref,
    onPointerDown:(event:PointerEvent<HTMLElement>)=>{pressed.current={x:event.clientX,y:event.clientY};},
    onClick:(event:MouseEvent<HTMLElement>)=>{
      event.stopPropagation();
      const start=pressed.current;pressed.current=null;
      if(start&&Math.hypot(start.x-event.clientX,start.y-event.clientY)>3)return;
      select();
    },
    onKeyDown:(event:KeyboardEvent<HTMLElement>)=>{
      if(event.nativeEvent.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
      if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();select();}
    },
  };
}

export function MathSelectionText({text}:{text:string}):JSX.Element {
  return <span className="kr-math-text" aria-hidden="true">{text}</span>;
}

export interface SelectableSourceMathProps {
  sourceText:string; blockId:string; page:number; style?:CSSProperties; className?:string;
  /** The crop's drawn parts, when it is not drawn as this element's own background. */
  children?:ReactNode;
}

/** Display equations retain the existing PDF crop dimensions and reading-order position. */
export function SelectableSourceMath({sourceText,blockId,page,style,className='kr-source kr-equation',children}:SelectableSourceMathProps):JSX.Element {
  const text=sourceMathText(sourceText);
  const selection=useMathSelection(text);
  const available=text.trim().length>0;
  return <div {...selection} ref={node=>{selection.ref.current=node;}} className={`${className} kr-math-block kr-math-selectable`} style={style} data-block-id={blockId}
    role={available?'button':'img'} tabIndex={available?0:undefined}
    aria-label={available?`원문 수식: ${text}`:`${page}쪽 수식 · 추출된 텍스트 없음`}
    title={available?'클릭하거나 드래그해 수식 선택 · 메모·질문':'추출된 수식 텍스트가 없어 텍스트 인용을 할 수 없습니다.'}>
    {children}
    {available?<MathSelectionText text={text}/>:null}
  </div>;
}
