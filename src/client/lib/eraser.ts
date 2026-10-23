import type { Highlight } from '../../shared/contracts';
import type { Size } from './geometry';
import type { Point } from './highlights';

export type EraserSize = 'small' | 'medium' | 'large';
/** Screen CSS pixels: page zoom must not scale the eraser cursor or hit area. */
export const ERASER_RADII: Record<EraserSize, number> = { small: 6, medium: 12, large: 24 };
export const ERASER_SIZE_LABELS: Record<EraserSize, string> = { small: '작게', medium: '보통', large: '크게' };

function pointToSegment(point:Point, a:Point, b:Point):number {
  const dx = b.x-a.x, dy = b.y-a.y;
  const denominator = dx*dx+dy*dy;
  const t = denominator === 0 ? 0 : Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/denominator));
  return Math.hypot(point.x-a.x-t*dx, point.y-a.y-t*dy);
}
function crossed(a:Point,b:Point,c:Point,d:Point):boolean {
  const orient = (p:Point,q:Point,r:Point) => (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
  const o1=orient(a,b,c), o2=orient(a,b,d), o3=orient(c,d,a), o4=orient(c,d,b);
  return o1*o2 < 0 && o3*o4 < 0;
}
/** Only pen strokes are erased; highlights and memos are deleted from their own menu, and so is
 * a stroke that carries a memo (an older version allowed one). A stroke is touched when the
 * eraser reaches its painted edge: its width is a share of the page width. */
export function inkIntersectsEraser(highlight:Highlight, from:Point, to:Point, size:Size, radius:number):boolean {
  if (highlight.kind !== 'ink' || (highlight.note ?? null) !== null) return false;
  return (highlight.strokes ?? []).some((stroke) => {
    const reach = radius + 1.2 + stroke.width*size.width/2;
    for (let i=1;i<stroke.points.length;i++) {
      const a={x:stroke.points[i-1].x*size.width,y:stroke.points[i-1].y*size.height};
      const b={x:stroke.points[i].x*size.width,y:stroke.points[i].y*size.height};
      if (crossed(from,to,a,b) || Math.min(pointToSegment(a,from,to),pointToSegment(b,from,to),pointToSegment(from,a,b),pointToSegment(to,a,b)) <= reach) return true;
    }
    return false;
  });
}
