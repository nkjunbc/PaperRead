/** The two reading panes. */
export type Pane = 'source' | 'translation';

/**
 * How long a pane stays "ours" after we scrolled it programmatically.
 *
 * Long enough to swallow the browser's smooth-scroll echo, short enough that
 * the reader taking over the other pane feels immediate.
 */
export const SUPPRESS_MS = 220;

export interface LinkState {
  enabled: boolean;
  /** The pane the reader is currently driving, or null when nobody is. */
  leader: Pane | null;
  /** The pane we last scrolled ourselves, and until when its events are ours. */
  suppressed: { pane: Pane; until: number } | null;
}

/** Why a scroll event did not drive the other pane. */
export type BlockReason = 'disabled' | 'programmatic' | 'not-leader';

export interface FollowDecision {
  follow: boolean;
  /** The pane to move, when following. */
  target: Pane | null;
  /** Why we are not following, when we are not. */
  reason: BlockReason | null;
}

/** The vertical extent of one page in a scrolling pane. */
export interface PageBoundary {
  page: number;
  top: number;
  bottom: number;
}

/** Space between page cards, matching the reader stylesheet. */
export const PAGE_GAP = 16;
/** Top padding inside a pane body, matching the reader stylesheet. */
export const PAGE_TOP_INSET = 12;

/**
 * Build page boundaries from measured Korean page heights. Pages that are not
 * mounted yet use the caller's normal rendered-page height until measured.
 */
export function pageBoundaries(pageCount: number, heightForPage: (page: number) => number, gap = PAGE_GAP, top = PAGE_TOP_INSET): PageBoundary[] {
  const boundaries: PageBoundary[] = [];
  let offset = top;
  for (let page = 1; page <= Math.max(0, pageCount); page += 1) {
    const measured = heightForPage(page);
    const height = Number.isFinite(measured) && measured > 0 ? measured : 1;
    boundaries.push({ page, top: offset, bottom: offset + height });
    offset += height + gap;
  }
  return boundaries;
}

/** Top offset for a page boundary, or zero when the page is unavailable. */
export function pageTop(page: number, boundaries: readonly PageBoundary[]): number {
  return boundaries.find((boundary) => boundary.page === page)?.top ?? 0;
}

/** One page's box in a scrolling pane, in the pane's scroll coordinates. */
export interface PageBox {
  page: number;
  top: number;
  height: number;
}

/** Where the top of a pane falls: which page, and how far into it as a share of its height. */
export interface PagePosition {
  page: number;
  fraction: number;
}

/**
 * The reader's place in a pane, independent of zoom: the page whose top has scrolled past the
 * top of the pane and how far into it the pane's top sits. Null at the very top of the
 * document, above the first page, where there is nothing to keep.
 */
export function positionInPages(boxes: readonly PageBox[], scrollTop: number): PagePosition | null {
  const pages = boxes.filter((box) => Number.isFinite(box.top) && Number.isFinite(box.height) && box.height > 0).sort((a, b) => a.top - b.top);
  const first = pages[0];
  if (first === undefined || !Number.isFinite(scrollTop) || scrollTop <= first.top) return null;
  let current = first;
  for (const box of pages) {
    if (box.top > scrollTop) break;
    current = box;
  }
  return { page: current.page, fraction: Math.min(1, (scrollTop - current.top) / current.height) };
}

/** The scroll position that puts `position` back at the top of a pane laid out as `boxes`. */
export function scrollTopForPosition(position: PagePosition, boxes: readonly PageBox[]): number | null {
  const box = boxes.find((candidate) => candidate.page === position.page);
  if (box === undefined || !Number.isFinite(box.top) || !Number.isFinite(box.height)) return null;
  return Math.max(0, box.top + position.fraction * box.height);
}

/** Convert a descendant's viewport top into its scroll container's coordinates. */
export function scrollTopForDescendant(descendantViewportTop: number, containerViewportTop: number, containerScrollTop: number): number {
  return Math.max(0, descendantViewportTop - containerViewportTop + containerScrollTop);
}

/**
 * One place both panes show the same content — a page's top or bottom edge, or where a
 * paragraph, figure or equation starts — each in its own pane's scroll coordinates.
 */
export interface ScrollAnchor {
  source: number;
  translation: number;
}

/**
 * The anchors both panes agree on, in reading order. Sorted by source position, the Korean
 * positions may not run backwards: on a two-column page a right-column paragraph can sit
 * higher on the Korean page than a left-column one that sits below it on the original. Nor
 * may two anchors share a position in either pane — the two columns of a Korean row start at
 * the same height — or the other pane would stand still and then rush. The longest run that
 * rises strictly in both panes is kept, so mapping either way is continuous and monotonic,
 * and scrolling one pane never pulls the other one back up.
 */
