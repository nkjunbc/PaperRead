import type { Job, Paper } from '../../shared/contracts';

/** Bounds for the reader's own controls, kept in one place so UI and tests agree. */
export const CONTROL_LIMITS = {
  zoom: { min: 0.5, max: 4, step: 0.25 },
  split: { min: 0.2, max: 0.8, step: 0.02 },
} as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampZoom(value: number): number {
  return clamp(value, CONTROL_LIMITS.zoom.min, CONTROL_LIMITS.zoom.max, 1);
}

export function clampSplit(value: number): number {
  return clamp(value, CONTROL_LIMITS.split.min, CONTROL_LIMITS.split.max, 0.5);
}

/**
 * Below this width the reader shows one pane at a time beside the docked question panel. Two
 * panes in less room each fit their page to under ~550 px, and the Korean page's text — which
 * scales with the page — drops to 5–7 px on a laptop screen.
 */
export const TWO_PANES_BESIDE_CHAT_MIN = 1_100;

/** Whether the reader, `readerWidth` wide, switches to one pane because the panel is docked beside it. */
export function onePaneBesideChat(readerWidth: number | null, chatDocked: boolean): boolean {
  return chatDocked && readerWidth !== null && readerWidth > 0 && readerWidth < TWO_PANES_BESIDE_CHAT_MIN;
}

/** The longest gap between the two clicks of a double-click a Korean paragraph waits out. */
export const DOUBLE_CLICK_MS = 400;

/**
 * How long a jump from a Korean paragraph to the original waits. With both panes on screen it
 * goes at once. When only the Korean pane is shown, the jump hides it, so a click on its text
 * first waits out a possible second click: a double-click there selects a word to quote, and
 * its second click would otherwise land on the original page.
 */
export function paragraphJumpDelay(via: 'text' | 'control', originalShown: boolean): number {
  return via === 'text' && !originalShown ? DOUBLE_CLICK_MS : 0;
}

/** Move by `delta` pages without ever leaving the document. */
export function nextPage(current: number, delta: number, pageCount: number): number {
  const last = Math.max(1, pageCount);
  return clamp(Math.round(current + delta), 1, last, 1);
}

/** A paper can be read as soon as its text was extracted, gaps and all. */
export function isReadable(status: Paper['status']): boolean {
  return status === 'ready' || status === 'partial';
}

export interface JobControls {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
}

/** Which lifecycle buttons are live for the current job (spec R05). */
export function jobControls(job: Job | null, readable: boolean): JobControls {
  const state = job?.state ?? null;
  const finished = state === 'completed' || state === 'completed_with_gaps';
  return {
    canStart: readable && (state === null || state === 'idle'),
    canPause: state === 'running',
    canResume: readable && (state === 'paused' || state === 'failed'),
    // Stored data can always be removed, even mid-run.
    canDelete: true,
    ...(finished ? { canStart: false, canResume: false } : {}),
  };
}

export type ControlName = 'start' | 'pause' | 'resume' | 'delete';

/** The API call behind each control, so the wiring is checkable without a DOM. */
export function controlAction(name: ControlName): { method: 'POST' | 'DELETE'; kind: 'translation' | 'pause' | 'resume' | 'paper' } {
  switch (name) {
    case 'start':
      return { method: 'POST', kind: 'translation' };
    case 'pause':
      return { method: 'POST', kind: 'pause' };
    case 'resume':
      return { method: 'POST', kind: 'resume' };
    default:
      return { method: 'DELETE', kind: 'paper' };
  }
}

/**
 * Keep refreshing only while something is genuinely still moving: acquisition
 * in the background, or a running translation job.
 */
export function shouldPoll(paperStatus: Paper['status'], jobState: Job['state'] | null): boolean {
  if (paperStatus === 'fetching' || paperStatus === 'extracting') return true;
  return jobState === 'running';
}
