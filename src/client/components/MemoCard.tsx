import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { Highlight } from '../../shared/contracts';
import type { CardAnchor, MemoCard } from '../lib/annotation-session';
import { markedText } from '../lib/annotations';
import { HIGHLIGHT_COLORS, HIGHLIGHT_FILLS, HIGHLIGHT_LABELS, INK_COLORS, INK_LABELS } from './HighlightLayer';

const CARD_WIDTH = 320;
const MARGIN = 8;

/** Where the card goes, in viewport pixels: beside the right end of a new memo's selection, as
 * Edge opens it, or below a saved record's mark. Null when its mark is not drawn right now. */
function markPlace(card: Pick<MemoCard, 'kind' | 'highlightId'>): CardAnchor | null {
  if (typeof document === 'undefined') return null;
  if (card.kind === 'new') {
    const selection = Array.from(document.querySelectorAll<HTMLElement>('.highlight-draft.is-selection')).at(-1);
    if (selection === undefined) return null;
    const box = selection.getBoundingClientRect();
    return { left: box.right + 1, top: box.top + 5 };
  }
  // Compare data attributes directly: record IDs never become CSS selectors.
  const marks = Array.from(document.querySelectorAll<Element>('.highlight-box[data-highlight-id], .saved-ink[data-highlight-id]')).filter((mark) => mark.getAttribute('data-highlight-id') === card.highlightId);
  if (marks.length === 0) return null;
  const boxes = marks.map((mark) => mark.getBoundingClientRect());
  return { left: Math.min(...boxes.map((box) => box.left)), top: Math.max(...boxes.map((box) => box.bottom)) + 6 };
}

/** A card whose mark is not drawn (opened from the memo list for a far page) starts mid-screen. */
function centered(): CardAnchor {
  return typeof window === 'undefined' ? { left: MARGIN, top: MARGIN } : { left: (window.innerWidth - CARD_WIDTH) / 2, top: window.innerHeight / 4 };
}

function inView(place: CardAnchor, height: number): CardAnchor {
  if (typeof window === 'undefined') return place;
  return {
    left: Math.max(MARGIN, Math.min(place.left, window.innerWidth - CARD_WIDTH - MARGIN)),
    top: Math.max(MARGIN, Math.min(place.top, window.innerHeight - height - MARGIN)),
  };
}

export interface MemoMenuProps {
  record: Highlight;
  /** The memo is open for writing: there is nothing to switch to editing. */
  editing: boolean;
  onEdit(): void;
  onDeleteMemo(): void;
  onDeleteRecord(): void;
  onRecolor(color: Highlight['color']): void;
  onAsk?(text: string): void;
  /** Called before any choice is acted on: the menu closes. */
  onChosen(): void;
  /** A request about the record is on its way (from its card or the memo list): nothing here
   * changes it until the service answers. */
  locked?: boolean;
}

/** A saved record's own menu, the one place its memo and the record itself are deleted from. A
 * pen stroke takes no memo: one an older version put there can only be deleted. */
export function MemoMenu({ record, editing, onEdit, onDeleteMemo, onDeleteRecord, onRecolor, onAsk, onChosen, locked = false }: MemoMenuProps): JSX.Element {
  const ink = record.kind === 'ink';
  const item = (label: string, action: () => void, changes = true) => (
    <button type="button" role="menuitem" disabled={changes && locked} onClick={() => { onChosen(); action(); }}>{label}</button>
  );
  return (
    <div className="memo-card__menu" role="menu" aria-label={ink ? '필기 메뉴' : '메모 메뉴'}>
      {!ink && record.note !== null && !editing ? item('편집', onEdit) : null}
      {record.note !== null ? item('메모 삭제', onDeleteMemo) : null}
      {item(ink ? '필기 삭제' : '하이라이트 삭제', onDeleteRecord)}
      {!ink && onAsk !== undefined ? item('질문에 인용', () => onAsk(markedText([record])), false) : null}
      <div className="memo-card__colors" role="group" aria-label="색">
        {HIGHLIGHT_COLORS.map((color) => (
          <button key={color} type="button" className="annotation-swatch" aria-label={(ink ? INK_LABELS : HIGHLIGHT_LABELS)[color]} aria-pressed={record.color === color} disabled={locked} style={{ '--swatch': (ink ? INK_COLORS : HIGHLIGHT_FILLS)[color] } as CSSProperties} onClick={() => { onChosen(); if (record.color !== color) onRecolor(color); }} />
        ))}
      </div>
    </div>
  );
}

export interface MemoCardViewProps {
  card: MemoCard;
  /** The saved record a card shows; null for a new memo. */
  record: Highlight | null;
  onText(text: string): void;
  onSave(): void;
  onEdit(): void;
  onClose(): void;
  onDeleteMemo(): void;
  onDeleteRecord(): void;
  onRecolor(color: Highlight['color']): void;
  /** Quote the marked passage into a question about the paper. */
  onAsk?(text: string): void;
}

