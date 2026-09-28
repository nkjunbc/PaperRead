import { useState, type JSX } from 'react';
import type { Highlight } from '../../shared/contracts';
import { IconChat } from './ChatIcons';

const COLOR_VALUES: Record<Highlight['color'], string> = {
  yellow: 'rgba(255, 213, 79, 0.45)',
  green: 'rgba(129, 199, 132, 0.45)',
  blue: 'rgba(100, 181, 246, 0.45)',
  pink: 'rgba(240, 152, 190, 0.45)',
};

export const HIGHLIGHT_COLORS: readonly Highlight['color'][] = ['yellow', 'green', 'blue', 'pink'];

interface HighlightBoxProps {
  highlight: Highlight;
  onOpen(highlight: Highlight): void;
}

/** One saved highlight, painted as a ratio-positioned colored rectangle per rect. */
function HighlightBox({ highlight, onOpen }: HighlightBoxProps): JSX.Element {
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
          onClick={(event) => {
            event.stopPropagation();
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
}

/** The small editor that opens when a highlight is clicked: excerpt, note, color, save/delete/close. */
export function HighlightPopover({ highlight, onSave, onDelete, onClose, onAsk }: HighlightPopoverProps): JSX.Element {
  const [note, setNote] = useState(highlight.note ?? '');
  const [color, setColor] = useState<Highlight['color']>(highlight.color);
  // An unsaved note keeps the editor open; otherwise asking moves the reader on to the question.
  const edited = note !== (highlight.note ?? '') || color !== highlight.color;

  return (
    <div
      className="highlight-popover"
      role="dialog"
      aria-label="하이라이트 메모"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <p className="highlight-excerpt">{highlight.text.slice(0, 200)}</p>
      {onAsk !== undefined ? (
        <button
          type="button"
          className="highlight-popover-ask"
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
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="highlight-popover-actions">
        <button type="button" onClick={() => onSave(note.trim().length === 0 ? '' : note, color)}>
          저장
        </button>
        <button type="button" onClick={onDelete}>
          삭제
        </button>
        <button type="button" onClick={onClose}>
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
    <div className="highlight-layer">
      {highlights.map((highlight) => (
        <HighlightBox key={highlight.highlightId} highlight={highlight} onOpen={onOpen} />
      ))}
    </div>
  );
}

export default HighlightLayer;
