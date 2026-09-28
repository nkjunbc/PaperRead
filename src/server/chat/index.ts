import { createHash, randomUUID } from 'node:crypto';
import type { AppError, Block, ChatMessage, ChatUsage, Connection, Conversation, ErrorCode, Paper, PaperChat } from '../../shared/contracts';
import { AppErrorException, PaperStore, appError, busy, invalidInput, notFound, type ConversationRecord } from '../store/index';
import { MAX_ANSWER_CHARS, MAX_CHAT_MESSAGES, MAX_QUESTION_CHARS, isErrorCode } from '../store/validate';
import { isExcludedModel } from '../codex/index';
import { paperInstructions } from './paper-text';

export { paperInstructions, paperBody, PAPER_BODY_LIMIT, PAPER_CUT_NOTICE } from './paper-text';

/** What the service logs about a conversation: the action and its outcome, never a question,
 * an answer, the paper's text or the instructions built from it. `unsafe` records isolation
 * evidence the official path reported (UNSAFE_RUNTIME), also when the answer had already been
 * settled by a stop, a clear, a paper deletion or a logout. */
export interface ChatLogEvent {
  event: 'chat';
  action: 'ask' | 'answer' | 'cancel' | 'clear' | 'forget' | 'stop' | 'recover' | 'unsafe';
  paperKey: string;
  status?: ChatMessage['status'];
  code?: ErrorCode;
}

export interface ChatServiceOptions {
  store: PaperStore;
  /** The official program's question path. Never the account session. */
  chat: PaperChat;
  /** The live account and model catalogue, checked before anything is stored. */
  connection: () => Promise<Connection>;
  now?: () => Date;
  newId?: () => string;
  log?: (event: ChatLogEvent) => void;
}

/** A persisted question whose answer was lost with the process that was writing it. */
export const RESTARTED_ERROR: AppError = { code: 'NETWORK', message: '서비스가 다시 시작되어 답변이 중단되었습니다. 다시 물어볼 수 있습니다.', retryable: true };
/** A stored question this process never answered and did not find at startup (the file changed
 * underneath it). Not worded as a restart, because none happened. */
export const INTERRUPTED_ERROR: AppError = { code: 'NETWORK', message: '답변이 중단되었습니다. 다시 물어볼 수 있습니다.', retryable: true };
/** Logging out ends this app's official session; an answer on it cannot finish. */
export const LOGGED_OUT_ERROR: AppError = { code: 'AUTH_REQUIRED', message: '로그아웃되어 답변이 중단되었습니다. 다시 로그인한 뒤 다시 물어볼 수 있습니다.', retryable: true };
const EMPTY_ANSWER_ERROR: AppError = { code: 'NETWORK', message: '빈 답변을 받았습니다. 다시 물어볼 수 있습니다.', retryable: true };
const UNKNOWN_ERROR: AppError = { code: 'INTERNAL', message: '답변을 만드는 중 알 수 없는 오류가 발생했습니다.', retryable: false };

/** An answer being written. Its message is the only 'answering' message that exists anywhere;
 * it is never stored until it settles. */
interface Flight {
  conversationId: string;
  /** The stored question this answer follows. */
  questionId: string;
  controller: AbortController;
  message: ChatMessage;
  /** Set once the flight has been settled by anyone; a late completion is then ignored. */
  settled: boolean;
}

/** A settled answer that could not be written yet. It is shown from memory after its question
 * and written by the next save of the conversation; it never applies to anything else. */
interface Unsaved {
  conversationId: string;
  /** The stored question it answers, which must still be the conversation's last message. */
  afterMessageId: string;
  message: ChatMessage;
  /** Made up by a read for a question nothing here answered; written only by a request that
   * changes the conversation, never at shutdown (startup recovery settles it then). */
  placeholder: boolean;
}

function isUnsafe(cause: unknown): boolean {
  return toAppError(cause).code === 'UNSAFE_RUNTIME';
}

interface AskInput {
  question: string;
  modelId: string;
  retry: boolean;
}

