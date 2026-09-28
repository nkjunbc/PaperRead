import type { Block, Connection, Job, JobState, Paper, PauseReason, Translation, Usage } from '../../shared/contracts';

/** What the reader is told about one paragraph's translation. */
export type BlockStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unsupported';

export interface TranslationState {
  status: BlockStatus;
  /** The translated text, only when there genuinely is one. */
  text: string | null;
  /** A short Korean explanation for failures; null otherwise. */
  message: string | null;
}

/**
 * Decide what to show for one block.
 *
 * A record whose `sourceHash` no longer matches the block belongs to an older
 * revision of that paragraph and is ignored rather than shown as current.
 * A "completed" record with no text is reported as a failure, because an empty
 * paragraph would silently look like a real translation.
 */
export function describeTranslationState(block: Block, translation: Translation | undefined): TranslationState {
  if (!block.translatable) return { status: 'unsupported', text: null, message: null };
  if (translation === undefined || translation.sourceHash !== block.sourceHash) {
    return { status: 'pending', text: null, message: null };
  }
  switch (translation.status) {
    case 'completed': {
      const text = typeof translation.text === 'string' ? translation.text : '';
      if (text.trim().length === 0) return { status: 'failed', text: null, message: '번역 결과를 읽을 수 없습니다.' };
      return { status: 'completed', text, message: null };
    }
    case 'failed':
      return { status: 'failed', text: null, message: translation.error?.message ?? '번역에 실패했습니다.' };
    case 'running':
      return { status: 'running', text: null, message: null };
    case 'unsupported':
      return { status: 'unsupported', text: null, message: null };
    default:
      return { status: 'pending', text: null, message: null };
  }
}

const BLOCK_STATUS_LABELS: Record<BlockStatus, string> = {
  pending: '번역 대기',
  running: '번역 중',
  completed: '번역 완료',
  failed: '번역 실패',
  unsupported: '번역 대상 아님',
};

export function blockStatusLabel(status: BlockStatus): string {
  return BLOCK_STATUS_LABELS[status];
}

export interface UsageLine {
  label: string;
  value: string;
}

/** Format a count that may be genuinely unknown. `0` is a real number; `null` is not. */
function countValue(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '확인 불가';
}

function limitWindow(value: unknown): { usedPercent: number | null } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const used = (value as Record<string, unknown>).usedPercent;
  return { usedPercent: typeof used === 'number' && Number.isFinite(used) ? used : null };
}

/**
 * The usage lines to display (spec R07).
 *
 * Only what the provider actually reported is shown. Unknown values read
 * "확인 불가" and are never rendered as 0, and nothing here is ever converted
 * into money.
 */
export function usageLines(usage: Usage | null | undefined): UsageLine[] {
  const value = usage ?? { inputTokens: null, outputTokens: null, limits: null, observedAt: null };
  const lines: UsageLine[] = [
    { label: '입력 토큰', value: countValue(value.inputTokens) },
    { label: '출력 토큰', value: countValue(value.outputTokens) },
  ];

  const limits = value.limits;
  if (limits !== null && typeof limits === 'object') {
    for (const [key, label] of [
      ['primary', '주 사용 구간'],
      ['secondary', '보조 사용 구간'],
    ] as const) {
      const window = limitWindow((limits as Record<string, unknown>)[key]);
      // Omit a window the provider reported without any measurable number.
      if (window === null || window.usedPercent === null) continue;
      lines.push({ label, value: `${window.usedPercent}% 사용` });
    }
  }

  lines.push({ label: '확인 시각', value: formatObservedTime(value.observedAt) ?? '확인 불가' });
  return lines;
}

const CONNECTION_LABELS: Record<Connection['status'], string> = {
  missing: '연결 없음 — 공식 CLI를 찾지 못했습니다',
  signed_out: '로그아웃 상태 — 로그인이 필요합니다',
  subscription: '구독 계정으로 연결됨',
  api_key: 'API 키로 연결됨',
  unavailable: '연결 확인 불가',
};

export function connectionLabel(connection: Connection): string {
  return CONNECTION_LABELS[connection.status];
}

/** Login help is offered only when the provider itself says we are not signed in. */
export function needsLoginHelp(connection: Connection): boolean {
  return connection.status === 'signed_out' || connection.status === 'missing';
}

const CONNECTION_SHORT_LABELS: Record<Connection['status'], string> = {
  missing: 'Codex 없음',
  signed_out: '로그인 필요',
  subscription: '구독 연결됨',
  api_key: 'API 키 연결',
  unavailable: '연결 확인 불가',
};

/** The account button's label: short enough for a top bar, never an enum name. */
export function connectionShortLabel(connection: Connection | null): string {
  return connection === null ? '연결 확인 중' : CONNECTION_SHORT_LABELS[connection.status];
}

export type ConnectionTone = 'ok' | 'off' | 'warn' | 'pending';

