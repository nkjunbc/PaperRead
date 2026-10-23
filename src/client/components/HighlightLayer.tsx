import { useEffect, useRef, useState, type JSX } from 'react';
import type { Highlight, InkPoint } from '../../shared/contracts';
import { IconChat } from './ChatIcons';

const COLOR_VALUES: Record<Highlight['color'], string> = {
  yellow: 'rgba(255, 213, 79, 0.45)',
  green: 'rgba(129, 199, 132, 0.45)',
  blue: 'rgba(100, 181, 246, 0.45)',
  pink: 'rgba(240, 152, 190, 0.45)',
};

export const HIGHLIGHT_COLORS: readonly Highlight['color'][] = ['yellow', 'green', 'blue', 'pink'];
export const INK_COLORS: Record<Highlight['color'], string> = { yellow:'#ac8120', green:'#42765c', blue:'#3f698c', pink:'#9d526f' };
export function inkPath(points: InkPoint[]): string { return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * 1000},${p.y * 1000}`).join(' '); }

interface HighlightBoxProps {
  highlight: Highlight;
  onOpen(highlight: Highlight): void;
}

/** One saved highlight, painted as a ratio-positioned colored rectangle per rect. */
function HighlightBox({ highlight, onOpen }: HighlightBoxProps): JSX.Element {
  const pressed = useRef<{x:number;y:number}|null>(null);
  return (
    <>
      {highlight.rects.map((rect, index) => (
        <button
          key={`${highlight.highlightId}-${index}`}
          type="button"
          className="highlight-box"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
            backgroundColor: COLOR_VALUES[highlight.color],
          }}
          aria-label={`하이라이트: ${highlight.text.slice(0, 40)}`}
          onPointerDown={(event) => { pressed.current={x:event.clientX,y:event.clientY}; }}
          onClick={(event) => {
            event.stopPropagation();
            const start=pressed.current;pressed.current=null;
            if(event.detail>0&&start&&Math.hypot(event.clientX-start.x,event.clientY-start.y)>3)return;
            onOpen(highlight);
          }}
        >
          {index === 0 && highlight.note !== null ? <span className="highlight-note-dot" aria-hidden="true" /> : null}
        </button>
      ))}
    </>
  );
}

export interface HighlightPopoverProps {
  highlight: Highlight;
  onSave(note: string, color: Highlight['color']): void;
  onDelete(): void;
  onClose(): void;
  /** Quote the highlighted passage into a question about the paper. */
  onAsk?(text: string): void;
  busy?: boolean;
  error?: string|null;
  onDirtyChange?(dirty:boolean):void;
}

/** The small editor that opens when a highlight is clicked: excerpt, note, color, save/delete/close. */
export function HighlightPopover({ highlight, onSave, onDelete, onClose, onAsk, busy = false, error, onDirtyChange }: HighlightPopoverProps): JSX.Element {
  const [note, setNote] = useState(highlight.note ?? '');
  const [color, setColor] = useState<Highlight['color']>(highlight.color);
  // An unsaved note keeps the editor open; otherwise asking moves the reader on to the question.
  const edited = note !== (highlight.note ?? '') || color !== highlight.color;
  useEffect(() => { onDirtyChange?.(edited); }, [edited,onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const editor = root.current;
    return () => {
      const prior = previousFocus.current;
      if (prior instanceof HTMLElement && prior.isConnected && (document.activeElement === document.body || (document.activeElement && editor?.contains(document.activeElement)))) prior.focus({ preventScroll:true });
    };
  }, []);
  const close = () => { if (busy) return; if (edited) setConfirmDiscard(true); else onClose(); };

  return (
    <div
      className="highlight-popover"
      ref={root}
      role="dialog"
      aria-label="하이라이트 메모"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault(); if (!busy) onSave(note.trim().length === 0 ? '' : note, color);
        }
      }}
    >
      <div className="highlight-editor-head"><strong>{highlight.page}쪽 · {highlight.surface === 'translation' ? '번역' : '원문'} {highlight.kind === 'ink' ? '필기' : '메모'}</strong><button type="button" aria-label="메모 닫기" onClick={close}>×</button></div>
      {highlight.kind !== 'ink' ? <p className="highlight-excerpt">{highlight.text.slice(0, 200)}</p> : null}
      {onAsk !== undefined && highlight.kind !== 'ink' ? (
        <button
          type="button"
          className="highlight-popover-ask"
          disabled={busy}
          onClick={() => {
            onAsk(highlight.text);
            if (!edited) onClose();
          }}
        >
          <IconChat size={14} />
          이 부분 질문하기
        </button>
      ) : null}
      <textarea
        aria-label="메모"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={3}
        maxLength={5000}
        placeholder="이 부분에 대한 생각을 남기세요"
        autoFocus
        disabled={busy}
      />
      <div className="highlight-colors">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`highlight-color-swatch${c === color ? ' selected' : ''}`}
            style={{ backgroundColor: COLOR_VALUES[c] }}
            aria-label={`색 ${c}`}
            aria-pressed={c === color}
            disabled={busy}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      {busy ? <p role="status">저장 중…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {edited ? <p className="highlight-dirty">저장하지 않은 변경 · Ctrl/⌘ + Enter로 저장</p> : null}
      {confirmDiscard ? <div className="highlight-discard" role="alert">작성 중인 메모를 저장할까요?<div><button type="button" disabled={busy} onClick={() => onSave(note.trim().length === 0 ? '' : note, color)}>저장</button><button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)}>계속 작성</button><button type="button" disabled={busy} onClick={onClose}>변경 버리기</button></div></div> : null}
      <div className="highlight-popover-actions">
        <button type="button" disabled={busy} onClick={() => onSave(note.trim().length === 0 ? '' : note, color)}>
          저장
        </button>
        <button type="button" disabled={busy} onClick={onDelete}>
          삭제
        </button>
        <button type="button" disabled={busy} onClick={close}>
          닫기
        </button>
      </div>
    </div>
  );
}

export interface HighlightLayerProps {
  highlights: Highlight[];
  onOpen(highlight: Highlight): void;
}

/** All saved highlights for one page, absolutely positioned over the page box. */
export function HighlightLayer({ highlights, onOpen }: HighlightLayerProps): JSX.Element {
  return (
    <><div className="highlight-layer">
      {highlights.filter((highlight) => highlight.kind !== 'ink').map((highlight) => (
        <HighlightBox key={highlight.highlightId} highlight={highlight} onOpen={onOpen} />
      ))}
    </div>
    <svg className="annotation-ink-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="저장된 필기">
      {highlights.filter((highlight) => highlight.kind === 'ink').flatMap((highlight) => (highlight.strokes ?? []).map((stroke, i) => <path key={`${highlight.highlightId}-${i}`} className="saved-ink" role="button" tabIndex={0} aria-label={`${highlight.page}쪽 필기 메모 열기`} d={inkPath(stroke.points)} stroke={INK_COLORS[highlight.color]} strokeWidth="2.25" vectorEffect="non-scaling-stroke" onClick={(e) => { e.stopPropagation(); onOpen(highlight); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(highlight); } }} />))}
    </svg></>
  );
}

export default HighlightLayer;
