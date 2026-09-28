import type {
  AppError,
  Block,
  ChatMessage,
  ChatUsage,
  Coverage,
  ErrorCode,
  Highlight,
  Job,
  JobState,
  Paper,
  PauseReason,
  Region,
  RestartTranslationRequest,
  Translation,
  Usage,
} from '../../shared/contracts';
import { invalidInput } from './errors';

const PAPER_STATUSES = ['fetching', 'extracting', 'ready', 'partial', 'unsupported', 'failed'] as const;
const BLOCK_KINDS = ['heading', 'paragraph', 'caption', 'equation', 'figure', 'table', 'reference', 'unsupported'] as const;
const ALIGNMENTS = ['exact', 'uncertain'] as const;
const FONT_FAMILIES = ['serif', 'sans'] as const;
const FONT_WEIGHTS = ['normal', 'bold'] as const;
const TRANSLATION_STATUSES = ['pending', 'running', 'completed', 'failed', 'unsupported'] as const;
const JOB_STATES: JobState[] = ['idle', 'running', 'paused', 'completed', 'completed_with_gaps', 'failed'];
const PAUSE_REASONS: PauseReason[] = [null, 'user', 'auth', 'quota', 'network', 'model_unavailable', 'interrupted', 'reextracted'];
const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;

/** paperKey is used as a directory name: reject anything that could escape the app folder. */
export function assertSafeKey(paperKey: unknown): asserts paperKey is string {
  if (typeof paperKey !== 'string' || paperKey.length === 0) throw invalidInput('paperKey must be a non-empty string');
  if (paperKey.length > 200) throw invalidInput('paperKey is too long');
  if (!/^[A-Za-z0-9._-]+$/.test(paperKey)) throw invalidInput(`paperKey contains unsupported characters: ${paperKey}`);
  if (paperKey === '.' || paperKey === '..' || paperKey.startsWith('.')) throw invalidInput(`paperKey must not start with a dot: ${paperKey}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validate the user-owned inputs for an atomic translation restart. */
export function validateRestartTranslationRequest(value: unknown): RestartTranslationRequest {
  if (!value || typeof value !== 'object') throw invalidInput('restart request must be an object');
  const request = value as RestartTranslationRequest;
  if (!isNonEmptyString(request.modelId)) throw invalidInput('restart request.modelId must be a non-empty string');
  if (!isNonEmptyString(request.requestId)) throw invalidInput('restart request.requestId must be a non-empty string');
  if (!isNonEmptyString(request.expectedJobId)) {
    throw invalidInput('restart request.expectedJobId must be a non-empty string');
  }
  return {
    modelId: request.modelId,
    requestId: request.requestId,
    expectedJobId: request.expectedJobId,
  };
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function validateCoverage(coverage: unknown): Coverage {
  if (!coverage || typeof coverage !== 'object') throw invalidInput('coverage must be an object');
  const c = coverage as Coverage;
  if (!isInt(c.totalPages) || c.totalPages < 0) throw invalidInput('coverage.totalPages must be a non-negative integer');
  if (!isInt(c.textPages) || c.textPages < 0) throw invalidInput('coverage.textPages must be a non-negative integer');
  if (!Array.isArray(c.unsupportedPages) || !c.unsupportedPages.every((p) => isInt(p) && p >= 1)) {
    throw invalidInput('coverage.unsupportedPages must be an array of 1-based page numbers');
  }
  return { totalPages: c.totalPages, textPages: c.textPages, unsupportedPages: [...c.unsupportedPages] };
}

function validateRegion(region: unknown, blockId: string): Region {
  if (!region || typeof region !== 'object') throw invalidInput(`block ${blockId}: region must be an object`);
  const r = region as Region;
  if (!isInt(r.page) || r.page < 1) throw invalidInput(`block ${blockId}: region.page must be a 1-based integer`);
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw invalidInput(`block ${blockId}: region.${field} must be a finite number`);
  }
  return { page: r.page, x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Validate a Paper, enforcing that ready/partial carry full extraction metadata. */
export function validatePaper(paper: unknown): Paper {
  if (!paper || typeof paper !== 'object') throw invalidInput('paper must be an object');
  const p = paper as Paper;
  assertSafeKey(p.paperKey);
  if (p.sourceKind !== undefined && p.sourceKind !== 'arxiv' && p.sourceKind !== 'publication') throw invalidInput('paper.sourceKind is invalid');
  if (p.sourceKind === 'publication') {
    if (p.arxivId !== null || p.version !== null || !/^pdf-[a-f0-9]{64}-[a-f0-9]{64}$/.test(p.paperKey)) throw invalidInput('publication identity is invalid');
  } else {
    if (!isNonEmptyString(p.arxivId)) throw invalidInput('paper.arxivId must be a non-empty string');
    if (!isInt(p.version) || p.version < 1) throw invalidInput('paper.version must be a positive integer');
  }
  if (p.title !== null && typeof p.title !== 'string') throw invalidInput('paper.title must be a string or null');
  if (!Array.isArray(p.authors) || !p.authors.every((a) => typeof a === 'string')) throw invalidInput('paper.authors must be an array of strings');
  if (!isNonEmptyString(p.sourceUrl)) throw invalidInput('paper.sourceUrl must be a non-empty string');
  if (p.sourceKind === 'publication') {
    try {
      const source = new URL(p.sourceUrl);
      if (source.protocol !== 'https:' || !source.hostname || source.username || source.password || source.port) throw new Error();
    } catch { throw invalidInput('publication sourceUrl must be a public HTTPS URL'); }
  }
  if (!PAPER_STATUSES.includes(p.status)) throw invalidInput(`paper.status is invalid: ${String(p.status)}`);
  if (p.pdfSha256 !== null && !isNonEmptyString(p.pdfSha256)) throw invalidInput('paper.pdfSha256 must be a string or null');
  if (p.pageCount !== null && (!isInt(p.pageCount) || p.pageCount < 0)) throw invalidInput('paper.pageCount must be a non-negative integer or null');
  if (p.extractionVersion !== null && !isNonEmptyString(p.extractionVersion)) throw invalidInput('paper.extractionVersion must be a string or null');
  if (!isNonEmptyString(p.createdAt)) throw invalidInput('paper.createdAt must be an ISO 8601 string');

  const coverage = p.coverage === null ? null : validateCoverage(p.coverage);

  if (p.status === 'ready' || p.status === 'partial') {
    if (!isNonEmptyString(p.pdfSha256)) throw invalidInput(`paper.status=${p.status} requires pdfSha256`);
    if (!isInt(p.pageCount)) throw invalidInput(`paper.status=${p.status} requires pageCount`);
    if (!isNonEmptyString(p.extractionVersion)) throw invalidInput(`paper.status=${p.status} requires extractionVersion`);
    if (coverage === null) throw invalidInput(`paper.status=${p.status} requires coverage`);
  }

  return {
    paperKey: p.paperKey,
    ...(p.sourceKind === undefined ? {} : { sourceKind: p.sourceKind }),
    arxivId: p.arxivId,
    version: p.version,
    title: p.title ?? null,
    authors: [...p.authors],
    sourceUrl: p.sourceUrl,
    pdfSha256: p.pdfSha256 ?? null,
    pageCount: p.pageCount ?? null,
    extractionVersion: p.extractionVersion ?? null,
    status: p.status,
    coverage,
    createdAt: p.createdAt,
  };
}

/** Validate a Block. Throws before anything is written so batches stay atomic. */
export function validateBlock(block: unknown, paperKey: string): Block {
  if (!block || typeof block !== 'object') throw invalidInput('block must be an object');
  const b = block as Block;
  if (!isNonEmptyString(b.blockId)) throw invalidInput('block.blockId must be a non-empty string');
  if (b.paperKey !== paperKey) throw invalidInput(`block ${b.blockId}: paperKey mismatch (expected ${paperKey})`);
  if (!isInt(b.order) || b.order < 0) throw invalidInput(`block ${b.blockId}: order must be a non-negative integer`);
  if (!BLOCK_KINDS.includes(b.kind)) throw invalidInput(`block ${b.blockId}: invalid kind ${String(b.kind)}`);
  if (typeof b.sourceText !== 'string') throw invalidInput(`block ${b.blockId}: sourceText must be a string`);
  if (!isNonEmptyString(b.sourceHash)) throw invalidInput(`block ${b.blockId}: sourceHash must be a non-empty string`);
  if (!Array.isArray(b.regions) || b.regions.length < 1) throw invalidInput(`block ${b.blockId}: regions must contain at least one region`);
  if (!ALIGNMENTS.includes(b.alignment)) throw invalidInput(`block ${b.blockId}: invalid alignment ${String(b.alignment)}`);
  if (typeof b.translatable !== 'boolean') throw invalidInput(`block ${b.blockId}: translatable must be a boolean`);
  if (!FONT_FAMILIES.includes(b.fontFamily)) throw invalidInput(`block ${b.blockId}: invalid fontFamily ${String(b.fontFamily)}`);
  if (!FONT_WEIGHTS.includes(b.fontWeight)) throw invalidInput(`block ${b.blockId}: invalid fontWeight ${String(b.fontWeight)}`);
  if (typeof b.fontSize !== 'number' || !Number.isFinite(b.fontSize) || b.fontSize < 0 || b.fontSize > 1) {
    throw invalidInput(`block ${b.blockId}: fontSize must be a finite number in [0,1]`);
  }
  if (!isInt(b.pageOrdinal) || b.pageOrdinal < 0) throw invalidInput(`block ${b.blockId}: pageOrdinal must be a non-negative integer`);

  return {
    blockId: b.blockId,
    paperKey: b.paperKey,
    order: b.order,
    kind: b.kind,
    sourceText: b.sourceText,
    sourceHash: b.sourceHash,
    regions: b.regions.map((r) => validateRegion(r, b.blockId)),
    alignment: b.alignment,
    translatable: b.translatable,
    fontFamily: b.fontFamily,
    fontWeight: b.fontWeight,
    fontSize: b.fontSize,
    pageOrdinal: b.pageOrdinal,
  };
}

/** Validate a Translation record. */
export function validateTranslation(translation: unknown): Translation {
  if (!translation || typeof translation !== 'object') throw invalidInput('translation must be an object');
  const t = translation as Translation;
  if (!isNonEmptyString(t.blockId)) throw invalidInput('translation.blockId must be a non-empty string');
  if (!isNonEmptyString(t.sourceHash)) throw invalidInput('translation.sourceHash must be a non-empty string');
  if (!isNonEmptyString(t.modelId)) throw invalidInput('translation.modelId must be a non-empty string');
  if (!isNonEmptyString(t.promptVersion)) throw invalidInput('translation.promptVersion must be a non-empty string');
  if (!TRANSLATION_STATUSES.includes(t.status)) throw invalidInput(`translation.status is invalid: ${String(t.status)}`);
  if (t.text !== null && typeof t.text !== 'string') throw invalidInput('translation.text must be a string or null');
  if (t.completedAt !== null && !isNonEmptyString(t.completedAt)) throw invalidInput('translation.completedAt must be an ISO string or null');
  if (t.status === 'completed' && typeof t.text !== 'string') throw invalidInput('a completed translation requires text');
  if (t.status !== 'completed' && t.text !== null) throw invalidInput('only a completed translation may carry text');

  return {
    blockId: t.blockId,
    sourceHash: t.sourceHash,
    modelId: t.modelId,
    promptVersion: t.promptVersion,
    status: t.status,
    text: t.text ?? null,
    error: t.error ?? null,
    completedAt: t.completedAt ?? null,
  };
}

function validateUsage(usage: unknown): Usage {
  if (!usage || typeof usage !== 'object') throw invalidInput('usage must be an object');
  const u = usage as Usage;
  if (u.inputTokens !== null && !isInt(u.inputTokens)) throw invalidInput('usage.inputTokens must be an integer or null');
  if (u.outputTokens !== null && !isInt(u.outputTokens)) throw invalidInput('usage.outputTokens must be an integer or null');
  if (u.observedAt !== null && typeof u.observedAt !== 'string') throw invalidInput('usage.observedAt must be a string or null');
  return {
    inputTokens: u.inputTokens ?? null,
    outputTokens: u.outputTokens ?? null,
    limits: u.limits ?? null,
    observedAt: u.observedAt ?? null,
  };
}

/** Validate a Job record. */
export function validateJob(job: unknown): Job {
  if (!job || typeof job !== 'object') throw invalidInput('job must be an object');
  const j = job as Job;
  if (!isNonEmptyString(j.jobId)) throw invalidInput('job.jobId must be a non-empty string');
  assertSafeKey(j.paperKey);
  if (!isNonEmptyString(j.modelId)) throw invalidInput('job.modelId must be a non-empty string');
  if (!isNonEmptyString(j.promptVersion)) throw invalidInput('job.promptVersion must be a non-empty string');
  if (!isInt(j.generation) || j.generation < 0) throw invalidInput('job.generation must be a non-negative integer');
  if (!JOB_STATES.includes(j.state)) throw invalidInput(`job.state is invalid: ${String(j.state)}`);
  if (!PAUSE_REASONS.includes(j.pauseReason ?? null)) throw invalidInput(`job.pauseReason is invalid: ${String(j.pauseReason)}`);
  if (!isInt(j.completedBlocks) || j.completedBlocks < 0) throw invalidInput('job.completedBlocks must be a non-negative integer');
  if (!isInt(j.totalTranslatableBlocks) || j.totalTranslatableBlocks < 0) throw invalidInput('job.totalTranslatableBlocks must be a non-negative integer');
  if (!isNonEmptyString(j.updatedAt)) throw invalidInput('job.updatedAt must be an ISO 8601 string');
  if (j.currentPage !== null && (!isInt(j.currentPage) || j.currentPage < 1)) {
    throw invalidInput('job.currentPage must be a positive integer or null');
  }

  return {
    jobId: j.jobId,
    paperKey: j.paperKey,
    modelId: j.modelId,
    promptVersion: j.promptVersion,
    generation: j.generation,
    state: j.state,
    pauseReason: j.pauseReason ?? null,
    completedBlocks: j.completedBlocks,
    totalTranslatableBlocks: j.totalTranslatableBlocks,
    usage: validateUsage(j.usage),
    updatedAt: j.updatedAt,
    currentPage: j.currentPage ?? null,
  };
}

/** True when `text` contains a C0/C1 control character. Newline (\n) may optionally be allowed. */
function hasControlChars(text: string, allowNewline: boolean): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (allowNewline && code === 10) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateHighlightRect(rect: unknown, page: number, highlightId: string): Region {
  if (!rect || typeof rect !== 'object') throw invalidInput(`highlight ${highlightId}: rect must be an object`);
  const r = rect as Region;
  if (r.page !== page) throw invalidInput(`highlight ${highlightId}: every rect must share the highlight's page`);
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw invalidInput(`highlight ${highlightId}: rect.${field} must be a ratio in [0,1]`);
    }
  }
  if (r.width <= 0 || r.height <= 0) throw invalidInput(`highlight ${highlightId}: rect width/height must be greater than 0`);
  return { page: r.page, x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Validate a Highlight. Coordinates are page-ratio boxes; storage never trusts pixel values. */
export function validateHighlight(highlight: unknown, paperKey: string): Highlight {
  if (!highlight || typeof highlight !== 'object') throw invalidInput('highlight must be an object');
  const h = highlight as Highlight;
  if (!isNonEmptyString(h.highlightId)) throw invalidInput('highlight.highlightId must be a non-empty string');
  if (h.paperKey !== paperKey) throw invalidInput(`highlight ${h.highlightId}: paperKey mismatch (expected ${paperKey})`);
  if (!isInt(h.page) || h.page < 1) throw invalidInput(`highlight ${h.highlightId}: page must be a 1-based integer`);
  if (!Array.isArray(h.rects) || h.rects.length < 1 || h.rects.length > 200) {
    throw invalidInput(`highlight ${h.highlightId}: rects must contain between 1 and 200 entries`);
  }
  if (typeof h.text !== 'string' || h.text.length === 0) throw invalidInput(`highlight ${h.highlightId}: text must be a non-empty string`);
  if (h.text.length > 2000) throw invalidInput(`highlight ${h.highlightId}: text is too long`);
  if (hasControlChars(h.text, false)) throw invalidInput(`highlight ${h.highlightId}: text must not contain control characters`);
  if (!HIGHLIGHT_COLORS.includes(h.color)) throw invalidInput(`highlight ${h.highlightId}: invalid color ${String(h.color)}`);
  if (h.note !== null) {
    if (typeof h.note !== 'string') throw invalidInput(`highlight ${h.highlightId}: note must be a string or null`);
    if (h.note.length > 5000) throw invalidInput(`highlight ${h.highlightId}: note is too long`);
    if (hasControlChars(h.note, true)) throw invalidInput(`highlight ${h.highlightId}: note must not contain control characters other than newline`);
  }
  if (!isNonEmptyString(h.createdAt)) throw invalidInput(`highlight ${h.highlightId}: createdAt must be an ISO 8601 string`);
  if (!isNonEmptyString(h.updatedAt)) throw invalidInput(`highlight ${h.highlightId}: updatedAt must be an ISO 8601 string`);

  return {
    highlightId: h.highlightId,
    paperKey: h.paperKey,
    page: h.page,
    rects: h.rects.map((r) => validateHighlightRect(r, h.page, h.highlightId)),
    text: h.text,
    color: h.color,
    note: h.note ?? null,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

// ------------------------------------------------------------------ paper questions

/** Longest question a reader may ask, after trimming. */
export const MAX_QUESTION_CHARS = 8000;
/** Longest stored answer; a longer one is cut before it is saved. */
export const MAX_ANSWER_CHARS = 200_000;
/** Most messages one conversation may hold (question + answer pairs). */
export const MAX_CHAT_MESSAGES = 400;

const ERROR_CODES: ErrorCode[] = [
  'INVALID_INPUT', 'NOT_FOUND', 'NETWORK', 'TOO_LARGE', 'UNSUPPORTED_PDF', 'SOURCE_CHANGED', 'AUTH_REQUIRED',
  'SUBSCRIPTION_REQUIRED', 'QUOTA', 'MODEL_UNAVAILABLE', 'BUSY', 'INVALID_TRANSLATION', 'STORAGE', 'UNSAFE_RUNTIME', 'INTERNAL',
];
/** Only settled messages reach the disk; 'answering' lives in the service's memory. */
const STORED_CHAT_STATUSES = ['completed', 'failed', 'canceled'] as const;
const CHAT_ID = /^[A-Za-z0-9-]{1,100}$/;

/** A paper's stored question conversation. It holds questions and answers only — never the
 * paper's full text or the system instructions built from it. */
export interface ConversationRecord {
  conversationId: string;
  messages: ChatMessage[];
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as string[]).includes(value);
}

function validateAppError(value: unknown, where: string): AppError {
  if (!value || typeof value !== 'object') throw invalidInput(`${where}: error must be an object or null`);
  const e = value as AppError;
  if (!isErrorCode(e.code)) throw invalidInput(`${where}: error.code is invalid`);
  if (typeof e.message !== 'string' || e.message.length > 2000) throw invalidInput(`${where}: error.message must be a string of at most 2000 characters`);
  if (typeof e.retryable !== 'boolean') throw invalidInput(`${where}: error.retryable must be a boolean`);
  return { code: e.code, message: e.message, retryable: e.retryable };
}

function validateChatUsage(value: unknown, where: string): ChatUsage {
  if (!value || typeof value !== 'object') throw invalidInput(`${where}: usage must be an object or null`);
  const u = value as ChatUsage;
  const count = (field: keyof ChatUsage): number | null => {
    const v = u[field];
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalidInput(`${where}: usage.${field} must be a non-negative number or null`);
    return v;
  };
  return { inputTokens: count('inputTokens'), cachedInputTokens: count('cachedInputTokens'), outputTokens: count('outputTokens') };
}

/** Validate one stored conversation message. */
export function validateChatMessage(message: unknown): ChatMessage {
  if (!message || typeof message !== 'object') throw invalidInput('chat message must be an object');
  const m = message as ChatMessage;
  if (typeof m.messageId !== 'string' || !CHAT_ID.test(m.messageId)) throw invalidInput('chat message.messageId is invalid');
  const where = `chat message ${m.messageId}`;
  if (m.role !== 'user' && m.role !== 'assistant') throw invalidInput(`${where}: role must be user or assistant`);
  if (!(STORED_CHAT_STATUSES as readonly string[]).includes(m.status)) throw invalidInput(`${where}: status ${String(m.status)} cannot be stored`);
  if (typeof m.text !== 'string') throw invalidInput(`${where}: text must be a string`);
  if (!isNonEmptyString(m.createdAt)) throw invalidInput(`${where}: createdAt must be an ISO 8601 string`);

  if (m.role === 'user') {
    if (m.text.trim().length === 0 || m.text.length > MAX_QUESTION_CHARS) throw invalidInput(`${where}: a question must hold 1-${MAX_QUESTION_CHARS} characters`);
    if (m.status !== 'completed') throw invalidInput(`${where}: a question is always completed`);
    if (m.modelId !== null || m.error !== null || m.usage !== null) throw invalidInput(`${where}: a question carries no model, error or usage`);
    return { messageId: m.messageId, role: 'user', text: m.text, status: 'completed', modelId: null, error: null, usage: null, createdAt: m.createdAt };
  }

  if (m.text.length > MAX_ANSWER_CHARS) throw invalidInput(`${where}: an answer holds at most ${MAX_ANSWER_CHARS} characters`);
  if (m.modelId !== null && (typeof m.modelId !== 'string' || m.modelId.length === 0 || m.modelId.length > 100)) {
    throw invalidInput(`${where}: modelId must be a non-empty string or null`);
  }
  const error = m.error === null ? null : validateAppError(m.error, where);
  if (m.status === 'failed' && error === null) throw invalidInput(`${where}: a failed answer requires its error`);
  if (m.status !== 'failed' && error !== null) throw invalidInput(`${where}: only a failed answer carries an error`);
  const usage = m.usage === null ? null : validateChatUsage(m.usage, where);
  return { messageId: m.messageId, role: 'assistant', text: m.text, status: m.status, modelId: m.modelId, error, usage, createdAt: m.createdAt };
}

/** Validate a stored conversation before it is written, and again when it is read back. */
export function validateConversationRecord(record: unknown): ConversationRecord {
  if (!record || typeof record !== 'object') throw invalidInput('conversation must be an object');
  const r = record as ConversationRecord;
  if (typeof r.conversationId !== 'string' || !CHAT_ID.test(r.conversationId)) throw invalidInput('conversation.conversationId is invalid');
  if (!Array.isArray(r.messages) || r.messages.length > MAX_CHAT_MESSAGES) {
    throw invalidInput(`conversation.messages must be an array of at most ${MAX_CHAT_MESSAGES} entries`);
  }
  const messages = r.messages.map((m) => validateChatMessage(m));
  const seen = new Set<string>();
  for (const m of messages) {
    if (seen.has(m.messageId)) throw invalidInput(`conversation: duplicate messageId ${m.messageId}`);
    seen.add(m.messageId);
  }
  return { conversationId: r.conversationId, messages };
}
