import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AnnotationInput, AnnotationMode, Block, Highlight, Translation } from '../../shared/contracts';
import { ANNOTATION_LAYOUT_EVENT, annotationSurface, annotationUnavailable } from '../lib/annotations';
import { HIGHLIGHT_COLORS } from './HighlightLayer';
import { ERASER_RADII, ERASER_SIZE_LABELS, type EraserSize } from '../lib/eraser';
import '../annotations.css';

export const ANNOTATION_COLOR_LABELS: Record<Highlight['color'], string> = { yellow: '노랑', green: '초록', blue: '파랑', pink: '분홍' };

export interface AnnotationToolbarProps {
  mode: AnnotationMode; onModeChange(mode: AnnotationMode): void;
  color: Highlight['color']; onColorChange(color: Highlight['color']): void;
  notebookOpen: boolean; onToggleNotebook(): void;
  eraserSize?: EraserSize; onEraserSizeChange?(size: EraserSize): void;
}

export function AnnotationToolbar({ mode, onModeChange, color, onColorChange, notebookOpen, onToggleNotebook, eraserSize = 'medium', onEraserSizeChange }: AnnotationToolbarProps): JSX.Element {
  useEffect(() => {
    const shortcut = (event:KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      const next = ({v:'select',p:'pen',e:'erase'} as const)[event.key.toLowerCase() as 'v'|'p'|'e'];
      if (next) { event.preventDefault(); onModeChange(next); }
    };
    window.addEventListener('keydown',shortcut);
    return () => window.removeEventListener('keydown',shortcut);
  }, [onModeChange]);
  return <div className="annotation-toolbar" role="toolbar" aria-label="읽기와 기록 도구">
    <div className="annotation-mode-group">
      <button type="button" aria-pressed={mode === 'select'} aria-keyshortcuts="V" onClick={() => onModeChange('select')} title="선택 (V) · 글자를 선택해 하이라이트·메모·질문">선택</button>
      <button type="button" aria-pressed={mode === 'pen'} aria-keyshortcuts="P" onClick={() => onModeChange('pen')} title="펜 (P) · 마우스나 펜으로 필기, Esc로 선택 모드">펜</button>
      <button type="button" aria-pressed={mode === 'erase'} aria-keyshortcuts="E" onClick={() => onModeChange('erase')} title="지우개 (E) · 필기선과 연결된 메모도 지워집니다, Esc로 선택 모드">지우개</button>
    </div>
    {mode === 'erase' ? <div className="annotation-eraser-sizes" role="group" aria-label="지우개 크기">
      {(Object.keys(ERASER_RADII) as EraserSize[]).map((size) => <button key={size} type="button" aria-label={`지우개 ${ERASER_SIZE_LABELS[size]}`} aria-pressed={eraserSize === size} title={`지름 ${ERASER_RADII[size]*2}px · 닿는 필기선을 지웁니다`} onClick={() => onEraserSizeChange?.(size)}><i aria-hidden="true" style={{width:Math.sqrt(ERASER_RADII[size])*3,height:Math.sqrt(ERASER_RADII[size])*3}}/>{ERASER_SIZE_LABELS[size]}</button>)}
    </div> : <div className="annotation-palette" aria-label="기록 색상">
      {HIGHLIGHT_COLORS.map((c) => <button key={c} type="button" className={`annotation-swatch annotation-${c}`} aria-label={`${ANNOTATION_COLOR_LABELS[c]} 기록`} aria-pressed={color === c} onClick={() => onColorChange(c)} />)}
    </div>}
    <button type="button" aria-pressed={notebookOpen} onClick={onToggleNotebook}>메모 모음</button>
  </div>;
}

export interface SelectionToolbarProps {
  selection: AnnotationInput; position: { left: number; top: number }; color: Highlight['color'];
  onCreate(input: AnnotationInput, openNote?: boolean): void;
  onClose(): void; onAsk?(text: string): void;
}

export function SelectionToolbar({ selection, position, color, onCreate, onClose, onAsk }: SelectionToolbarProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const close = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', close, true); window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const create = (note: boolean) => { onCreate({ ...selection, color }, note); window.getSelection()?.removeAllRanges(); onClose(); };
  const left = typeof window === 'undefined' ? position.left : Math.max(12, Math.min(position.left, window.innerWidth - 338));
  const top = typeof window === 'undefined' ? position.top : Math.max(12, Math.min(position.top + 12, window.innerHeight - 62));
  return <div ref={root} role="toolbar" aria-label="선택한 부분 기록" className="annotation-selection-toolbar" style={{ left, top }}
    onPointerDown={(e) => { e.stopPropagation(); }} onMouseDown={(e) => e.preventDefault()} onClick={(e) => e.stopPropagation()}>
    <button type="button" onClick={() => create(false)}>하이라이트</button>
    <button type="button" onClick={() => create(true)}>메모</button>
    {onAsk ? <button type="button" onClick={() => { onAsk(selection.text); window.getSelection()?.removeAllRanges(); onClose(); }}>질문</button> : null}
    <button type="button" onClick={() => { void navigator.clipboard.writeText(selection.text).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '복사됨' : '복사'}</button>
    <button type="button" aria-label="선택 도구 닫기" onClick={onClose}>×</button>
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
  return <aside className="annotation-notebook" aria-label="메모 모음" onKeyDown={(e) => { if(e.key === 'Escape' && !e.nativeEvent.isComposing) {e.stopPropagation();onClose();} }}>
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
          <button type="button" className="annotation-edit" onClick={() => onOpen(h)}>{h.note ? '메모 편집' : '메모 추가'} · 색상·삭제</button>
        </article>;
      })}
    </div>
  </aside>;
}
