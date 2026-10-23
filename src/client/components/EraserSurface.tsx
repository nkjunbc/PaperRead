import { useRef, useState, type JSX, type PointerEvent } from 'react';
import type { Highlight } from '../../shared/contracts';
import type { Point } from '../lib/highlights';
import { ERASER_RADII, ERASER_SIZE_LABELS, inkIntersectsEraser, type EraserSize } from '../lib/eraser';

export function EraserSurface({ page, highlights, onErase, size = 'medium' }: {page:number; highlights:Highlight[]; onErase(id:string):void; size?:EraserSize}):JSX.Element {
  const radius = ERASER_RADII[size];
  const gesture = useRef<{id:number;point:Point;sent:Set<string>}|null>(null);
  const [cursor,setCursor] = useState<Point|null>(null);
  const erase = (event:PointerEvent<HTMLDivElement>, begin:boolean) => {
    const box=event.currentTarget.getBoundingClientRect();
    const point={x:event.clientX-box.left,y:event.clientY-box.top};
    setCursor(point);
    if (begin) gesture.current={id:event.pointerId,point,sent:new Set()};
    const active=gesture.current;
    if (!active || active.id!==event.pointerId) return;
    for (const h of highlights) if (!active.sent.has(h.highlightId) && inkIntersectsEraser(h,active.point,point,box,radius)) { active.sent.add(h.highlightId); onErase(h.highlightId); }
    active.point=point;
  };
  return <div className="annotation-pen-surface annotation-eraser-surface" aria-label={`${page}쪽 필기 지우개 영역 · ${ERASER_SIZE_LABELS[size]}`}
    onPointerDown={(e)=> {if(e.button!==0)return; e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);erase(e,true);}}
    onPointerMove={(e)=>{e.stopPropagation();erase(e,false);}}
    onPointerUp={(e)=>{if(gesture.current?.id!==e.pointerId)return;e.preventDefault();e.stopPropagation();erase(e,false);gesture.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
    onPointerCancel={()=>{gesture.current=null;setCursor(null);}}
    onLostPointerCapture={()=>{gesture.current=null;}}
    onPointerLeave={()=>{if(!gesture.current)setCursor(null);}}
    onClick={(e)=>{e.preventDefault();e.stopPropagation();}}>
    {cursor ? <span className="annotation-eraser-cursor" style={{left:cursor.x,top:cursor.y,width:radius*2,height:radius*2}} aria-hidden="true"/>:null}
  </div>;
}