function readAskRequest(body: unknown): AskInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidInput('요청 본문은 JSON 객체여야 합니다.');
  const b = body as Record<string, unknown>;
  if (typeof b.question !== 'string') throw invalidInput('질문을 입력해 주세요.');
  const question = b.question.trim();
  if (question.length === 0) throw invalidInput('질문을 입력해 주세요.');
  if (question.length > MAX_QUESTION_CHARS) throw invalidInput(`질문은 ${MAX_QUESTION_CHARS.toLocaleString('en-US')}자까지 보낼 수 있습니다.`);
  if (typeof b.modelId !== 'string') throw invalidInput('modelId 값은 문자열이어야 합니다.');
  const modelId = b.modelId.trim();
  if (modelId.length === 0) throw invalidInput('modelId 값이 비어 있습니다.');
  if (modelId.length > 100) throw invalidInput('modelId 값이 너무 깁니다.');
  if (b.retry !== undefined && typeof b.retry !== 'boolean') throw invalidInput('retry 값은 true 또는 false여야 합니다.');
  return { question, modelId, retry: b.retry === true };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reported counts only: an unreported count stays null, and nothing reported at all is null. */
function readUsage(usage: unknown): ChatUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Partial<ChatUsage>;
  const read: ChatUsage = { inputTokens: count(u.inputTokens), cachedInputTokens: count(u.cachedInputTokens), outputTokens: count(u.outputTokens) };
  return read.inputTokens === null && read.cachedInputTokens === null && read.outputTokens === null ? null : read;
}

/** The contract error a failure carries; anything else becomes a generic message, because a raw
 * cause can hold paths or paper text. */
function toAppError(cause: unknown): AppError {
  if (cause instanceof AppErrorException) return cause.error;
  const candidate = cause as Partial<AppError> | null;
  if (candidate && typeof candidate === 'object' && isErrorCode(candidate.code) && typeof candidate.message === 'string' && candidate.message.length > 0) {
    return { code: candidate.code, message: candidate.message.slice(0, 2000), retryable: candidate.retryable === true };
  }
  return UNKNOWN_ERROR;
}

/**
 * One question conversation per paper revision, answered by the official program through the
 * user's own subscription.
 *
 * Only settled messages are stored. The answer being written lives here, in memory, with the
 * text streamed so far. A question persisted without its answer (the process stopped while
 * answering) is settled as failed once, at startup (`recoverInterrupted`). Reading a
 * conversation never writes: an answer whose write failed is shown from memory and written by
 * the next save.
 */
export class ChatService {
  private readonly store: PaperStore;
  private readonly chat: PaperChat;
  private readonly connection: () => Promise<Connection>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (event: ChatLogEvent) => void;
  private readonly flights = new Map<string, Flight>();
  /** Papers whose question is between admission and its first write. */
  private readonly admitting = new Set<string>();
  /** The id a paper without a stored conversation will use, stable until something is stored. */
  private readonly freshIds = new Map<string, string>();
  /** Digest of the instructions each conversation's official thread was last given (memory only). */
  private readonly threadInstructions = new Map<string, string>();
  /** Settled answers whose write failed, per paper (see Unsaved). */
  private readonly unsaved = new Map<string, Unsaved>();

  constructor(options: ChatServiceOptions) {
    this.store = options.store;
    this.chat = options.chat;
    this.connection = options.connection;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.log = options.log ?? (() => {});
  }

  /** The paper's conversation, with the answer being written (if any) as its last message.
   * A read: nothing is written, whoever asks. */
  conversation(paperKey: string): Conversation {
    this.requirePaper(paperKey);
    return this.view(paperKey, this.load(paperKey));
  }

  /**
   * Startup, before the first request: a question stored without its answer lost that answer
   * with the previous process. Each one is settled as failed and written here, once, so no
   * read has to write it. Returns the paper keys recovered.
   */
  recoverInterrupted(): string[] {
    const recovered: string[] = [];
    let keys: string[];
    try {
      keys = this.store.listPapers();
    } catch {
      return recovered;
    }
    for (const paperKey of keys) {
      if (this.flights.has(paperKey)) continue;
      let stored: ConversationRecord | null;
      try {
        stored = this.store.getConversation(paperKey);
      } catch {
        continue;
      }
      const last = stored?.messages.at(-1);
      if (stored === null || last === undefined || last.role !== 'user') continue;
      const message = this.interruptedAnswer(RESTARTED_ERROR);
      try {
        this.store.saveConversation(paperKey, { conversationId: stored.conversationId, messages: [...stored.messages, message] });
        this.unsaved.delete(paperKey);
      } catch {
        // Shown from memory until the next save of this conversation writes it.
        this.unsaved.set(paperKey, { conversationId: stored.conversationId, afterMessageId: last.messageId, message, placeholder: false });
      }
      this.log({ event: 'chat', action: 'recover', paperKey, status: 'failed', code: RESTARTED_ERROR.code });
      recovered.push(paperKey);
    }
    return recovered;
  }

