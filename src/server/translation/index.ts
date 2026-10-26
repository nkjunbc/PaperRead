import type {
  AppError,
  Block,
  Job,
  Paper,
  PauseReason,
  Translation,
  TranslationPageInput,
  Translator,
  Usage,
} from '../../shared/contracts';
import { isTranslated, selectTranslations } from '../../shared/translations';
import { PaperStore, appError, notFound } from '../store/index';
import { JobManager } from '../jobs/state';
import { FORMAT_PROMPT_VERSION, remapMathMarkers, splitFormattedBlock, validateFormattedTranslation } from './format';

/**
 * Version of the PaperRead translation rules. Every request is sent with it and every
 * result records it, so the reader can show each paragraph by the rules that made it. A
 * completed translation made with an older version still counts as finished: bumping it
 * never re-sends (or re-bills) a paragraph by itself.
 */
export const PROMPT_VERSION = FORMAT_PROMPT_VERSION;

/** Upper bound for an accepted translation body; a longer answer is not a paragraph. */
const MAX_TRANSLATION_CHARS = 100_000;

/**
 * How many times a page's outstanding paragraphs are re-sent in a row before the page is set
 * aside (deferred). Not specified by the product: a small number so one stubborn page cannot
 * stall every other page behind it, tunable without touching call sites.
 */
const PAGE_ATTEMPTS_PER_ROUND = 3;

/** Errors that must stop the whole job at once, with the reason the user sees. */
const PAUSE_CODES: Partial<Record<AppError['code'], Exclude<PauseReason, null>>> = {
  AUTH_REQUIRED: 'auth',
  SUBSCRIPTION_REQUIRED: 'auth',
  QUOTA: 'quota',
  MODEL_UNAVAILABLE: 'model_unavailable',
};

/** Structured, content-free log record. Never carries paper text or credentials. */
export interface PipelineLogEvent {
  event: 'job.start' | 'job.end' | 'block.done' | 'block.failed' | 'job.paused' | 'job.aborted';
  jobId: string;
  code?: AppError['code'];
  state?: Job['state'];
  pauseReason?: PauseReason;
  processed?: number;
  durationMs?: number;
}

export interface PipelineOptions {
  store: PaperStore;
  jobs: JobManager;
  translator: Translator;
  log?: (event: PipelineLogEvent) => void;
  now?: () => Date;
  /** Bound concurrent isolated page turns; 1 is also useful for provider diagnostics. */
  pageConcurrency?: 1 | 2;
}

export interface RunOptions {
  /** Fired after each block whose translation was stored as completed. */
  onBlockDone?: (blockId: string) => void;
}

/** Mutable counters threaded through the recursive page/split attempts of one `run` call. */
interface RunTracker {
  usage: Usage;
  processed: number;
  /** Persist reduced batch sizes across the deferred pass, without extra attempts. */
  formatBatchSizes: Map<number, number>;
}

/** How a single batch attempt (a whole page, or a split half of one) ended. */
type BatchOutcome = 'aborted' | 'paused' | 'jobFailed' | 'complete' | 'deferred';

/** The primary page a block belongs to: the page of its first region. A block whose regions
 * span a page break (a merged continuation paragraph) is grouped under the page it starts on. */
function pageNumberOf(block: Block): number {
  return block.regions[0]?.page ?? 1;
}

