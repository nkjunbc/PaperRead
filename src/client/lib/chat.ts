import type { AppError, ChatMessage, Connection, Conversation, Paper } from '../../shared/contracts';

/** The longest question the composer sends, in characters. */
export const QUESTION_LIMIT = 8_000;
/** From this length the composer shows how much room is left. */
export const COUNTER_FROM = 7_000;
/** How often an answer that is still being written is re-read. */
export const CHAT_POLL_MS = 300;
/** A missed read is retried a little later each time, up to this long apart. */
export const CHAT_POLL_MAX_MS = 3_000;
/** After this many missed reads in a row the panel says the service is not answering. */
export const CHAT_POLL_TROUBLE_AFTER = 3;
/** A quoted passage longer than this is cut, so the question itself still fits. */
export const QUOTE_LIMIT = 3_000;
/** Distance from the bottom, in pixels, that still counts as "reading the latest". */
export const PINNED_SLACK_PX = 48;

/** Shown under the composer: what pressing send sends, and where. */
export const CHAT_SEND_HINT = '질문을 보내면 논문 전문과 질문이 Codex(ChatGPT 구독)로 전송됩니다.';

/** Starting points offered while the conversation is empty; picking one adds it to the composer. */
export const SUGGESTIONS: readonly string[] = [
  '이 논문의 핵심 기여를 정리해줘',
  '제안한 방법을 쉽게 설명해줘',
  '실험 결과에서 눈여겨볼 점은?',
  '한계와 후속 연구 방향은?',
];

// ---------------------------------------------------------------- composer

export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  altKey?: boolean;
  /** `KeyboardEvent.isComposing` of the native event. */
  isComposing: boolean;
  /** 229 while an IME owns the key, including the Enter that commits a Korean syllable. */
  keyCode: number;
}