  /** Write every answer whose earlier write failed (service shutdown). Best effort. */
  flushUnsaved(): void {
    for (const [paperKey, unsaved] of [...this.unsaved]) if (!unsaved.placeholder) this.flush(paperKey);
  }

  /**
   * Store the question and start answering it in the background. Every refusal — input, model,
   * paper, a question already in flight, account, catalogue — happens before anything is stored
   * or sent.
   */
  async ask(paperKey: string, body: unknown): Promise<Conversation> {
    const request = readAskRequest(body);
    // The one predicate, at the entrance: a forbidden model never reaches the store or the thread.
    if (isExcludedModel(request.modelId)) throw appError('MODEL_UNAVAILABLE', '이 모델은 사용하지 않도록 설정되어 있습니다.', false);
    this.requireAskablePaper(paperKey);
    if (this.flights.has(paperKey) || this.admitting.has(paperKey)) throw busy('이전 질문에 아직 답하는 중입니다. 답변이 끝나거나 멈춘 뒤 다시 물어봐 주세요.');
    this.plan(paperKey, request);
    this.admitting.add(paperKey);
    try {
      await this.assertAccountReady(request.modelId);
    } finally {
      this.admitting.delete(paperKey);
    }

    // Re-read after the wait: the paper may have been deleted or the conversation cleared.
    const { paper, blocks } = this.requireAskablePaper(paperKey);
    if (this.flights.has(paperKey)) throw busy('이전 질문에 아직 답하는 중입니다. 답변이 끝나거나 멈춘 뒤 다시 물어봐 주세요.');
    const { conversationId, messages } = this.plan(paperKey, request);
    const history = completedExchanges(messages);
    const instructions = paperInstructions(paper, blocks);
    // Re-extraction changes the paper's text under a live conversation. Its thread was opened on
    // the old text; drop it so the question opens a new one on the new text, with the history.
    const digest = createHash('sha256').update(instructions, 'utf8').digest('hex');
    const previous = this.threadInstructions.get(conversationId);
    const stale = previous !== undefined && previous !== digest;
    const createdAt = this.now().toISOString();
    const question: ChatMessage = { messageId: this.newId(), role: 'user', text: request.question, status: 'completed', modelId: null, error: null, usage: null, createdAt };
    // `messages` came from load(): an answer whose write had failed is written with it now.
    const saved = this.store.saveConversation(paperKey, { conversationId, messages: [...messages, question] });
    this.unsaved.delete(paperKey);
    this.freshIds.delete(paperKey);
    this.threadInstructions.set(conversationId, digest);

    // No await between the stored question and the registered flight: a read in between would
    // otherwise show the question as interrupted.
    const flight: Flight = {
      conversationId,
      questionId: question.messageId,
      controller: new AbortController(),
      message: { messageId: this.newId(), role: 'assistant', text: '', status: 'answering', modelId: request.modelId, error: null, usage: null, createdAt },
      settled: false,
    };
    this.flights.set(paperKey, flight);
    this.log({ event: 'chat', action: 'ask', paperKey, status: 'answering' });
    void this.answer(paperKey, flight, { conversationId, modelId: request.modelId, instructions, history, question: request.question }, stale);
    return this.view(paperKey, saved);
  }

  /** Stop the answer being written. What was written so far is kept, marked as stopped. */
  cancel(paperKey: string): Conversation {
    this.requirePaper(paperKey);
    const flight = this.flights.get(paperKey);
    if (flight !== undefined) {
      this.settle(paperKey, flight, { ...flight.message, status: 'canceled', error: null, usage: null });
      flight.controller.abort();
      this.log({ event: 'chat', action: 'cancel', paperKey, status: 'canceled' });
    } else {
      this.flush(paperKey);
    }
    return this.conversation(paperKey);
  }

