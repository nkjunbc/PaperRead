import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import type { AnnotationMode, Block, Highlight, Translation } from '../../shared/contracts';
import { ANNOTATION_LAYOUT_EVENT, HIGHLIGHTER_THICKNESS, PEN_WIDTH, annotationSurface, annotationUnavailable } from '../lib/annotations';
import { HIGHLIGHT_COLORS, HIGHLIGHT_FILLS, HIGHLIGHT_LABELS, INK_COLORS, INK_LABELS, inkPixels } from './HighlightLayer';
import { ERASER_RADII, ERASER_SIZE_LABELS, type EraserSize } from '../lib/eraser';
import { keepsKeysToItself } from '../lib/find';
import '../annotations.css';

/** A Letter page drawn at 100%: the pen preview shows a stroke as thick as it is drawn there. */
const PREVIEW_PAGE_WIDTH = 816;
/** One wave across the menu, as Edge previews a stroke. */
const PREVIEW_WAVE = 'M10 24 C 38 2, 62 2, 94 24 S 150 46, 178 24';
/** The highlighter preview's stroke at the whole line's thickness. */
const PREVIEW_HIGHLIGHTER_WIDTH = 16;

/** The least room a tool's menu keeps from the window's edges. */
const WINDOW_MARGIN = 8;

/** Shortcut keys for the tools; Esc goes back to selecting. */
const TOOL_KEYS: Record<string, AnnotationMode> = { v: 'select', h: 'highlight', p: 'pen', e: 'erase' };

/** The tools' icons, as Edge draws them: the highlighter's tip and the pen's nib carry the
 * colour in use (the group's --tool-color). */
const TOOL_ICONS: Record<AnnotationMode, JSX.Element> = {
  select: <svg className="annotation-tool__icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2v10.5l2.7-2.5 1.8 4 1.7-.8-1.8-3.9h3.6z" /></svg>,
  highlight: <svg className="annotation-tool__icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 1.5h7v5.2l-1.2 1.8H5.7L4.5 6.7z" /><path className="annotation-tool__ink" d="M5.7 8.5h4.6v2.8l-4.6 3z" /></svg>,
  pen: <svg className="annotation-tool__icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.8h10" /><path className="annotation-tool__ink" d="M3.6 3.8h8.8L8 14.5z" /></svg>,
  erase: <svg className="annotation-tool__icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 2.2l4.6 4.6-6.4 6.4H4.6l-2.4-2.4zM5.4 6l4.6 4.6M7.4 13.2h6.4" /></svg>,
};

/** Keys pressed while writing, inside a dialog or an alert, or in the question panel belong there. */
function typingIn(target: EventTarget | null): boolean {
  return keepsKeysToItself(target) || (target instanceof Element && target.closest('[role="textbox"],.chat-dock') !== null);
}

/**
 * Close a floating panel on a press outside `root` or on Esc, while `open`. The panel hears an Esc
 * first (in the capture phase), before the find bar and the tool keys, and says it used it: one Esc
 * closes the panel and nothing else. An Esc in a box, an editor or another dialog is theirs.
 */
