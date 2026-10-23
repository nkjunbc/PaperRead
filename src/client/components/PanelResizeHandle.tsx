import { useRef, type JSX } from 'react';

export function PanelResizeHandle({ width, onResize }: { width: number; onResize(width: number): void }): JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onResize(Math.max(320, Math.min(620, value)));
  return <div className="reader-panel-resizer" role="separator" tabIndex={0} aria-label="메모·질문 패널 폭 조절" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={620} aria-valuenow={width}
    title="드래그하거나 방향키로 패널 폭 조절"
    onPointerDown={(event) => { event.preventDefault(); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }}
    onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }}
    onKeyDown={(event) => {
      if (event.key === 'ArrowLeft') resize(width + 24);
      else if (event.key === 'ArrowRight') resize(width - 24);
      else if (event.key === 'Home') resize(320);
      else if (event.key === 'End') resize(620);
      else return;
      event.preventDefault();
    }} />;
}