/** True while an input method is still composing: that key belongs to the IME. */
export function imeOwnsKey(event: Pick<ComposerKey, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * What a key press in the composer does. Enter sends; Shift+Enter (and Alt+Enter) keep the
 * textarea's own behaviour, a new line. An Enter an IME is still composing with never sends —
 * in Korean it commits the last syllable, and sending then would drop or double it.
 */
export function composerKeyAction(event: ComposerKey): 'send' | 'default' {
  if (event.key !== 'Enter') return 'default';
  if (imeOwnsKey(event)) return 'default';
  if (event.shiftKey || event.altKey === true) return 'default';
  return 'send';
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The length readout near the limit, or null while there is plenty of room. */
export function questionCounter(length: number): { text: string; over: boolean } | null {
  if (length < COUNTER_FROM) return null;
  return { text: `${groupDigits(length)} / ${groupDigits(QUESTION_LIMIT)}`, over: length > QUESTION_LIMIT };
}

/** What the readout says: the count, and past the limit how much has to go. */
export function questionCounterLabel(length: number): string | null {
  const counter = questionCounter(length);
  if (counter === null) return null;
  return counter.over ? `${counter.text} · ${groupDigits(length - QUESTION_LIMIT)}자를 줄여 주세요` : counter.text;
}

/**
 * The composer after picking a suggested question. It goes under whatever is already written —
 * a quoted passage or a half-typed question is never thrown away — or fills an empty one.
 */
export function withSuggestion(draft: string, suggestion: string): string {
  const head = draft.replace(/\s+$/, '');
  return head.length === 0 ? suggestion : `${head}\n\n${suggestion}`;
}

// ------------------------------------------------------------------ quotes

/** A selection as one tidy passage: no stray spaces, at most one blank line in a row. */
export function normalizeSelection(text: string): string {
  const tidy = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy.length > QUOTE_LIMIT ? `${tidy.slice(0, QUOTE_LIMIT).trimEnd()}…` : tidy;
}

/**
 * The composer text after quoting `selected`: the passage as `> ` lines and a blank line to
 * write the question under. Whatever the reader had already written stays in front of it.
 */
export function insertQuote(draft: string, selected: string): string {
  const passage = normalizeSelection(selected);
  if (passage.length === 0) return draft;
  const quote = passage
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
  const head = draft.replace(/\s+$/, '');
  return head.length === 0 ? `${quote}\n\n` : `${head}\n\n${quote}\n\n`;
}

/** A question as the reader wrote it: `>` passages shown as quotes, the rest as their words. */
export function questionParts(text: string): { kind: 'quote' | 'text'; text: string }[] {
  const parts: { kind: 'quote' | 'text'; text: string }[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    const kind = quoted === null ? 'text' : 'quote';
    const value = quoted === null ? line : quoted[1];
    const last = parts[parts.length - 1];
    if (last !== undefined && last.kind === kind) last.text += `\n${value}`;
    else parts.push({ kind, text: value });
  }
  return parts.map((part) => ({ kind: part.kind, text: part.text.replace(/^\n+|\n+$/g, '') })).filter((part) => part.text.trim().length > 0);
}

// ------------------------------------------------------------------ status

export interface ChatBlock {
  message: string;
  /** 'account' when signing in from the account menu is the way forward. */
  action: 'account' | null;
}

/** Why a question cannot be sent right now, in the reader's words; null when it can. */
export function chatBlockedReason(input: { canMutate: boolean; connection: Connection | null; paper: Paper | null }): ChatBlock | null {
  const { canMutate, connection, paper } = input;
  if (!canMutate) return { message: '이 화면에서는 질문을 보낼 수 없습니다. 서비스가 알려준 주소로 다시 열어 주세요.', action: null };
  if (paper === null) return { message: '논문을 불러오는 중입니다.', action: null };
  if (paper.status === 'fetching' || paper.status === 'extracting') return { message: '원문 처리가 끝나면 질문할 수 있습니다.', action: null };
  if (paper.status !== 'ready' && paper.status !== 'partial') return { message: '이 논문은 본문을 읽어 내지 못해 질문할 수 없습니다.', action: null };
  if (connection === null) return { message: 'Codex 연결 상태를 확인하는 중입니다.', action: null };
  switch (connection.status) {
    case 'subscription':
      return connection.modelIds.length === 0 ? { message: '질문에 쓸 수 있는 모델이 없습니다.', action: null } : null;
    case 'signed_out':
      return { message: 'ChatGPT 구독으로 로그인하면 질문할 수 있습니다.', action: 'account' };
    case 'api_key':
      return { message: 'API 키 연결로는 질문하지 않습니다. ChatGPT 구독으로 로그인해 주세요.', action: 'account' };
    case 'missing':
      return { message: 'Codex CLI를 찾을 수 없습니다. 공식 Codex CLI를 설치한 뒤 다시 확인해 주세요.', action: null };
    case 'unavailable':
      return { message: 'Codex 연결을 지금 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', action: 'account' };
  }
}

/** A failure to answer, in the reader's words. */
export function chatErrorText(error: AppError): string {
  switch (error.code) {
    case 'AUTH_REQUIRED':
      return 'Codex 로그인이 풀렸습니다. 계정 메뉴에서 다시 로그인해 주세요.';
    case 'SUBSCRIPTION_REQUIRED':
      return '질문하려면 ChatGPT 구독으로 로그인해야 합니다.';
    case 'QUOTA':
      return '구독 사용 한도에 걸렸습니다. 한도가 다시 열릴 때까지 기다린 뒤 물어봐 주세요.';
    case 'MODEL_UNAVAILABLE':
      return '선택한 모델을 지금 쓸 수 없습니다. 다른 모델을 골라 다시 시도해 주세요.';
    case 'UNSAFE_RUNTIME':
      // Mostly reported after the turn started (a tool item mid-answer, files left behind): the
      // question and the paper may already have gone out, so this never claims they stayed here.
      return '안전하지 않은 실행이 감지되어 답변을 중단했습니다. 질문과 논문 본문은 이미 전송되었을 수 있습니다.';
    case 'TOO_LARGE':
      return '논문과 대화가 이 모델이 한 번에 읽을 수 있는 분량을 넘었습니다. 새 대화로 시작하거나 다른 모델로 물어봐 주세요.';
    case 'BUSY':
      return '이전 답변이 아직 끝나지 않았습니다.';
    default:
      return error.message.trim().length > 0 ? error.message : '답변을 받지 못했습니다.';
  }
}

/** Failures whose way forward is the account menu. */
export function needsAccount(error: AppError | null): boolean {
  return error !== null && (error.code === 'AUTH_REQUIRED' || error.code === 'SUBSCRIPTION_REQUIRED');
}

/**
 * The model a question goes to: the reader's pick in this panel, else the model the
 * conversation was last answered with (coming back to a paper continues on the same model and
 * so on the same official thread), else the toolbar's, else the first offered.
 */
export function effectiveModel(chosen: string, fallback: string, modelIds: readonly string[], continued: string | null = null): string {
  if (chosen !== '' && modelIds.includes(chosen)) return chosen;
  if (continued !== null && modelIds.includes(continued)) return continued;
  if (fallback !== '' && modelIds.includes(fallback)) return fallback;
  return modelIds[0] ?? '';
}

/** The model of the conversation's latest completed answer, or null when it has none. */
export function conversationModel(conversation: Conversation | null): string | null {
  if (conversation === null) return null;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role === 'assistant' && message.status === 'completed' && message.modelId !== null) return message.modelId;
  }
  return null;
}