function useDismiss(root: RefObject<HTMLElement | null>, onClose: () => void, open: boolean, closeOnScroll = false): void {
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && root.current?.contains(target) === true;
    const press = (event: Event) => { if (!inside(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (keepsKeysToItself(event.target) && !inside(event.target)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('keydown', key, true);
    if (closeOnScroll) { document.addEventListener('scroll', onClose, true); window.addEventListener('resize', onClose); }
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [root, onClose, open, closeOnScroll]);
}

/** How far to move a tool's menu sideways to keep it inside the window: the pen's menu hangs
 * left from its ▾ as Edge's does, and here the ▾ sits near the window's left edge. */
function useInWindow(panel: RefObject<HTMLElement | null>): number {
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (box === undefined) return;
    const right = window.innerWidth - WINDOW_MARGIN;
    setShift(box.left < WINDOW_MARGIN ? WINDOW_MARGIN - box.left : box.right > right ? Math.max(WINDOW_MARGIN - box.left, right - box.right) : 0);
  }, [panel]);
  return shift;
}

interface SwatchesProps {
  colors: Record<Highlight['color'], string>;
  labels: Record<Highlight['color'], string>;
  chosen: Highlight['color'];
  onChoose(color: Highlight['color']): void;
}

function Swatches({ colors, labels, chosen, onChoose }: SwatchesProps): JSX.Element {
  return (
    <div className="annotation-swatches" role="group" aria-label="색">
      {HIGHLIGHT_COLORS.map((color) => (
        <button key={color} type="button" className="annotation-swatch" aria-label={labels[color]} aria-pressed={chosen === color} style={{ '--swatch': colors[color] } as CSSProperties} onClick={() => onChoose(color)} />
      ))}
    </div>
  );
}

export interface HighlighterMenuProps {
  color: Highlight['color'];
  onColorChange(color: Highlight['color']): void;
  /** The share of each marked line's height the highlighter paints. */
  thickness: number;
  onThicknessChange(thickness: number): void;
}

/** The highlighter's colours, as Edge's highlight menu shows them, and its thickness on a slider
 * as the pen's, with a preview stroke as thick as it paints. */
export function HighlighterMenu({ color, onColorChange, thickness, onThicknessChange }: HighlighterMenuProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const shift = useInWindow(panel);
  const filled = `${Math.round(((thickness - HIGHLIGHTER_THICKNESS.min) / (HIGHLIGHTER_THICKNESS.max - HIGHLIGHTER_THICKNESS.min)) * 100)}%`;
  return (
    <div ref={panel} className="annotation-tool-menu annotation-tool-menu--highlighter" style={{ '--filled': filled, translate: shift === 0 ? undefined : `${shift}px 0` } as CSSProperties} role="dialog" aria-label="형광펜 색과 두께">
      <h3>색</h3>
      <Swatches colors={HIGHLIGHT_FILLS} labels={HIGHLIGHT_LABELS} chosen={color} onChoose={onColorChange} />
      <svg className="annotation-tool-preview" viewBox="0 0 188 48" aria-hidden="true"><path className="annotation-tool-preview__line" d={PREVIEW_WAVE} stroke={HIGHLIGHT_FILLS[color]} strokeWidth={Math.round(PREVIEW_HIGHLIGHTER_WIDTH * thickness * 10) / 10} /></svg>
      <h3>두께</h3>
      <input type="range" aria-label="두께" min={HIGHLIGHTER_THICKNESS.min} max={HIGHLIGHTER_THICKNESS.max} step={HIGHLIGHTER_THICKNESS.step} aria-valuetext={`줄 높이의 ${Math.round(thickness * 100)}%`} value={thickness} onChange={(event) => onThicknessChange(Math.round(Number(event.target.value) * 10) / 10)} />
      <div className="annotation-tool-range-labels" aria-hidden="true"><span>가늘게</span><span>굵게</span></div>
    </div>
  );
}

export interface PenMenuProps {
  color: Highlight['color'];
  onColorChange(color: Highlight['color']): void;
  /** Thickness as a share of the page width. */
  width: number;
  onWidthChange(width: number): void;
}

/** The pen's colours and thickness, as Edge's ink menu shows them, with a preview stroke. */
export function PenMenu({ color, onColorChange, width, onWidthChange }: PenMenuProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const shift = useInWindow(panel);
  const pixels = inkPixels(width, PREVIEW_PAGE_WIDTH);
  // The slider's track is drawn dark up to the thumb, as Edge's is.
  const filled = `${Math.round(((width - PEN_WIDTH.min) / (PEN_WIDTH.max - PEN_WIDTH.min)) * 100)}%`;
  return (
    <div ref={panel} className="annotation-tool-menu annotation-tool-menu--pen" style={{ '--filled': filled, translate: shift === 0 ? undefined : `${shift}px 0` } as CSSProperties} role="dialog" aria-label="펜 색과 두께">
      <h3>색</h3>
      <Swatches colors={INK_COLORS} labels={INK_LABELS} chosen={color} onChoose={onColorChange} />
      <svg className="annotation-tool-preview" viewBox="0 0 188 48" aria-hidden="true"><path className="annotation-tool-preview__line" d={PREVIEW_WAVE} stroke={INK_COLORS[color]} strokeWidth={pixels} /></svg>
      <h3>두께</h3>
      <input type="range" aria-label="두께" min={PEN_WIDTH.min} max={PEN_WIDTH.max} step={PEN_WIDTH.step} aria-valuetext={`100% 배율에서 약 ${pixels}px`} value={width} onChange={(event) => onWidthChange(Number(event.target.value))} />
      <div className="annotation-tool-range-labels" aria-hidden="true"><span>가늘게</span><span>굵게</span></div>
    </div>
  );
}

export interface AnnotationToolbarProps {
  mode: AnnotationMode; onModeChange(mode: AnnotationMode): void;
  highlighterColor: Highlight['color']; onHighlighterColorChange(color: Highlight['color']): void;
  /** The share of each marked line's height the highlighter paints. */
  highlighterThickness: number; onHighlighterThicknessChange(thickness: number): void;
  penColor: Highlight['color']; onPenColorChange(color: Highlight['color']): void;
  /** The pen's thickness as a share of the page width. */
  penWidth: number; onPenWidthChange(width: number): void;
  eraserSize: EraserSize; onEraserSizeChange(size: EraserSize): void;
  notebookOpen: boolean; onToggleNotebook(): void;
  /** Pen strokes erased in this session that an undo can bring back. */
  erasedCount: number; restoring: boolean; onUndoErase(): void;
  /** What happened last ("저장했습니다" only once the service answered). */
  notice?: string;
}

const HINTS: Record<AnnotationMode, string> = {
  select: '글자를 끌어 선택하면 하이라이트·메모·질문',
  highlight: '칠할 줄을 끌면 바로 저장됩니다.',
  pen: '그린 필기는 자동 저장됩니다.',
  erase: '지울 펜 필기 위를 드래그하세요.',
};

/**
 * The reader's tools, as Edge lays them out: select, the highlighter and the pen each with a
 * menu for colour and thickness, the eraser, and the memo list. One tool is on at a time;
 * pressing the tool that is on, or Esc, goes back to selecting.
 */
export function AnnotationToolbar(props: AnnotationToolbarProps): JSX.Element {
  const { mode, onModeChange, eraserSize, onEraserSizeChange, notebookOpen, onToggleNotebook } = props;
  const [menu, setMenu] = useState<'highlight' | 'pen' | null>(null);
  // The open menu's tool group: a press on its own buttons is not a press outside the menu.
  const group = useRef<HTMLSpanElement | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(group, closeMenu, menu !== null);
  useEffect(() => { if (menu !== null && mode !== menu) setMenu(null); }, [menu, mode]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || typingIn(event.target)) return;
      const next = event.key === 'Escape' ? 'select' : TOOL_KEYS[event.key.toLowerCase()];
      if (next === undefined || (event.key === 'Escape' && mode === 'select')) return;
      event.preventDefault();
      onModeChange(next);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [mode, onModeChange]);
  const toggle = (tool: AnnotationMode) => onModeChange(mode === tool && tool !== 'select' ? 'select' : tool);
  const openMenu = (tool: 'highlight' | 'pen') => { if (mode !== tool) onModeChange(tool); setMenu((open) => (open === tool ? null : tool)); };

  return <div className="annotation-toolbar" role="toolbar" aria-label="읽기와 기록 도구">
    <div className="annotation-mode-group">
      <button type="button" aria-pressed={mode === 'select'} aria-keyshortcuts="V" title="선택 (V) · 글자를 끌어 선택하면 하이라이트·메모·질문" onClick={() => toggle('select')}>{TOOL_ICONS.select}선택</button>
      <span ref={menu === 'highlight' ? group : undefined} className={`annotation-tool${mode === 'highlight' ? ' is-on' : ''}`} style={{ '--tool-color': HIGHLIGHT_FILLS[props.highlighterColor] } as CSSProperties}>
        <button type="button" aria-pressed={mode === 'highlight'} aria-keyshortcuts="H" title="형광펜 (H) · 끈 줄을 바로 칠합니다, Esc로 선택" onClick={() => toggle('highlight')}>{TOOL_ICONS.highlight}형광펜</button>
        <span className="annotation-tool__anchor">
          <button type="button" className="annotation-tool__more" aria-label="형광펜 색과 두께 고르기" aria-haspopup="dialog" aria-expanded={menu === 'highlight'} onClick={() => openMenu('highlight')}><svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg></button>
          {menu === 'highlight' ? <HighlighterMenu color={props.highlighterColor} onColorChange={props.onHighlighterColorChange} thickness={props.highlighterThickness} onThicknessChange={props.onHighlighterThicknessChange} /> : null}
        </span>
      </span>
      <span ref={menu === 'pen' ? group : undefined} className={`annotation-tool${mode === 'pen' ? ' is-on' : ''}`} style={{ '--tool-color': INK_COLORS[props.penColor] } as CSSProperties}>
        <button type="button" aria-pressed={mode === 'pen'} aria-keyshortcuts="P" title="펜 (P) · 마우스나 펜으로 필기, Esc로 선택" onClick={() => toggle('pen')}>{TOOL_ICONS.pen}펜</button>
        <span className="annotation-tool__anchor">
          <button type="button" className="annotation-tool__more" aria-label="펜 색과 두께 고르기" aria-haspopup="dialog" aria-expanded={menu === 'pen'} onClick={() => openMenu('pen')}><svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg></button>
          {menu === 'pen' ? <PenMenu color={props.penColor} onColorChange={props.onPenColorChange} width={props.penWidth} onWidthChange={props.onPenWidthChange} /> : null}
        </span>
      </span>
      <button type="button" aria-pressed={mode === 'erase'} aria-keyshortcuts="E" title="지우개 (E) · 펜 필기만 지웁니다. 하이라이트와 메모는 각자의 메뉴에서 지웁니다." onClick={() => toggle('erase')}>{TOOL_ICONS.erase}지우개</button>
    </div>
    {mode === 'erase' ? <div className="annotation-eraser-sizes" role="group" aria-label="지우개 크기">
      {(Object.keys(ERASER_RADII) as EraserSize[]).map((size) => <button key={size} type="button" aria-label={`지우개 ${ERASER_SIZE_LABELS[size]}`} aria-pressed={eraserSize === size} title={`지름 ${ERASER_RADII[size]*2}px · 닿는 필기선을 지웁니다`} onClick={() => onEraserSizeChange(size)}><i aria-hidden="true" style={{width:Math.sqrt(ERASER_RADII[size])*3,height:Math.sqrt(ERASER_RADII[size])*3}}/>{ERASER_SIZE_LABELS[size]}</button>)}
    </div> : null}
    {props.erasedCount > 0 ? <button type="button" className="annotation-undo" disabled={props.restoring} onClick={props.onUndoErase}>{props.restoring ? '되돌리는 중…' : '지운 필기 되돌리기'}</button> : null}
    <span className="annotation-save-status" role="status">{props.notice || HINTS[mode]}</span>
    <button type="button" className="annotation-notebook-toggle" aria-pressed={notebookOpen} onClick={onToggleNotebook}>메모 모음</button>
  </div>;
}