  /** Start over: drop the stored conversation, stop any answer and drop the official thread. The
   * next question uses a new conversation id, so it can never land on the dropped thread. The
   * stored conversation goes first: when that fails nothing has changed, and an answer being
   * written goes on instead of leaving its question unanswered. */
  clear(paperKey: string): Conversation {
    this.requirePaper(paperKey);
    const stored = this.store.getConversation(paperKey);
    this.store.deleteConversation(paperKey);
    const ids = this.stop(paperKey);
    if (stored !== null) ids.add(stored.conversationId);
    this.unsaved.delete(paperKey);
    for (const id of ids) this.forgetThread(paperKey, id);
    this.freshIds.set(paperKey, this.newId());
    this.log({ event: 'chat', action: 'clear', paperKey });
    return this.conversation(paperKey);
  }

  /** The paper is being deleted: stop its answer and drop its official thread. Call before the
   * paper's folder is removed, so the stored conversation id is still readable. The stopped
   * answer is written as stopped first, so a removal that then fails leaves a stopped answer
   * rather than a question without one. */
  forgetPaper(paperKey: string): void {
    const ids = new Set<string>();
    const flight = this.flights.get(paperKey);
    if (flight !== undefined) {
      this.settle(paperKey, flight, { ...flight.message, status: 'canceled', error: null, usage: null });
      flight.controller.abort();
      ids.add(flight.conversationId);
    }
    let stored: ConversationRecord | null = null;
    try {
      stored = this.store.getConversation(paperKey);
    } catch {
      stored = null;
    }
    if (stored !== null) ids.add(stored.conversationId);
    for (const id of ids) this.forgetThread(paperKey, id);
    this.freshIds.delete(paperKey);
    this.log({ event: 'chat', action: 'forget', paperKey });
  }

  /** Settle every answer being written with `error` (logout, service shutdown). */
  stopAll(error: AppError): void {
    for (const [paperKey, flight] of [...this.flights]) {
      this.settle(paperKey, flight, { ...flight.message, status: 'failed', error, usage: null });
      flight.controller.abort();
      this.log({ event: 'chat', action: 'stop', paperKey, status: 'failed', code: error.code });
    }
  }

  /** True while an answer is being written for the paper. */
  isAnswering(paperKey: string): boolean {
    return this.flights.has(paperKey);
  }

  // ---------------------------------------------------------------- internals

  private async answer(paperKey: string, flight: Flight, input: { conversationId: string; modelId: string; instructions: string; history: { question: string; answer: string }[]; question: string }, staleThread = false): Promise<void> {
    let settled: ChatMessage;
    try {
      if (staleThread) {
        const dropped = await Promise.resolve()
          .then(() => this.chat.forget(input.conversationId))
          .then(() => null, (cause: unknown) => cause);
        // Dropping the old thread is best effort, unless it turned up isolation evidence: then
        // this question is not asked at all.
        if (dropped !== null && isUnsafe(dropped)) throw dropped;
      }
      if (flight.settled) return;
      const output = await this.chat.ask({
        ...input,
        signal: flight.controller.signal,
        onText: (text) => {
          if (!flight.settled && typeof text === 'string') flight.message = { ...flight.message, text: text.slice(0, MAX_ANSWER_CHARS) };
        },
      });
      if (flight.settled) return;
      const text = typeof output?.text === 'string' ? output.text.slice(0, MAX_ANSWER_CHARS) : '';
      settled =
        text.trim().length === 0
          ? { ...flight.message, status: 'failed', error: EMPTY_ANSWER_ERROR, usage: null }
          : { ...flight.message, text, status: 'completed', error: null, usage: readUsage(output.usage) };
    } catch (cause) {
      const error = toAppError(cause);
      if (error.code === 'UNSAFE_RUNTIME') this.unsafe(paperKey, flight, error);
      if (flight.settled) return;
      settled = { ...flight.message, status: 'failed', error, usage: null };
    }
    this.settle(paperKey, flight, settled);
    this.log({ event: 'chat', action: 'answer', paperKey, status: settled.status, ...(settled.error ? { code: settled.error.code } : {}) });
  }

