import { useRef, useState, type JSX, type PointerEvent } from 'react';
import type { AnnotationInput, AnnotationSurface, Highlight, InkPoint } from '../../shared/contracts';
import { inkToAnnotation } from '../lib/annotations';
import { INK_COLORS, inkPath, inkPixels } from './HighlightLayer';

export interface InkSurfaceProps {
  page:number; surface:AnnotationSurface; color:Highlight['color']; layoutSignature?:string;
  /** The pen's thickness as a share of the page width, and the page's drawn width in pixels. */
  width:number; pageWidth:number;
  onCreate(input:AnnotationInput):void;
  disabled?:boolean;
}

/** Pointer capture keeps one pen gesture on its page. Touch scrolling is unaffected in read mode. */
export function InkSurface({ page, surface, color, layoutSignature, width, pageWidth, onCreate, disabled=false }: InkSurfaceProps): JSX.Element {
  const active = useRef<{ pointerId:number; points:InkPoint[]; layoutSignature?:string } | null>(null);
  const [points, setPoints] = useState<InkPoint[]>([]);
  const point = (event: PointerEvent<HTMLDivElement>): InkPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
  };
  return <>
    <svg className="annotation-ink-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><path d={inkPath(points)} stroke={INK_COLORS[color]} strokeWidth={inkPixels(width, pageWidth)} vectorEffect="non-scaling-stroke" /></svg>
    <div className="annotation-pen-surface" aria-label={`${page}쪽 ${surface === 'original' ? '원문' : '번역'} 필기 영역`} aria-disabled={disabled||undefined} title={disabled?'글꼴을 불러오는 중입니다. 잠시 후 필기할 수 있습니다.':undefined}
      onPointerDown={(e) => {
        if (e.button !== 0 || active.current) return;
        if(disabled){e.preventDefault();e.stopPropagation();return;}
        e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
        active.current = { pointerId:e.pointerId, points:[point(e)], layoutSignature }; setPoints([...active.current.points]);
      }}
      onPointerMove={(e) => {
        if (active.current?.pointerId !== e.pointerId) return;
        e.preventDefault(); e.stopPropagation();
        const next = point(e); const prior = active.current.points.at(-1)!;
        if (Math.hypot(next.x - prior.x, next.y - prior.y) < 0.0005) return;
        active.current.points.push(next);
        // Bound the live buffer as well as the stored stroke, preserving its endpoints.
        if (active.current.points.length > 2400) active.current.points = active.current.points.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
        setPoints([...active.current.points]);
      }}
      onPointerUp={(e) => {
        if (active.current?.pointerId !== e.pointerId) return;
        e.preventDefault(); e.stopPropagation();
        active.current.points.push(point(e));
        // A concurrently completed translation must not relabel an in-progress stroke as
        // belonging to the new layout. Keep its initial layout so an unsafe overlay hides.
        const annotation = inkToAnnotation(active.current.points, page, surface, color, active.current.layoutSignature, width);
        active.current = null; setPoints([]);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        if (annotation) onCreate(annotation);
      }}
      onPointerCancel={() => { active.current = null; setPoints([]); }}
      onLostPointerCapture={() => { active.current = null; setPoints([]); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    />
  </>;
}