export interface SelectionMenuProps {
  text: string;
  /** Where the press that finished the selection was let go, in viewport pixels. */
  position: { left: number; top: number };
  onHighlight(color: Highlight['color']): void;
  onMemo(): void;
  onAsk?(): void;
  onClose(): void;
}

/** What a finished selection offers, as Edge's selection menu does: a highlight in one of the
 * highlighter's colours, a memo, a quote for a question about the paper, and a copy. */
export function SelectionMenu({ text, position, onHighlight, onMemo, onAsk, onClose }: SelectionMenuProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useDismiss(root, onClose, true, true);
  const left = typeof window === 'undefined' ? position.left : Math.max(8, Math.min(position.left, window.innerWidth - 248));
  const top = typeof window === 'undefined' ? position.top : Math.max(8, Math.min(position.top + 8, window.innerHeight - 190));
  return <div ref={root} role="toolbar" aria-label="선택한 부분" aria-orientation="vertical" className="annotation-selection-menu" style={{ left, top }}
    onMouseDown={(event) => event.preventDefault()}>
    <div className="annotation-selection-menu__colors" role="group" aria-label="하이라이트">
      <span aria-hidden="true">하이라이트</span>
      {HIGHLIGHT_COLORS.map((color) => <button key={color} type="button" className="annotation-swatch" aria-label={`${HIGHLIGHT_LABELS[color]} 하이라이트`} style={{ '--swatch': HIGHLIGHT_FILLS[color] } as CSSProperties} onClick={() => onHighlight(color)} />)}
    </div>
    <button type="button" onClick={onMemo}>메모 달기</button>
    {onAsk !== undefined ? <button type="button" onClick={onAsk}>질문에 인용</button> : null}
    <button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? '복사됨' : '복사'}</button>
  </div>;
}