  /**
   * Isolation evidence the official path reported for this answer. It is always logged. An
   * answer already settled by a stop or a logout is marked with it where it was stored, so the
   * conversation does not show a plain stop; a cleared conversation or a deleted paper has
   * nothing left to mark.
   */
  private unsafe(paperKey: string, flight: Flight, error: AppError): void {
    this.log({ event: 'chat', action: 'unsafe', paperKey, code: 'UNSAFE_RUNTIME' });
    if (!flight.settled) return;
    const messageId = flight.message.messageId;
    const mark = (message: ChatMessage): ChatMessage => ({ ...message, status: 'failed', error, usage: null });
    const unsaved = this.unsaved.get(paperKey);
    if (unsaved !== undefined && unsaved.message.messageId === messageId) {
      unsaved.message = mark(unsaved.message);
      return;
    }
    try {
      const stored = this.store.getConversation(paperKey);
      if (stored === null || stored.conversationId !== flight.conversationId) return;
      const index = stored.messages.findIndex((message) => message.messageId === messageId);
      if (index < 0) return;
      const messages = [...stored.messages];
      messages[index] = mark(messages[index]!);
      this.store.saveConversation(paperKey, { conversationId: stored.conversationId, messages });
    } catch {
      /* the log line above is the record */
    }
  }

  /** Take the flight out of memory and append its settled answer, once. A conversation cleared
   * or a paper deleted meanwhile is not written to. An answer whose write fails is kept in
   * memory and written by the next save; it is never lost or reworded as a restart. */
  private settle(paperKey: string, flight: Flight, message: ChatMessage): void {
    if (flight.settled) return;
    flight.settled = true;
    if (this.flights.get(paperKey) === flight) this.flights.delete(paperKey);
    try {
      const stored = this.store.getConversation(paperKey);
      if (stored === null || stored.conversationId !== flight.conversationId) return;
      this.store.saveConversation(paperKey, { conversationId: stored.conversationId, messages: [...stored.messages, message] });
    } catch (cause) {
      this.unsaved.set(paperKey, { conversationId: flight.conversationId, afterMessageId: flight.questionId, message, placeholder: false });
      this.log({ event: 'chat', action: 'answer', paperKey, status: message.status, code: toAppError(cause).code });
    }
  }

  /** Write an answer whose earlier write failed, if it still follows the stored question. On
   * failure it stays in memory for the next try. */
  private flush(paperKey: string): void {
    const unsaved = this.unsaved.get(paperKey);
    if (unsaved === undefined || this.flights.has(paperKey)) return;
    try {
      const stored = this.store.getConversation(paperKey);
      const last = stored?.messages.at(-1);
      if (stored === null || stored.conversationId !== unsaved.conversationId || last?.messageId !== unsaved.afterMessageId) {
        this.unsaved.delete(paperKey);
        return;
      }
      this.store.saveConversation(paperKey, { conversationId: stored.conversationId, messages: [...stored.messages, unsaved.message] });
      this.unsaved.delete(paperKey);
    } catch {
      /* kept for the next save */
    }
  }

  /** Abort the paper's flight without writing anything; returns the conversation ids to forget. */
  private stop(paperKey: string): Set<string> {
    const ids = new Set<string>();
    const flight = this.flights.get(paperKey);
    if (flight !== undefined) {
      flight.settled = true;
      this.flights.delete(paperKey);
      flight.controller.abort();
      ids.add(flight.conversationId);
    }
    return ids;
  }

  /** Dropping a thread is best effort (a new conversation id never reuses it), but isolation
   * evidence the drop turned up is logged. */
  private forgetThread(paperKey: string, conversationId: string): void {
    this.threadInstructions.delete(conversationId);
    let dropping: Promise<void>;
    try {
      dropping = Promise.resolve(this.chat.forget(conversationId));
    } catch (cause) {
      dropping = Promise.reject(cause);
    }
    void dropping.catch((cause: unknown) => {
      if (isUnsafe(cause)) this.log({ event: 'chat', action: 'unsafe', paperKey, code: 'UNSAFE_RUNTIME' });
    });
  }

  private interruptedAnswer(error: AppError): ChatMessage {
    return { messageId: this.newId(), role: 'assistant', text: '', status: 'failed', modelId: null, error, usage: null, createdAt: this.now().toISOString() };
  }

