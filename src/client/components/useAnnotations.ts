import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnnotationInput, AnnotationMode, Highlight, Paper } from '../../shared/contracts';
import { AnnotationSession, LASTING_NOTICES, type AnnotationClient, type CardAnchor } from '../lib/annotation-session';
import { HIGHLIGHTER_THICKNESS, PEN_WIDTH } from '../lib/annotations';
import type { EraserSize } from '../lib/eraser';
import type { AnnotationToolbarProps } from './AnnotationTools';
import type { MemoCardViewProps } from './MemoCard';

/** How long a notice such as "하이라이트를 저장했습니다." stays before it fades. */
const NOTICE_MS = 4500;

/** What both panes take to show and make the records of the paper being read. */
export interface AnnotationPaneProps {
  highlights: Highlight[];
  drafts: AnnotationInput[];
  annotationMode: AnnotationMode;
  highlighterColor: Highlight['color'];
  /** The share of each marked line's height the highlighter paints. */
  highlighterThickness: number;
  penColor: Highlight['color'];
  penWidth: number;
  annotationEraserSize: EraserSize;
  onCreateAnnotations(inputs: AnnotationInput[]): void;
  onStartMemo(inputs: AnnotationInput[], anchor: CardAnchor): void;
  onOpenHighlight(highlight: Highlight): void;
  onEraseAnnotation(highlightId: string): void;
}

/**
 * The highlights, memos and pen strokes of the paper being read, and the tools that make them.
 * The records live in one AnnotationSession: every answer from the service is applied only to
 * the paper it was asked for. They are read again when the paper's status or extraction
 * changes, and after a new translation (which removes the Korean-side ones) through `reload`;
 * `dropTranslation` lets the Korean side go the moment a new translation is confirmed.
 */
export function useAnnotations(client: AnnotationClient, paperKey: string | null, paper: Pick<Paper, 'status' | 'extractionVersion'> | null, onError: (cause: unknown) => void) {
  const reportError = useRef(onError);
  reportError.current = onError;
  const [session] = useState(() => new AnnotationSession(client, (cause) => reportError.current(cause)));
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const [mode, setMode] = useState<AnnotationMode>('select');
  const [highlighterColor, setHighlighterColor] = useState<Highlight['color']>('yellow');
  const [highlighterThickness, setHighlighterThickness] = useState<number>(HIGHLIGHTER_THICKNESS.initial);
  const [penColor, setPenColor] = useState<Highlight['color']>('blue');
  const [penWidth, setPenWidth] = useState<number>(PEN_WIDTH.initial);
  const [eraserSize, setEraserSize] = useState<EraserSize>('medium');

  const status = paper?.status;
  const extractionVersion = paper?.extractionVersion;
  useEffect(() => {
    if (session.getState().paperKey === paperKey) {
      session.reload();
      return;
    }
    session.enter(paperKey);
    setMode('select');
  }, [session, paperKey, status, extractionVersion]);

  useEffect(() => {
    const notice = state.notice;
    if (notice === '' || LASTING_NOTICES.includes(notice)) return;
    const timer = window.setTimeout(() => session.clearNotice(notice), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [session, state.notice]);

  const actions = useMemo(() => ({
    create: (inputs: AnnotationInput[]) => session.create(inputs),
    startMemo: (inputs: AnnotationInput[], anchor: CardAnchor) => session.startMemo(inputs, anchor),
    open: (highlight: Highlight) => session.open(highlight.highlightId, null),
    erase: (highlightId: string) => session.erase(highlightId),
    undoErase: () => session.undoErase(),
    reload: () => session.reload(),
    dropTranslation: (paperKey: string) => session.dropTranslation(paperKey),
    setMemoText: (text: string) => session.setMemoText(text),
    saveMemo: () => session.saveMemo(),
    editMemo: () => session.editMemo(),
    closeCard: () => session.closeCard(),
    deleteMemo: () => session.deleteMemo(),
    deleteRecord: () => session.deleteRecord(),
    recolor: (color: Highlight['color']) => session.recolor(color),
  }), [session]);

  // Drawn before they are records: highlighter sweeps on their way, and a new memo's selection.
  const drafts = useMemo(() => [...state.pending, ...(state.card?.kind === 'new' ? state.card.inputs : [])], [state.pending, state.card]);

  const toolbarProps: Omit<AnnotationToolbarProps, 'notebookOpen' | 'onToggleNotebook'> = {
    mode, onModeChange: setMode,
    highlighterColor, onHighlighterColorChange: setHighlighterColor,
    highlighterThickness, onHighlighterThicknessChange: setHighlighterThickness,
    penColor, onPenColorChange: setPenColor,
    penWidth, onPenWidthChange: setPenWidth,
    eraserSize, onEraserSizeChange: setEraserSize,
    erasedCount: state.erased.length, restoring: state.restoring, onUndoErase: actions.undoErase,
    notice: state.notice,
  };

  const paneProps: AnnotationPaneProps = {
    highlights: state.highlights,
    drafts,
    annotationMode: mode,
    highlighterColor, highlighterThickness, penColor, penWidth,
    annotationEraserSize: eraserSize,
    onCreateAnnotations: actions.create,
    onStartMemo: actions.startMemo,
    onOpenHighlight: actions.open,
    onEraseAnnotation: actions.erase,
  };

  const card = state.card;
  // A card is a new mount for each record and each new selection, so it opens at its own mark.
  const memoCard: { key: string; props: Omit<MemoCardViewProps, 'onAsk'> } | null = card === null ? null : {
    key: card.kind === 'record' ? `record:${card.highlightId}` : `new:${card.anchor?.left}:${card.anchor?.top}`,
    props: {
      card,
      record: card.kind === 'record' ? state.highlights.find((h) => h.highlightId === card.highlightId) ?? null : null,
      onText: actions.setMemoText,
      onSave: actions.saveMemo,
      onEdit: actions.editMemo,
      onClose: actions.closeCard,
      onDeleteMemo: actions.deleteMemo,
      onDeleteRecord: actions.deleteRecord,
      onRecolor: actions.recolor,
    },
  };

  return { highlights: state.highlights, setMode, reload: actions.reload, dropTranslation: actions.dropTranslation, open: actions.open, toolbarProps, paneProps, memoCard };
}
