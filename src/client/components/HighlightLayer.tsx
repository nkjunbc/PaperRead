import type { JSX } from 'react';
import type { AnnotationInput, Highlight, InkPoint, Region } from '../../shared/contracts';

export const HIGHLIGHT_COLORS: readonly Highlight['color'][] = ['yellow', 'green', 'blue', 'pink'];
/** Edge's highlighter colours. Painted multiplied over the page, so the text stays black. */
export const HIGHLIGHT_FILLS: Record<Highlight['color'], string> = { yellow: '#fff066', green: '#7df066', blue: '#8fdef9', pink: '#f799d1' };
/** Edge's names for its highlighter colours. */
export const HIGHLIGHT_LABELS: Record<Highlight['color'], string> = { yellow: '노랑', green: '녹색', blue: '연한 파랑', pink: '분홍' };
/** Pen colours, from Edge's ink palette: strong enough to read as writing on a white page. */
export const INK_COLORS: Record<Highlight['color'], string> = { yellow: '#ffaa00', green: '#008055', blue: '#004de6', pink: '#b31564' };
export const INK_LABELS: Record<Highlight['color'], string> = { yellow: '노랑', green: '초록', blue: '파랑', pink: '분홍' };
export function inkPath(points: InkPoint[]): string { return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * 1000},${p.y * 1000}`).join(' '); }
/** A pen stroke's drawn width in pixels: its stored width is a share of the page width. */
export function inkPixels(width: number, pageWidth: number): number { return Math.round(width * pageWidth * 100) / 100; }

const placed = (rect: Region) => ({ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });

/** How the highlighter paints each line of a mark: over the whole line, or, set thinner, only in
 * the band along the line's bottom edge, `thickness` of its height. The line's own box stays
 * whole either way: a click, the memo card and the memo mark go by it. A mark with no colour is
 * a selection, painted by its class. */
function paint({ color, thickness }: Pick<AnnotationInput, 'color' | 'thickness'>): { fill: string | undefined; band: JSX.Element | null } {
  if (color === undefined) return { fill: undefined, band: null };
  if (thickness === undefined || thickness >= 1) return { fill: HIGHLIGHT_FILLS[color], band: null };
  return { fill: 'transparent', band: <span className="highlight-band" style={{ top: `${Math.round((1 - thickness) * 10000) / 100}%`, backgroundColor: HIGHLIGHT_FILLS[color] }} /> };
}

interface HighlightBoxProps {
  highlight: Highlight;
  onOpen(highlight: Highlight): void;
}

/** One saved highlight, a box per line. The boxes let the pointer through to the text beneath
 * (a drag that starts on a highlight still selects); a click is matched to them by the pane,
 * and the keyboard reaches the record through its first box. */
function HighlightBox({ highlight, onOpen }: HighlightBoxProps): JSX.Element {
  const { fill, band } = paint(highlight);
  return (
    <>
      {highlight.rects.map((rect, index) => (
        <button
          key={`${highlight.highlightId}-${index}`}
          type="button"
          className="highlight-box"
          data-highlight-id={highlight.highlightId}
          tabIndex={index === 0 ? 0 : -1}
          aria-hidden={index === 0 ? undefined : true}
          style={{ ...placed(rect), backgroundColor: fill }}
          aria-label={`하이라이트: ${highlight.text.slice(0, 40)}`}
          onClick={() => onOpen(highlight)}
        >{band}</button>
      ))}
    </>
  );
}

/** Edge's memo mark: a speech bubble at the top-left of the marked text. */
function MemoIcon({ highlight, onOpen }: HighlightBoxProps): JSX.Element {
  const rect = highlight.rects[0];
  const note = highlight.note ?? '';
  return (
    <button type="button" className="memo-icon" data-highlight-id={highlight.highlightId} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%` }} aria-label={`메모 열기: ${note.slice(0, 40)}`} title={note.slice(0, 200)} onClick={(event) => { event.stopPropagation(); onOpen(highlight); }}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M1.5 1.5h11v8h-7l-3.5 3v-3h-0.5z" fill="#fff066" stroke="#7f7833" strokeLinejoin="round" /></svg>
    </button>
  );
}

export interface HighlightLayerProps {
  /** This page's saved records, where they are drawn now. */
  highlights: Highlight[];
  /** This page's records not saved yet: sweeps waiting for the service, a new memo's selection. */
  drafts?: AnnotationInput[];
  /** The selection being made on this page, in the highlighter's colour while it paints. */
  preview?: AnnotationInput[];
  /** The page's drawn width in pixels: a pen stroke's width is a share of it. */
  pageWidth: number;
  onOpen(highlight: Highlight): void;
}

/** All highlights, memo marks and pen strokes of one page, positioned over the page box. */
export function HighlightLayer({ highlights, drafts = [], preview = [], pageWidth, onOpen }: HighlightLayerProps): JSX.Element {
  const ink = (highlight: Highlight | AnnotationInput, key: string, saved: Highlight | null) => (highlight.strokes ?? []).map((stroke, i) => (
    <path
      key={`${key}-${i}`}
      className={saved ? 'saved-ink' : undefined}
      data-highlight-id={saved?.highlightId}
      role={saved ? 'button' : undefined}
      tabIndex={saved ? 0 : undefined}
      aria-label={saved ? `${highlight.page}쪽 필기 열기` : undefined}
      d={inkPath(stroke.points)}
      stroke={INK_COLORS[highlight.color ?? 'blue']}
      strokeWidth={inkPixels(stroke.width, pageWidth)}
      vectorEffect="non-scaling-stroke"
      onClick={saved ? (e) => { e.stopPropagation(); onOpen(saved); } : undefined}
      onKeyDown={saved ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(saved); } } : undefined}
    />
  ));
  return (
    <>
      <div className="highlight-layer">
        {drafts.filter((draft) => draft.kind !== 'ink').flatMap((draft, d) => {
          const { fill, band } = paint(draft);
          return draft.rects.map((rect, i) => (
            <span key={`draft-${d}-${i}`} className={`highlight-box highlight-draft${draft.color ? '' : ' is-selection'}`} aria-hidden="true" style={{ ...placed(rect), backgroundColor: fill }}>{band}</span>
          ));
        })}
        {highlights.filter((highlight) => highlight.kind !== 'ink').map((highlight) => (
          <HighlightBox key={highlight.highlightId} highlight={highlight} onOpen={onOpen} />
        ))}
        {preview.flatMap((selection, s) => {
          const { fill, band } = paint(selection);
          return selection.rects.map((rect, i) => (
            <span key={`preview-${s}-${i}`} className={`highlight-box highlight-preview${selection.color ? '' : ' is-selection'}`} aria-hidden="true" style={{ ...placed(rect), backgroundColor: fill }}>{band}</span>
          ));
        })}
      </div>
      <svg className="annotation-ink-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="저장된 필기">
        {drafts.filter((draft) => draft.kind === 'ink').flatMap((draft, d) => ink(draft, `draft-${d}`, null))}
        {highlights.filter((highlight) => highlight.kind === 'ink').flatMap((highlight) => ink(highlight, highlight.highlightId, highlight))}
      </svg>
      {highlights.filter((highlight) => highlight.note !== null).map((highlight) => <MemoIcon key={`memo-${highlight.highlightId}`} highlight={highlight} onOpen={onOpen} />)}
    </>
  );
}

export default HighlightLayer;
