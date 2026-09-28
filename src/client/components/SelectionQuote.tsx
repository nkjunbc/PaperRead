import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { normalizeSelection } from '../lib/chat';
import { IconQuote } from './ChatIcons';

export interface SelectionQuoteProps {
  /** The Korean pane's scrolling body; only a selection inside it offers a quote. */
  containerRef: RefObject<HTMLElement | null>;
  onQuote(text: string): void;
}

interface Anchor {
  top: number;
  left: number;
  below: boolean;
  text: string;
}

/** Room above a selection the button needs; closer to the pane's top it goes below instead. */
const BUTTON_ROOM = 44;

export interface PressTracker {
  /** A press that started inside the pane has not ended yet. */
  readonly pressed: boolean;
  dispose(): void;
}

/**
 * Follows a pointer press that starts inside the pane until it ends. It ends when released, or
 * when the browser cancels it: a touch pan, or a long-press the browser takes over, ends with
 * `pointercancel` and no `pointerup` — without that the press would never end and no selection
 * would be offered for quoting again.
 */
export function trackPresses(target: EventTarget, startsInside: (event: Event) => boolean, handlers: { onPress(): void; onRelease(): void }): PressTracker {
  let pressed = false;
  const down = (event: Event) => {
    if (!startsInside(event)) return;
    pressed = true;
    handlers.onPress();
  };
  const end = () => {
    if (!pressed) return;
    pressed = false;
    handlers.onRelease();
  };
  const capture = { capture: true };
  target.addEventListener('pointerdown', down, capture);
  target.addEventListener('pointerup', end, capture);
  target.addEventListener('pointercancel', end, capture);
  return {
    get pressed() {
      return pressed;
    },
    dispose() {
      target.removeEventListener('pointerdown', down, capture);
      target.removeEventListener('pointerup', end, capture);
      target.removeEventListener('pointercancel', end, capture);
    },
  };
}

/**
 * A small "질문에 인용" button floating over a finished text selection in the Korean pane.
 * It appears once the pointer is released (never while dragging), follows the selection as the
 * pane scrolls, and disappears when the selection collapses or leaves the pane's view.
 */
export function SelectionQuote({ containerRef, onQuote }: SelectionQuoteProps): JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const measure = () => {
      frame.current = null;
      const root = containerRef.current;
      const selection = document.getSelection();
      if (root === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setAnchor(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setAnchor(null);
        return;
      }
      const text = normalizeSelection(selection.toString());
      const rect = range.getBoundingClientRect();
      const pane = root.getBoundingClientRect();
      if (text.length === 0 || rect.bottom < pane.top || rect.top > pane.bottom || (rect.width === 0 && rect.height === 0)) {
        setAnchor(null);
        return;
      }
      const below = rect.top - BUTTON_ROOM < pane.top;
      const left = Math.min(Math.max(rect.left + rect.width / 2, pane.left + 64), pane.right - 64);
      setAnchor({ top: below ? Math.min(rect.bottom, pane.bottom - BUTTON_ROOM) + 8 : rect.top - 8, left, below, text });
    };
    const schedule = () => {
      if (presses.pressed || frame.current !== null) return;
      frame.current = window.requestAnimationFrame(measure);
    };
    const presses = trackPresses(
      document,
      (event) => {
        const root = containerRef.current;
        return root !== null && event.target instanceof Node && root.contains(event.target);
      },
      { onPress: () => setAnchor(null), onRelease: schedule },
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnchor(null);
    };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('keydown', onKey);
    // Scroll does not bubble; listening in the capture phase catches the pane's own scrolling.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      presses.dispose();
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [containerRef]);

  if (anchor === null) return null;
  return (
    <button
      type="button"
      className={`quote-button${anchor.below ? ' is-below' : ''}`}
      style={{ top: anchor.top, left: anchor.left }}
      // Keep the selection: a press on the button must not collapse it before the click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onQuote(anchor.text);
        document.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
    >
      <IconQuote />
      질문에 인용
    </button>
  );
}

export default SelectionQuote;