/** Group blocks by page, preserving each page's blocks in their existing (already `order`-sorted) sequence. */
function groupByPage(blocks: Block[]): Map<number, Block[]> {
  const pages = new Map<number, Block[]>();
  for (const block of blocks) {
    const page = pageNumberOf(block);
    const list = pages.get(page);
    if (list) list.push(block);
    else pages.set(page, [block]);
  }
  return pages;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function toAppError(cause: unknown): AppError {
  const candidate = cause as Partial<AppError> & { error?: AppError };
  if (candidate?.error && typeof candidate.error.code === 'string') return candidate.error;
  if (typeof candidate?.code === 'string') {
    return {
      code: candidate.code as AppError['code'],
      message: typeof candidate.message === 'string' ? candidate.message : String(candidate.code),
      retryable: candidate.retryable === true,
    };
  }
  return { code: 'INTERNAL', message: '문단 번역 중 알 수 없는 오류가 발생했습니다.', retryable: false };
}

/**
 * The only paper-level information a translation request may carry.
 *
 * Bounded on purpose: the model needs the title (and a little bibliographic
 * framing) to resolve terminology, and nothing more. The full paper is never
 * re-sent with each paragraph — that would leak the whole document into every
 * outbound request and burn the subscription quota.
 */
export function paperContext(paper: Paper): string {
  const lines: string[] = [];
  const title = paper.title?.trim();
  lines.push(`논문 제목: ${title ? title.slice(0, 300) : '확인 불가'}`);
  const authors = paper.authors.slice(0, 5).map((a) => a.slice(0, 80));
  lines.push(`저자: ${authors.length > 0 ? authors.join(', ') : '확인 불가'}`);
  if (paper.arxivId !== null && paper.version !== null) {
    lines.push(`arXiv: ${paper.arxivId}v${paper.version}`);
  } else if (paper.sourceKind === 'publication') {
    // A publisher PDF is its own source, not an arXiv revision. Query parameters
    // can contain expiring download credentials and are never needed for context.
    let source = '공개 PDF';
    try { source = new URL(paper.sourceUrl).hostname.slice(0, 253) || source; } catch { /* old malformed source metadata */ }
    lines.push(`출처: ${source}`);
  }
  return lines.join('\n');
}

/**
 * Reject anything that is not a plain, complete paragraph of text.
 *
 * This is a *format* gate, not a meaning check: an empty, whitespace-only,
 * control-character-laden or absurdly long answer is never stored as a
 * completed translation. Semantic fidelity remains a human judgement.
 */
export function validateTranslationText(value: unknown): string {
  const invalid = (reason: string) => appError('INVALID_TRANSLATION', reason, false);
  if (typeof value !== 'string') throw invalid('번역 응답이 문자열이 아닙니다.');
  const text = value.trim();
  if (text.length === 0) throw invalid('번역 응답이 비어 있습니다.');
  if (text.length > MAX_TRANSLATION_CHARS) throw invalid('번역 응답이 허용 길이를 초과했습니다.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw invalid('번역 응답에 허용되지 않는 제어 문자가 있습니다.');
  return text;
}

/** Accumulate only values the provider actually reported. Missing stays null, never 0. */
export function mergeUsage(base: Usage, next: Usage): Usage {
  const add = (a: number | null, b: number | null): number | null => {
    if (a === null && b === null) return null;
    return (a ?? 0) + (b ?? 0);
  };
  return {
    inputTokens: add(base.inputTokens, next.inputTokens),
    outputTokens: add(base.outputTokens, next.outputTokens),
    limits: next.limits ?? base.limits,
    observedAt: next.observedAt ?? base.observedAt,
  };
}

/**
 * Bounded, resumable translation of one paper revision.
 *
 * Guarantees enforced here:
 *  - nothing leaves the machine until `run` is called for a *running* job;
 *    opening or reading a paper never triggers a generation request
 *  - pages start in reading order, with at most two independent page turns;
 *    each verified paragraph is committed as soon as its page returns
 *  - `translatable:false` blocks are recorded `unsupported` without a request
 *  - an already completed translation for the same blockId+sourceHash+modelId is
 *    reused, whichever prompt version made it, skipping the request; anything still
 *    sent uses the current PROMPT_VERSION and is recorded with it
 *  - the job generation is re-checked before every request and again before
 *    every write, so a cancel/delete discards in-flight results; a pending
 *    re-extraction journal stops the run the same way
 *  - auth / quota / missing-model stop the job immediately with a mapped
 *    pauseReason; any other per-block failure is recorded and the run continues
 */
export class TranslationPipeline {
  private readonly store: PaperStore;
  private readonly jobs: JobManager;
  private readonly translator: Translator;
  private readonly log: (event: PipelineLogEvent) => void;
  private readonly now: () => Date;
  private readonly pageConcurrency: 1 | 2;
  private readonly running = new Map<string, AbortController>();

  constructor(options: PipelineOptions) {
    this.store = options.store;
    this.jobs = options.jobs;
    this.translator = options.translator;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.pageConcurrency = options.pageConcurrency === 1 ? 1 : 2;
  }

  /** True while a run loop for this job is in flight in this process. */
  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  /**
   * Stop waiting the moment the run is aborted.
   *
   * A provider that ignores its AbortSignal must not be able to wedge the job
   * forever: the loop gives up on the request, and the orphaned promise's
   * result is discarded by the generation/state guard if it ever settles.
   */
  private raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(appError('NETWORK', '번역 요청이 취소되었습니다.', true));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** Cancel the in-flight request for a job (pause / delete / disconnect). */
  abort(jobId: string): void {
    this.running.get(jobId)?.abort();
  }

  /** Cancel every in-flight request (shutdown). */
  abortAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  private record(jobId: string, generation: number, translation: Translation): boolean {
    try {
      if (this.running.get(jobId)?.signal.aborted || this.guard(jobId, generation) === null) return false;
      return this.jobs.acceptResult(jobId, generation, translation);
    } catch (cause) {
      // Stop already-resolved sibling promises in this same microtask turn, before
      // the worker's async stack unwinds and a sibling can commit another result.
      this.running.get(jobId)?.abort();
      throw cause;
    }
  }

  /**
   * Translatable blocks on a page that still need a request. A block whose current text already
   * has a completed, non-empty translation on the job's model is done, whatever later attempt
   * failed (the shared selection rule). Failed translations are provisional until the page's
   * bounded retries are exhausted, so an empty or malformed first response cannot make a
   * paragraph permanently failed while a later response is usable.
   */
  private pending(job: Job, blocks: Block[]): Block[] {
    const selected = selectTranslations(blocks, this.store.listTranslations(job.paperKey), job.modelId);
    return blocks.filter((b) => !isTranslated(b, selected.get(b.blockId)));
  }

  /**
   * Drive one job to a stopping point: completion, a pause, or an abandoned
   * generation. Returns the job as persisted at that point.
   */
  async run(jobId: string, options: RunOptions = {}): Promise<Job> {
    const started = this.now().getTime();
    const job = this.jobs.getJob(jobId);
    if (job === null) throw notFound(`job not found: ${jobId}`);
    // Only an explicitly running job may send anything.
    if (job.state !== 'running') return job;
    if (this.running.has(jobId)) return job;

    const generation = job.generation;
    const controller = new AbortController();
    this.running.set(jobId, controller);
    this.log({ event: 'job.start', jobId });

    const tracker: RunTracker = { usage: job.usage, processed: 0, formatBatchSizes: new Map() };
    try {
      const paper = this.store.getPaper(job.paperKey);
      if (paper === null) return this.jobs.getJob(jobId) ?? job;
      const context = paperContext(paper);
      const blocks = this.store.listBlocks(job.paperKey);

      // Untranslatable blocks (figure/table/equation/unsupported) are recorded once, up
      // front, without ever going out on the wire: they are a permanent, deliberate gap,
      // not something a page request could ever resolve.
      for (const block of blocks) {
        if (block.translatable) continue;
        const current = this.guard(jobId, generation);
        if (current === null) {
          this.log({ event: 'job.aborted', jobId, processed: tracker.processed });
          return this.jobs.getJob(jobId) ?? job;
        }
        this.record(jobId, generation, this.unsupported(block, current));
      }

      const pages = groupByPage(blocks.filter((b) => b.translatable));
      const pageNumbers = [...pages.keys()].sort((a, b) => a - b);
      const deferred = await this.runPages(jobId, generation, controller, context, pages, pageNumbers, tracker, options, false);

      // A page that kept failing is retried once more here, after every other page has
      // had its turn, so one stubborn page cannot block the rest of the paper.
      if (!controller.signal.aborted) {
        await this.runPages(jobId, generation, controller, context, pages, deferred, tracker, options, true);
      }

      const final = this.guard(jobId, generation);
      if (final === null || controller.signal.aborted) return this.jobs.getJob(jobId) ?? job;
      // completed vs completed_with_gaps is decided purely by translatable-block coverage;
      // an untranslatable block was already recorded above and never enters this count.
      const finished = this.jobs.finalizeJob(jobId);
      this.log({
        event: 'job.end',
        jobId,
        state: finished.state,
        processed: tracker.processed,
        durationMs: this.now().getTime() - started,
      });
      return finished;
    } catch (cause) {
      // Disk or progress persistence failures must stop generation, not be retried as
      // malformed model responses. If the disk still permits it, expose a failed job.
      // A guard that cannot read (an unreadable re-extraction journal) writes nothing
      // here and never replaces the failure that stopped the run.
      controller.abort();
      try {
        if (this.guard(jobId, generation) !== null) this.jobs.failJob(jobId, toAppError(cause));
      } catch { /* retain the original failure */ }
      throw cause;
    } finally {
      controller.abort();
      this.running.delete(jobId);
    }
  }

  /** Two workers share a stop signal, but never a page or a provider thread. Await
   * both workers even after failure so a subsequent resume cannot race this run. */
  private async runPages(
    jobId: string,
    generation: number,
    controller: AbortController,
    context: string,
    pages: Map<number, Block[]>,
    pageNumbers: number[],
    tracker: RunTracker,
    options: RunOptions,
    final: boolean,
  ): Promise<number[]> {
    let next = 0;
    const active = new Set<number>();
    const deferred: number[] = [];
    const updatePage = () => {
      if (controller.signal.aborted) return;
      const current = this.guard(jobId, generation);
      if (current === null) return;
      const page = active.size > 0 ? Math.min(...active) : null;
      if (current.currentPage !== page) this.jobs.updateCurrentPage(jobId, page);
    };
    const worker = async () => {
      try {
        while (next < pageNumbers.length && !controller.signal.aborted) {
          const current = this.guard(jobId, generation);
          if (current === null) { controller.abort(); return; }
          const page = pageNumbers[next++]!;
          const blocks = pages.get(page)!;
          if (this.pending(current, blocks).length === 0) continue;
          active.add(page);
          try {
            updatePage();
            const outcome = await this.runPage(jobId, generation, controller, context, blocks, tracker, options, final);
            if (outcome === 'deferred') deferred.push(page);
            if (outcome === 'aborted' || outcome === 'paused' || outcome === 'jobFailed') controller.abort();
          } catch (cause) {
            // Stop before the cleanup below, so its guard read cannot replace this failure.
            controller.abort();
            throw cause;
          } finally {
            active.delete(page);
            updatePage();
          }
        }
      } catch (cause) {
        controller.abort();
        throw cause;
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(this.pageConcurrency, pageNumbers.length) }, worker));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failure) throw failure.reason;
    return deferred.sort((a, b) => a - b);
  }

  /**
   * Drive one page to a stopping point. Sends nothing when every block on the page is
   * already covered by a reusable translation. Otherwise retries the outstanding
   * paragraphs up to `PAGE_ATTEMPTS_PER_ROUND` times; when `final` is true (the deferred
   * retry pass, after every other page had its turn) anything still outstanding is
   * recorded as a failed translation instead of left unattempted, so the job can finish.
   */
  private async runPage(
    jobId: string,
    generation: number,
    controller: AbortController,
    context: string,
    blocks: Block[],
    tracker: RunTracker,
    options: RunOptions,
    final: boolean,
  ): Promise<BatchOutcome> {
    const current0 = this.guard(jobId, generation);
    if (current0 === null) return 'aborted';
    let remaining = this.pending(current0, blocks);
    if (remaining.length === 0) return 'complete';

    let lastError: AppError | null = null;
    let attempts = 0;
    const page = pageNumberOf(blocks[0]!);
    while (remaining.length > 0 && attempts < PAGE_ATTEMPTS_PER_ROUND) {
      attempts += 1;
      const batchSize = Math.min(tracker.formatBatchSizes.get(page) ?? remaining.length, remaining.length);
      let invalidFormat = false;
      for (let offset = 0; offset < remaining.length; offset += batchSize) {
        const result = await this.translateBatch(jobId, generation, controller, context, remaining.slice(offset, offset + batchSize), tracker, options);
        if (result.kind === 'aborted' || result.kind === 'paused' || result.kind === 'jobFailed') return result.kind;
        if (result.lastError) lastError = result.lastError;
        invalidFormat ||= result.lastError?.code === 'INVALID_TRANSLATION';
      }
      const after = this.guard(jobId, generation);
      if (after === null) return 'aborted';
      remaining = this.pending(after, remaining);
      if (invalidFormat && remaining.length > 0) {
        // Smaller requests isolate difficult paragraphs. Every paragraph still has
        // at most the same 3 + 3 attempts; accepted paragraphs never enter them again.
        tracker.formatBatchSizes.set(page, Math.max(1, Math.floor(Math.min(batchSize, remaining.length) / 2)));
      }
    }
    if (remaining.length === 0) return 'complete';
    if (!final) return 'deferred';

    const closing = this.guard(jobId, generation);
    if (closing === null) return 'aborted';
    const error = lastError ?? toAppError(appError('NETWORK', '번역 응답을 받지 못했습니다.', true));
    for (const block of remaining) {
      this.record(jobId, generation, this.failed(block, closing, error));
      this.log({ event: 'block.failed', jobId, code: error.code });
    }
    return 'complete';
  }

  /**
   * One page request (or a split half of one, on TOO_LARGE): every listed block is sent
   * numbered in a single call, and matched back by that number, never by position — a
   * dropped or reordered reply entry can never land in the wrong paragraph's slot.
   */
  private async translateBatch(
    jobId: string,
    generation: number,
    controller: AbortController,
    context: string,
    blocks: Block[],
    tracker: RunTracker,
    options: RunOptions,
  ): Promise<{ kind: 'aborted' | 'paused' | 'jobFailed' | 'attempted'; lastError?: AppError }> {
    const current = this.guard(jobId, generation);
    if (current === null || controller.signal.aborted) return { kind: 'aborted' };

    const numbers = new Set<number>();
    for (const block of blocks) {
      if (numbers.has(block.pageOrdinal)) {
        return {
          kind: 'attempted',
          lastError: toAppError(appError('INVALID_TRANSLATION', '쪽 안의 문단 번호가 중복되었습니다.', false)),
        };
      }
      numbers.add(block.pageOrdinal);
    }
    const paragraphs = blocks.map((block) => ({ number: block.pageOrdinal, block }));
    let output: { results: { number: number; text: string }[]; usage: Usage };
    try {
      const input: TranslationPageInput = { paragraphs, modelId: current.modelId, context, signal: controller.signal, promptVersion: PROMPT_VERSION };
      output = await this.raceAbort(this.translator.translatePage(input), controller.signal);
    } catch (cause) {
      const error = toAppError(cause);
      const terminal = this.stopForTerminalError(jobId, generation, controller, error, tracker);
      if (terminal !== null) return terminal;
      if (error.code === 'TOO_LARGE' && blocks.length > 1) {
        // Only the page that overflowed the model's input limit is split, and only until
        // each half fits or a single paragraph is left (which can no longer be split).
        const mid = Math.ceil(blocks.length / 2);
        const first = await this.translateBatch(jobId, generation, controller, context, blocks.slice(0, mid), tracker, options);
        if (first.kind !== 'attempted') return first;
        const second = await this.translateBatch(jobId, generation, controller, context, blocks.slice(mid), tracker, options);
        if (second.kind !== 'attempted') return second;
        return { kind: 'attempted', lastError: second.lastError ?? first.lastError };
      }
      if (error.code === 'TOO_LARGE' && blocks.length === 1) {
        const paragraph = paragraphs[0]!;
        let saving = false;
        try {
          const output = await this.translateOversizedParagraph(jobId, generation, paragraph.block, context, controller.signal);
          if (output === null) return { kind: 'aborted' };
          const after = this.guard(jobId, generation);
          if (after === null || controller.signal.aborted) return { kind: 'aborted' };
          const text = validateTranslationText(output.text);
          validateFormattedTranslation(paragraph.block, text, PROMPT_VERSION);
          saving = true;
          const accepted = this.record(jobId, generation, {
            blockId: paragraph.block.blockId,
            sourceHash: paragraph.block.sourceHash,
            modelId: after.modelId,
            promptVersion: PROMPT_VERSION,
            status: 'completed',
            text,
            error: null,
            completedAt: nowIso(this.now),
          });
          if (!accepted) return { kind: 'aborted' };
          tracker.usage = mergeUsage(tracker.usage, output.usage);
          this.jobs.updateUsage(jobId, tracker.usage);
          tracker.processed += 1;
          this.log({ event: 'block.done', jobId });
          options.onBlockDone?.(paragraph.block.blockId);
          return { kind: 'attempted' };
        } catch (fragmentCause) {
          if (saving) throw fragmentCause;
          const fragmentError = toAppError(fragmentCause);
          const terminal = this.stopForTerminalError(jobId, generation, controller, fragmentError, tracker);
          if (terminal !== null) return terminal;
          return { kind: 'attempted', lastError: fragmentError };
        }
      }
      // A whole-batch failure (network, malformed reply, or a single paragraph still too
      // large to split): nothing is recorded here. The page-level retry loop tries again,
      // and only a paragraph still missing after every retry is ever recorded as failed.
      return { kind: 'attempted', lastError: error };
    }

    // Re-check *after* the round trip: a late answer to a cancelled job is discarded.
    const after = this.guard(jobId, generation);
    if (after === null || controller.signal.aborted) return { kind: 'aborted' };

    let itemError: AppError | undefined;
    for (const paragraph of paragraphs) {
      const match = output.results.find((r) => r.number === paragraph.number);
      if (!match) {
        itemError = toAppError(appError('INVALID_TRANSLATION', '번역 응답에 요청한 문단 번호가 없습니다.', false));
        continue;
      }
      let text: string;
      try {
        text = validateTranslationText(match.text);
        validateFormattedTranslation(paragraph.block, text, PROMPT_VERSION);
      } catch (cause) {
        // Retry only malformed output. A failed disk write is not another paid turn.
        itemError = toAppError(cause);
        continue;
      }
      const accepted = this.record(jobId, generation, {
        blockId: paragraph.block.blockId,
        sourceHash: paragraph.block.sourceHash,
        modelId: after.modelId,
        promptVersion: PROMPT_VERSION,
        status: 'completed',
        text,
        error: null,
        completedAt: nowIso(this.now),
      });
      if (!accepted) return { kind: 'aborted' };
      tracker.processed += 1;
      this.log({ event: 'block.done', jobId });
      options.onBlockDone?.(paragraph.block.blockId);
    }
    if (controller.signal.aborted || this.guard(jobId, generation) === null) return { kind: 'aborted' };
    tracker.usage = mergeUsage(tracker.usage, output.usage ?? emptyUsage());
    this.jobs.updateUsage(jobId, tracker.usage);
    return { kind: 'attempted', lastError: itemError };
  }

  /**
   * Stop errors that must never fall through to page retries or another split fragment.
   * Kept shared with the page request path so their stopping policy cannot diverge.
   */
  private stopForTerminalError(
    jobId: string,
    generation: number,
    controller: AbortController,
    error: AppError,
    tracker: RunTracker,
  ): { kind: 'aborted' | 'paused' | 'jobFailed' } | null {
    // A sibling may already have paused the job, or reset may have replaced it.
    // Late provider failures must not mutate that stopped/new generation.
    if (controller.signal.aborted || this.guard(jobId, generation) === null) return { kind: 'aborted' };
    const pauseReason = PAUSE_CODES[error.code];
    if (pauseReason !== undefined) {
      this.jobs.pauseJob(jobId, pauseReason);
      controller.abort();
      this.log({ event: 'job.paused', jobId, code: error.code, pauseReason, processed: tracker.processed });
      return { kind: 'paused' };
    }
    if (error.code === 'UNSAFE_RUNTIME') {
      // The proved text-only isolation did not hold: stop, do not retry.
      const failedJob = this.jobs.failJob(jobId, error);
      controller.abort();
      this.log({ event: 'job.end', jobId, code: error.code, state: failedJob.state, processed: tracker.processed });
      return { kind: 'jobFailed' };
    }
    return null;
  }

  /** Split a single over-limit source paragraph, translate its fragments through the
   * existing isolated single-paragraph path, then rejoin it under the original block id. */
  private async translateOversizedParagraph(
    jobId: string,
    generation: number,
    block: Block,
    context: string,
    signal: AbortSignal,
  ): Promise<{ text: string; usage: Usage } | null> {
    const job = this.guard(jobId, generation);
    if (job === null || signal.aborted) return null;
    try {
      const output = await this.raceAbort(this.translator.translate({ block, modelId: job.modelId, context, signal, promptVersion: PROMPT_VERSION }), signal);
      const text = validateTranslationText(output.text);
      validateFormattedTranslation(block, text, PROMPT_VERSION);
      return { text, usage: output.usage ?? emptyUsage() };
    } catch (cause) {
      const error = toAppError(cause);
      if (error.code !== 'TOO_LARGE') throw error;
      const [firstPart, secondPart] = splitFormattedBlock(block);
      const first = await this.translateOversizedParagraph(jobId, generation, firstPart.block, context, signal);
      if (first === null) return null;
      const second = await this.translateOversizedParagraph(jobId, generation, secondPart.block, context, signal);
      if (second === null) return null;
      const firstText = remapMathMarkers(first.text, firstPart.indices);
      const secondText = remapMathMarkers(second.text, secondPart.indices);
      return { text: `${firstText} ${secondText}`, usage: mergeUsage(first.usage, second.usage) };
    }
  }

  /**
   * The job as it stands now, or null when this run must stop writing and sending. A pending
   * re-extraction journal stops every request branch even when the cancellation it began was
   * never saved. A journal that cannot be read throws STORAGE rather than reading as none.
   */
  private guard(jobId: string, generation: number): Job | null {
    const job = this.jobs.getJob(jobId);
    if (job === null) return null;
    if (job.generation !== generation) return null;
    if (job.state !== 'running') return null;
    if (this.store.getPaper(job.paperKey) === null) return null;
    if (this.store.pendingReextraction(job.paperKey) !== null) return null;
    return job;
  }

  // Nothing is sent for these, so they keep the job's label instead of adding a second
  // record per prompt version.
  private unsupported(block: Block, job: Job): Translation {
    return {
      blockId: block.blockId,
      sourceHash: block.sourceHash,
      modelId: job.modelId,
      promptVersion: job.promptVersion,
      status: 'unsupported',
      text: null,
      error: null,
      completedAt: null,
    };
  }

  private failed(block: Block, job: Job, error: AppError): Translation {
    return {
      blockId: block.blockId,
      sourceHash: block.sourceHash,
      modelId: job.modelId,
      promptVersion: PROMPT_VERSION,
      status: 'failed',
      text: null,
      error,
      completedAt: null,
    };
  }
}

function emptyUsage(): Usage {
  return { inputTokens: null, outputTokens: null, limits: null, observedAt: null };
}

export default TranslationPipeline;