export function orderedAnchors(anchors: readonly ScrollAnchor[]): ScrollAnchor[] {
  const sorted = anchors
    .filter((anchor) => Number.isFinite(anchor.source) && Number.isFinite(anchor.translation))
    // Anchors at the same source position are listed highest Korean position first, so a
    // strictly rising run can take at most one of them.
    .sort((a, b) => a.source - b.source || b.translation - a.translation);
  // Longest strictly rising run of Korean positions: the smallest tail of each run length,
  // and for each anchor the one before it in its best run.
  const tails: number[] = [];
  const previous: number[] = new Array(sorted.length).fill(-1);
  for (let i = 0; i < sorted.length; i += 1) {
    const value = sorted[i].translation;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[tails[mid]].translation < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const kept: ScrollAnchor[] = [];
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) kept.push(sorted[i]);
  return kept.reverse();
}

/**
 * Where `position` in pane `from` falls in the other pane, interpolated between the anchors
 * around it (as ordered by `orderedAnchors`). Beyond the first or last anchor the offset from
 * it is kept, so both panes move pixel for pixel there.
 */
export function mapScrollPosition(position: number, anchors: readonly ScrollAnchor[], from: Pane): number {
  if (anchors.length === 0 || !Number.isFinite(position)) return position;
  const key = (anchor: ScrollAnchor) => (from === 'source' ? anchor.source : anchor.translation);
  const value = (anchor: ScrollAnchor) => (from === 'source' ? anchor.translation : anchor.source);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (position <= key(first)) return value(first) + (position - key(first));
  if (position >= key(last)) return value(last) + (position - key(last));
  for (let i = 1; i < anchors.length; i += 1) {
    const before = anchors[i - 1];
    const after = anchors[i];
    if (position > key(after)) continue;
    const span = key(after) - key(before);
    if (span <= 0) return value(after);
    return value(before) + (value(after) - value(before)) * ((position - key(before)) / span);
  }
  return value(last);
}

/**
 * How far a pane must move so the reader's view stays put when one of its pages changes
 * height from `before` to `after` (a Korean page drawn over its placeholder, or re-laid out):
 * the whole change when the page lies above the top of the pane, the same share of it when
 * the reader is partway into that page, nothing when the page starts at or below the top.
 */
export function scrollShiftForResize(pageTop: number, before: number, after: number, scrollTop: number): number {
  if (![pageTop, before, after, scrollTop].every(Number.isFinite) || after === before || scrollTop <= pageTop) return 0;
  if (pageTop + before <= scrollTop) return after - before;
  return before > 0 ? (scrollTop - pageTop) * (after / before - 1) : 0;
}

export function createLinkState(enabled = true): LinkState {
  return { enabled, leader: null, suppressed: null };
}

function other(pane: Pane): Pane {
  return pane === 'source' ? 'translation' : 'source';
}

/** Turning the link off (or back on) drops any stale lead and suppression. */
export function setLinkEnabled(state: LinkState, enabled: boolean): LinkState {
  state.enabled = enabled;
  state.leader = null;
  state.suppressed = null;
  return state;
}

/**
 * Record that we are about to scroll `pane` ourselves. Events it emits for the
 * next `SUPPRESS_MS` are our own echo and must not drive the other pane back —
 * that feedback loop is exactly what makes linked panes oscillate.
 */
export function beginProgrammaticScroll(state: LinkState, pane: Pane, now: number, windowMs = SUPPRESS_MS): LinkState {
  state.suppressed = { pane, until: now + windowMs };
  return state;
}

/** Whether a scroll event on `pane` should drive the other pane, without recording anything. */
export function shouldFollow(state: LinkState, pane: Pane, now: number): FollowDecision {
  if (!state.enabled) return { follow: false, target: null, reason: 'disabled' };
  const suppressed = state.suppressed;
  if (suppressed !== null && suppressed.pane === pane && now < suppressed.until) {
    return { follow: false, target: null, reason: 'programmatic' };
  }
  // A pane that is not leading may only take over once the current leader's
  // programmatic window has expired; otherwise the echo would steal the lead.
  if (state.leader !== null && state.leader !== pane && suppressed !== null && now < suppressed.until) {
    return { follow: false, target: null, reason: 'not-leader' };
  }
  return { follow: true, target: other(pane), reason: null };
}

/**
 * Handle a scroll event from the browser. When the event is genuinely the
 * reader's, that pane takes the lead and the other one follows.
 */
export function onUserScroll(state: LinkState, pane: Pane, now: number): FollowDecision {
  const decision = shouldFollow(state, pane, now);
  if (!decision.follow) return decision;
  state.leader = pane;
  state.suppressed = null;
  return decision;
}