/** A colour class for the account indicator; the label above always accompanies it. */
export function connectionTone(connection: Connection | null): ConnectionTone {
  if (connection === null) return 'pending';
  if (connection.status === 'subscription') return 'ok';
  if (connection.status === 'signed_out') return 'off';
  return 'warn';
}

/**
 * Why a translation cannot be *started* right now, in the reader's words, or null when
 * it can. Reading a stored translation never needs an account; this gates sending only.
 */
export function translationBlockedReason(connection: Connection | null, paper: Paper | null): string | null {
  if (paper === null) return null;
  if (paper.status !== 'ready' && paper.status !== 'partial') return '원문 처리가 끝나면 번역할 수 있습니다.';
  if (connection === null) return 'Codex 연결 상태를 확인하는 중입니다.';
  switch (connection.status) {
    case 'subscription':
      return connection.modelIds.length === 0 ? '사용할 수 있는 번역 모델이 없습니다.' : null;
    case 'signed_out':
      return 'Codex 구독에 로그인해야 번역을 시작할 수 있습니다. 저장된 번역은 로그인 없이 읽을 수 있습니다.';
    case 'missing':
      return 'Codex CLI를 찾을 수 없습니다. 공식 Codex CLI를 설치한 뒤 다시 확인해 주세요.';
    case 'api_key':
      return 'API 키 연결로는 번역하지 않습니다. ChatGPT 구독으로 로그인해 주세요.';
    case 'unavailable':
      return 'Codex 연결을 지금 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.';
  }
}

/**
 * The subscription's own quota windows, as the provider reported them, for the account menu.
 * A window without a measurable percentage is omitted; nothing is estimated or priced.
 */
export function subscriptionUsageLines(limits: Connection['limits']): string[] {
  if (limits === null || typeof limits !== 'object') return [];
  const lines: string[] = [];
  for (const [key, label] of [
    ['primary', '주 사용 구간'],
    ['secondary', '보조 사용 구간'],
  ] as const) {
    const window = (limits as Record<string, unknown>)[key];
    if (window === null || typeof window !== 'object' || Array.isArray(window)) continue;
    const used = (window as Record<string, unknown>).usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resetsAt = (window as Record<string, unknown>).resetsAt;
    const reset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? formatObservedTime(new Date(resetsAt * 1000).toISOString()) : null;
    lines.push(`${label} ${used}% 사용${reset === null ? '' : ` · ${reset} 재설정`}`);
  }
  return lines;
}

/** A stored ISO time as the reader sees it, or null when the value is not a real time. */
export function formatObservedTime(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Preselect the provider's default model, never a model it did not offer. */
export function pickDefaultModel(connection: Connection): string | null {
  const models = connection.modelIds ?? [];
  if (models.length === 0) return null;
  const preferred = connection.defaultModelId;
  return preferred !== null && models.includes(preferred) ? preferred : models[0];
}

const PAPER_STATUS_LABELS: Record<Paper['status'], string> = {
  fetching: '원문을 가져오는 중입니다',
  extracting: '원문에서 문단을 뽑아내는 중입니다',
  ready: '읽을 준비가 되었습니다',
  // 'partial' is the common case for real papers with figures and tables.
  partial: '일부 쪽은 문단을 뽑지 못했지만 읽을 수 있습니다',
  unsupported: '이 PDF에서는 문단을 뽑을 수 없습니다',
  failed: '원문을 가져오지 못했습니다',
};

export function paperStatusLabel(paper: Paper): string {
  return PAPER_STATUS_LABELS[paper.status];
}

/** Why a paused job stopped, in the reader's words. A pause the user asked for needs no note. */
const PAUSE_REASON_NOTES: Record<Exclude<PauseReason, null>, string | null> = {
  user: null,
  auth: '로그인이 필요합니다',
  quota: '사용 한도에 걸렸습니다',
  network: '연결이 끊겼습니다',
  model_unavailable: '선택한 모델을 쓸 수 없습니다',
  interrupted: '앱이 다시 시작되었습니다',
  reextracted: '문단 인식이 바뀌어 새로 번역할 문단이 있습니다',
};

export function pauseReasonNote(reason: PauseReason): string | null {
  return reason === null ? null : PAUSE_REASON_NOTES[reason];
}

const JOB_STATE_LABELS: Record<JobState, string> = {
  idle: '시작 전',
  running: '번역 중',
  paused: '일시정지됨',
  completed: '번역 완료',
  completed_with_gaps: '번역 완료',
  failed: '번역 실패',
};

export function jobStateLabel(state: JobState, pauseReason: PauseReason): string {
  const note = state === 'paused' ? pauseReasonNote(pauseReason) : null;
  return note === null ? JOB_STATE_LABELS[state] : `${JOB_STATE_LABELS[state]} — ${note}`;
}

/** Translation progress is page-based: show active work, never a numeric ratio. */
export function translationProgressLabel(state: JobState, currentPage: number | null): string {
  if (state === 'running') return currentPage === null ? '번역 시작 준비 중' : `${currentPage}쪽 처리 중`;
  return state === 'completed' || state === 'completed_with_gaps' ? '번역 완료' : '';
}

export type { Job };