/**
 * Edge's memo card: a yellow note beside the text it is about. A new memo opens empty and ready
 * for writing; a saved one opens to read, with its own menu for editing, deleting the memo or
 * the whole record, recolouring and quoting. While a save is on its way the card is locked, and
 * it says so; a failed save leaves the writing in place, editable, with the reason. A memo
 * belongs to a highlight: a pen stroke's card is its menu, with nothing to write.
 */
export function MemoCardView({ card, record, onText, onSave, onEdit, onClose, onDeleteMemo, onDeleteRecord, onRecolor, onAsk }: MemoCardViewProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [place, setPlace] = useState<CardAnchor>(() => inView(markPlace(card) ?? card.anchor ?? centered(), 192));
  const ink = record?.kind === 'ink';
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const writing = card.editing && !ink;
  const showMenu = record !== null && (ink || menuOpen);
  const dirty = writing && card.text !== (record?.note ?? '');
  const empty = card.text.trim().length === 0;

  // The card follows its mark as the panes scroll; while the mark is not drawn it stays put.
  const { kind, highlightId } = card;
  useLayoutEffect(() => {
    const follow = () => {
      const mark = markPlace({ kind, highlightId });
      setPlace((current) => {
        const next = inView(mark ?? current, root.current?.offsetHeight ?? 192);
        return next.left === current.left && next.top === current.top ? current : next;
      });
    };
    follow();
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => { window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow); };
  }, [kind, highlightId]);

  // Focus goes back where it was when the card closes.
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const card = root.current;
    return () => {
      const prior = previousFocus.current;
      if (prior instanceof HTMLElement && prior.isConnected && (document.activeElement === document.body || (document.activeElement && card?.contains(document.activeElement)))) prior.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { if (writing && !card.saving) field.current?.focus({ preventScroll: true }); }, [writing, card.saving]);

  const save = () => { if (!card.saving && writing && !empty) onSave(); };
  const close = () => {
    if (card.saving) return;
    if (dirty && !empty) setConfirmDiscard(true);
    else onClose();
  };

  return (
    <div
      className={`memo-card${writing ? ' is-editing' : ''}`}
      role="dialog"
      aria-label={card.kind === 'new' ? '새 메모' : ink ? `${record?.page ?? ''}쪽 필기` : `${record?.page ?? ''}쪽 하이라이트 메모`}
      aria-busy={card.saving}
      ref={root}
      style={{ left: place.left, top: place.top }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          if (menuOpen && !ink) setMenuOpen(false);
          else close();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          save();
        }
      }}
    >
      <div className="memo-card__head">
        {record !== null && !ink ? (
          <button type="button" className="memo-card__more" aria-label="메모 메뉴" aria-haspopup="menu" aria-expanded={menuOpen} disabled={card.saving} onClick={() => setMenuOpen((open) => !open)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="4" cy="8" r="0.9" /><circle cx="8" cy="8" r="0.9" /><circle cx="12" cy="8" r="0.9" /></svg>
          </button>
        ) : null}
        <button type="button" className="memo-card__close" aria-label={ink ? '닫기' : '메모 닫기'} disabled={card.saving} onClick={close}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        </button>
      </div>
      {showMenu && record !== null ? (
        <MemoMenu record={record} editing={writing} onEdit={onEdit} onDeleteMemo={onDeleteMemo} onDeleteRecord={onDeleteRecord} onRecolor={onRecolor} onAsk={onAsk} onChosen={() => setMenuOpen(false)} locked={card.saving} />
      ) : null}
      {writing ? (
        <textarea ref={field} aria-label="메모" placeholder="여기에 메모를 입력합니다." maxLength={5000} readOnly={card.saving} value={card.text} onChange={(event) => onText(event.target.value)} />
      ) : ink && (record?.note ?? null) === null ? null : (
        <p className="memo-card__text">{record?.note ?? ''}</p>
      )}
      {card.saving ? <p className="memo-card__status" role="status">저장 중…</p> : null}
      {card.error !== null ? <p role="alert">{card.error}</p> : null}
      {confirmDiscard ? (
        <div className="memo-card__discard" role="alert">
          작성 중인 메모를 저장할까요?
          <div>
            <button type="button" disabled={card.saving} onClick={() => { setConfirmDiscard(false); save(); }}>저장</button>
            <button type="button" onClick={() => { setConfirmDiscard(false); field.current?.focus(); }}>계속 작성</button>
            <button type="button" onClick={() => { setConfirmDiscard(false); onClose(); }}>변경 버리기</button>
          </div>
        </div>
      ) : null}
      {writing ? (
        <button type="button" className="memo-card__done" aria-label="메모 저장" disabled={card.saving || empty} onClick={save}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8" /></svg>
        </button>
      ) : null}
    </div>
  );
}