  /** The stored conversation, or an empty one with a stable fresh id. Never writes. An answer
   * whose write failed is shown after its question. A question stored without an answer that
   * nothing here is answering or holding is shown as interrupted, so it can be asked again; the
   * next save writes that. */
  private load(paperKey: string): ConversationRecord {
    const stored = this.store.getConversation(paperKey);
    if (stored === null) {
      this.unsaved.delete(paperKey);
      let id = this.freshIds.get(paperKey);
      if (id === undefined) {
        id = this.newId();
        this.freshIds.set(paperKey, id);
      }
      return { conversationId: id, messages: [] };
    }
    const last = stored.messages.at(-1);
    if (last === undefined || last.role !== 'user' || this.flights.has(paperKey)) {
      this.unsaved.delete(paperKey);
      return stored;
    }
    let unsaved = this.unsaved.get(paperKey);
    if (unsaved === undefined || unsaved.conversationId !== stored.conversationId || unsaved.afterMessageId !== last.messageId) {
      // Kept, so every read shows the same message until a save writes it.
      unsaved = { conversationId: stored.conversationId, afterMessageId: last.messageId, message: this.interruptedAnswer(INTERRUPTED_ERROR), placeholder: true };
      this.unsaved.set(paperKey, unsaved);
    }
    return { conversationId: stored.conversationId, messages: [...stored.messages, unsaved.message] };
  }

  private view(paperKey: string, record: ConversationRecord): Conversation {
    const flight = this.flights.get(paperKey);
    const answering = flight !== undefined && flight.conversationId === record.conversationId;
    return {
      paperKey,
      conversationId: record.conversationId,
      messages: answering ? [...record.messages, { ...flight.message }] : record.messages,
      answering,
    };
  }

  /** The messages the new question follows (a retried exchange removed) and its conversation id. */
  private plan(paperKey: string, request: AskInput): ConversationRecord {
    const record = this.load(paperKey);
    const messages = [...record.messages];
    if (request.retry) {
      const last = messages.at(-1);
      if (last === undefined || last.role !== 'assistant' || (last.status !== 'failed' && last.status !== 'canceled')) {
        throw invalidInput('다시 물어볼 수 있는 답변이 없습니다.');
      }
      messages.pop();
      if (messages.at(-1)?.role === 'user') messages.pop();
    }
    if (messages.length + 2 > MAX_CHAT_MESSAGES) throw invalidInput('대화가 길어져 더 이어 갈 수 없습니다. 새 대화를 시작해 주세요.');
    return { conversationId: record.conversationId, messages };
  }

  private requirePaper(paperKey: string): Paper {
    const paper = this.store.getPaper(paperKey);
    if (paper === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
    return paper;
  }

  private requireAskablePaper(paperKey: string): { paper: Paper; blocks: Block[] } {
    const paper = this.requirePaper(paperKey);
    const blocks = paper.status === 'ready' || paper.status === 'partial' ? this.store.listBlocks(paperKey) : [];
    if (blocks.length === 0) throw invalidInput('논문을 다 불러온 뒤에 질문할 수 있습니다.');
    return { paper, blocks };
  }

  /** The same account gate translation uses, with the question path's wording. */
  private async assertAccountReady(modelId: string): Promise<void> {
    let connection: Connection;
    try {
      connection = await this.connection();
    } catch {
      throw appError('NETWORK', 'Codex 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', true);
    }
    switch (connection.status) {
      case 'subscription':
        break;
      case 'missing':
        throw appError('AUTH_REQUIRED', 'Codex CLI를 찾을 수 없습니다. 설치한 뒤 다시 시도해 주세요.', false);
      case 'signed_out':
        throw appError('AUTH_REQUIRED', 'Codex 구독에 로그인해야 질문할 수 있습니다.', false);
      case 'api_key':
        throw appError('SUBSCRIPTION_REQUIRED', 'API 키 연결로는 답하지 않습니다. ChatGPT 구독으로 로그인해 주세요.', false);
      default:
        throw appError('NETWORK', 'Codex 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', true);
    }
    if (!connection.modelIds.includes(modelId)) {
      throw appError('MODEL_UNAVAILABLE', '선택한 모델을 지금 사용할 수 없습니다. 다른 모델을 선택해 주세요.', false);
    }
  }
}

/** Question and answer pairs whose answer completed, oldest first. A failed or stopped answer
 * never becomes context for the next question. */
export function completedExchanges(messages: readonly ChatMessage[]): { question: string; answer: string }[] {
  const exchanges: { question: string; answer: string }[] = [];
  for (let i = 0; i + 1 < messages.length; i += 1) {
    const question = messages[i]!;
    const answer = messages[i + 1]!;
    if (question.role === 'user' && answer.role === 'assistant' && answer.status === 'completed') {
      exchanges.push({ question: question.text, answer: answer.text });
    }
  }
  return exchanges;
}

export default ChatService;