export function lastAssistant(conversation: Conversation | null): ChatMessage | null {
  if (conversation === null) return null;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role === 'assistant') return message;
  }
  return null;
}

/** Failures whose way forward is something the reader does right here first — sign in, pick
 * another model — after which asking the same question again makes sense. A spent usage limit
 * is not one: nothing on this page reopens it, and a retry button beside it would only send the
 * paper out again to be refused. */
const RETRY_AFTER_ACTION: ReadonlySet<AppError['code']> = new Set(['AUTH_REQUIRED', 'SUBSCRIPTION_REQUIRED', 'MODEL_UNAVAILABLE']);

/**
 * Whether an answer may be asked again with one click. A stopped answer may. A failed one may
 * when the service called the failure retryable or the reader can clear its cause — never after
 * unsafe-runtime evidence, and never for a failure that asking again cannot fix now.
 */
export function canRetryAnswer(message: ChatMessage): boolean {
  if (message.status === 'canceled') return true;
  if (message.status !== 'failed') return false;
  const error = message.error;
  if (error === null) return true;
  if (error.code === 'UNSAFE_RUNTIME') return false;
  return error.retryable || RETRY_AFTER_ACTION.has(error.code);
}

/** The question to ask again when the last answer failed or was stopped and may be retried; null otherwise. */
export function retryQuestion(conversation: Conversation | null): string | null {
  if (conversation === null || conversation.answering) return null;
  const messages = conversation.messages;
  const last = messages[messages.length - 1];
  const before = messages[messages.length - 2];
  if (last === undefined || before === undefined || last.role !== 'assistant' || before.role !== 'user') return null;
  return canRetryAnswer(last) ? before.text : null;
}

/**
 * What the polite live region says when an answer stops growing — once per answer, never per
 * streamed piece. Null when nothing finished since `previous` was seen.
 */
export function answerAnnouncement(previous: { messageId: string; status: ChatMessage['status'] } | null, current: ChatMessage | null): string | null {
  if (previous === null || current === null || previous.messageId !== current.messageId) return null;
  if (previous.status !== 'answering' || current.status === 'answering') return null;
  switch (current.status) {
    case 'completed':
      return '답변을 받았습니다';
    case 'canceled':
      return '답변을 멈췄습니다';
    case 'failed':
      return '답변을 받지 못했습니다';
  }
}

/** Whether a scroll position is at (or within a small slack of) the bottom. */
export function isPinnedToBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= PINNED_SLACK_PX;
}

/**
 * Whether the list still follows the latest message after a scroll event. While a
 * "맨 아래로" glide is under way, its own in-between positions are not the reader leaving the
 * bottom: the list keeps following (new text included) until the glide gets there.
 */
export function followAfterScroll(atBottom: boolean, jumping: boolean): { pinned: boolean; jumpDone: boolean } {
  if (jumping) return { pinned: true, jumpDone: atBottom };
  return { pinned: atBottom, jumpDone: false };
}

export interface PollState {
  /** Milliseconds until the next read. */
  delay: number;
  /** Reads missed in a row. */
  misses: number;
}

export const POLL_START: PollState = { delay: CHAT_POLL_MS, misses: 0 };

/** The next read of an answer being written: back to the usual pace after a good read, a little
 * later after each missed one. */
export function nextPoll(state: PollState, ok: boolean): PollState {
  return ok ? POLL_START : { delay: Math.min(CHAT_POLL_MAX_MS, state.delay * 2), misses: state.misses + 1 };
}

/** Enough reads were missed in a row to tell the reader the service is not answering. */
export function pollInTrouble(state: PollState): boolean {
  return state.misses >= CHAT_POLL_TROUBLE_AFTER;
}