export interface AnnotationNotebookProps {
  highlights: Highlight[]; onOpen(highlight: Highlight): void; onClose(): void;
  onNavigate?(highlight: Highlight): void; translations?: Translation[]; blocks: Block[];
  /** The job's model (null without a job): a note is checked against the translation the page shows. */
  modelId: string | null;
}

export function AnnotationNotebook({ highlights, onOpen, onClose, onNavigate, translations = [], blocks, modelId }: AnnotationNotebookProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [surface, setSurface] = useState<'all'|'original'|'translation'>('all');
  const [renderedLayouts,setRenderedLayouts]=useState<Map<number,string>>(new Map());
  useEffect(()=>{
    const measure=()=>{
      const layouts=new Map<number,string>();
      for(const page of document.querySelectorAll<HTMLElement>('.kr-page[data-annotation-layout-signature]')) layouts.set(Number(page.dataset.page),page.dataset.annotationLayoutSignature!);
      setRenderedLayouts(layouts);
    };
    measure();
    document.addEventListener(ANNOTATION_LAYOUT_EVENT,measure);
    return()=>document.removeEventListener(ANNOTATION_LAYOUT_EVENT,measure);
  },[]);
  const entries = useMemo(() => highlights.filter((h) => (surface === 'all' || annotationSurface(h) === surface) && `${h.text} ${h.note ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt)), [highlights, query, surface]);
  return <aside className="annotation-notebook" aria-label="메모 모음" onKeyDown={(e) => { if(e.key === 'Escape' && !e.nativeEvent.isComposing) {e.preventDefault();e.stopPropagation();onClose();} }}>
    <header><div><h2>메모 모음</h2><span>{highlights.length}개 기록</span></div><button type="button" aria-label="메모 모음 닫기" onClick={onClose}>×</button></header>
    <div className="annotation-notebook-filters">
      <input type="search" aria-label="메모 검색" placeholder="선택한 글·메모 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div role="group" aria-label="기록 지면"><button type="button" aria-pressed={surface === 'all'} onClick={() => setSurface('all')}>전체</button><button type="button" aria-pressed={surface === 'original'} onClick={() => setSurface('original')}>원문</button><button type="button" aria-pressed={surface === 'translation'} onClick={() => setSurface('translation')}>번역</button></div>
    </div>
    <div className="annotation-notebook-list">
      {entries.length === 0 ? <p className="annotation-empty">{highlights.length === 0 ? '두 지면에서 글자를 선택해 메모하거나, 펜으로 바로 필기하세요.' : '일치하는 기록이 없습니다.'}</p> : entries.map((h) => {
        const unavailable = annotationUnavailable(h, translations, blocks, renderedLayouts.get(h.page), modelId);
        return <article key={h.highlightId} className={`annotation-entry annotation-${h.color}`}>
          <div className="annotation-entry-heading"><button type="button" onClick={() => onNavigate?.(h)}>{h.page}쪽 · {annotationSurface(h) === 'translation' ? '번역' : '원문'}</button><span>{h.kind === 'ink' ? '필기' : h.note ? '메모' : '하이라이트'}</span></div>
          {h.kind !== 'ink' ? <blockquote>{h.text}</blockquote> : null}
          {h.note ? <p>{h.note}</p> : null}
          {unavailable ? <small>{h.kind==='ink'?'번역 내용이나 글꼴·줄바꿈이 바뀌어 필기를 숨겼습니다. 메모는 보관됩니다.':'번역이 바뀌어 지면의 위치를 확인할 수 없습니다. 기록은 보관됩니다.'}</small> : null}
          {!unavailable&&h.surface==='translation'&&h.kind==='ink' ? <small>작성 당시의 글꼴과 줄바꿈이 유지되는 지면에 표시합니다.</small> : null}
          <button type="button" className="annotation-edit" onClick={() => onOpen(h)}>{h.kind === 'ink' ? '색상·삭제' : `${h.note ? '메모 편집' : '메모 추가'} · 색상·삭제`}</button>
        </article>;
      })}
    </div>
  </aside>;
}
