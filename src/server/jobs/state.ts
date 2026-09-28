import { randomUUID } from 'node:crypto';
import type { AppError, Job, JobState, PauseReason, RestartTranslationRequest, Translation, Usage } from '../../shared/contracts';
import { PaperStore, appError, busy, invalidInput, notFound } from '../store/index';

const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null, limits: null, observedAt: null };

/** States that occupy the single global active slot. */
const ACTIVE_STATES: JobState[] = ['running'];

/** States a user may (re)start from. */
const RESTARTABLE_STATES: JobState[] = ['idle', 'paused', 'failed'];

/** Terminal states — the work for this revision is finished. */
const TERMINAL_STATES: JobState[] = ['completed', 'completed_with_gaps'];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Translation job lifecycle for the local app.
 *
 * Rules enforced here:
 *  - exactly one active (running) job across the whole app; no automatic queue
 *  - starting the same paper again returns the existing job (never a duplicate)
 *  - starting a different paper while one runs raises BUSY
 *  - the first job for a revision pins modelId/promptVersion for that revision
 *  - a finished job is returned as-is instead of re-running
 *  - cancel/delete bump `generation`, so results from an older generation are
 *    discarded rather than written
 *  - on startup, any persisted `running` job becomes paused(interrupted)
 *
 * All state lives in the PaperStore, so a hard kill loses nothing.
 */
export class JobManager {
  private readonly store: PaperStore;

  constructor(store: PaperStore) {
    this.store = store;
  }

  // ------------------------------------------------------------- queries

  getJob(jobId: string): Job | null {
    return this.store.getJob(jobId);
  }

  getJobForPaper(paperKey: string): Job | null {
    return this.store.getJobForPaper(paperKey);
  }

  listJobs(): Job[] {
    return this.store.listJobs();
  }

  /** The single running job, or null when the slot is free. */
  currentActive(): Job | null {
    return this.store.listJobs().find((j) => ACTIVE_STATES.includes(j.state)) ?? null;
  }

  /** True when `generation` still matches the job's current generation. */
  isGenerationCurrent(jobId: string, generation: number): boolean {
    const job = this.store.getJob(jobId);
    return job !== null && job.generation === generation;
  }

  private translatablePages(paperKey: string): Map<number, ReturnType<PaperStore['listBlocks']>> {
    const pages = new Map<number, ReturnType<PaperStore['listBlocks']>>();
    for (const block of this.store.listBlocks(paperKey)) {
      if (!block.translatable) continue;
      const page = block.regions[0]?.page ?? 1;
      const blocks = pages.get(page);
      if (blocks) blocks.push(block);
      else pages.set(page, [block]);
    }
    return pages;
  }

  private countCompleted(job: Job): number {
    const translations = this.store.listTranslations(job.paperKey);
    return [...this.translatablePages(job.paperKey).values()].filter((blocks) =>
      blocks.every((b) => translations.some(
        (t) =>
          t.blockId === b.blockId &&
          t.sourceHash === b.sourceHash &&
          t.modelId === job.modelId &&
          t.promptVersion === job.promptVersion &&
          t.status === 'completed',
      )),
    ).length;
  }

  private countTranslatable(paperKey: string): number {
    return this.translatablePages(paperKey).size;
  }

  private persist(job: Job): Job {
    return this.store.saveJob({ ...job, updatedAt: nowIso() });
  }

  private requireJob(jobId: string): Job {
    const job = this.store.getJob(jobId);
    if (job === null) throw notFound(`job not found: ${jobId}`);
    return job;
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Start or resume translation for a paper revision.
   *
   * Returns the existing job when the paper already has one (duplicate start,
   * resume after pause/failure, or a finished job replayed). Raises BUSY when a
   * different paper is running.
   */
  startJob(paperKey: string, modelId: string, promptVersion: string): Job {
    const paper = this.store.getPaper(paperKey);
    if (paper === null) throw notFound(`paper not found: ${paperKey}`);
    // 'partial' is translatable: a paper whose figures/tables/scanned pages are
    // unsupported still has translatable prose, and the spec requires those
    // papers to be readable. Only a paper with no usable text, a failed
    // acquisition, or one still being fetched is refused.
    if (paper.status !== 'ready' && paper.status !== 'partial') {
      throw invalidInput(`paper ${paperKey} is not ready for translation (status=${paper.status})`);
    }

    const existing = this.store.getJobForPaper(paperKey);

    // A finished job is replayed, not re-run.
    if (existing !== null && TERMINAL_STATES.includes(existing.state)) return existing;

    // Already running this exact paper: idempotent start.
    if (existing !== null && existing.state === 'running') return existing;

    const active = this.currentActive();
    if (active !== null && active.paperKey !== paperKey) {
      throw busy(`another translation job is already running for ${active.paperKey}`);
    }

    if (existing !== null) {
      if (!RESTARTABLE_STATES.includes(existing.state)) {
        throw invalidInput(`job ${existing.jobId} cannot be started from state ${existing.state}`);
      }
      // The revision's pinned model/prompt wins over whatever was requested.
      return this.persist({
        ...existing,
        state: 'running',
        pauseReason: null,
        completedBlocks: this.countCompleted(existing),
        totalTranslatableBlocks: this.countTranslatable(paperKey),
      });
    }

    if (typeof modelId !== 'string' || modelId.length === 0) throw invalidInput('modelId is required');
    if (typeof promptVersion !== 'string' || promptVersion.length === 0) throw invalidInput('promptVersion is required');

    const job: Job = {
      jobId: randomUUID(),
      paperKey,
      modelId,
      promptVersion,
      generation: 1,
      state: 'running',
      pauseReason: null,
      completedBlocks: 0,
      totalTranslatableBlocks: this.countTranslatable(paperKey),
      usage: EMPTY_USAGE,
      updatedAt: nowIso(),
      currentPage: null,
    };
    return this.persist(job);
  }

  /**
   * Replace the revision's translation identity with a fresh job on the model the user
   * just confirmed. Unlike startJob this never replays a finished job and never keeps the
   * revision's pinned model: the store journals the reset intent, removes the old
   * translations and job record, and publishes the new job in one recoverable sequence,
   * so a crash half-way recovers to paused/interrupted rather than a half-cleared paper.
   * Nothing here talks to the provider; the caller decides whether to drive the job.
   */
  restartJob(paperKey: string, request: RestartTranslationRequest, promptVersion: string): Job {
    const paper = this.store.getPaper(paperKey);
    if (paper === null) throw notFound(`paper not found: ${paperKey}`);
    if (paper.status !== 'ready' && paper.status !== 'partial') {
      throw invalidInput(`paper ${paperKey} is not ready for translation (status=${paper.status})`);
    }
    const active = this.currentActive();
    if (active !== null && active.paperKey !== paperKey) {
      throw busy(`another translation job is already running for ${active.paperKey}`);
    }
    return this.store.restartTranslation(paperKey, request, promptVersion);
  }

  /** Startup: finish any restart a crash interrupted, before interrupted jobs are recovered. */
  recoverRestarts(): void {
    this.store.recoverRestarts();
  }

  /** Pause a running job with a reason. currentPage is cleared: it is the signal that
   * distinguishes actively-sending from waiting/stopped, so a paused job carries none. */
  pauseJob(jobId: string, reason: Exclude<PauseReason, null>): Job {
    const job = this.requireJob(jobId);
    if (job.state !== 'running') throw invalidInput(`job ${jobId} cannot be paused from state ${job.state}`);
    return this.persist({ ...job, state: 'paused', pauseReason: reason, currentPage: null });
  }

  /** Resume a paused or failed job at the user's request. */
  resumeJob(jobId: string): Job {
    const job = this.requireJob(jobId);
    if (job.state !== 'paused' && job.state !== 'failed') {
      throw invalidInput(`job ${jobId} cannot be resumed from state ${job.state}`);
    }
    const active = this.currentActive();
    if (active !== null && active.jobId !== jobId) {
      throw busy(`another translation job is already running for ${active.paperKey}`);
    }
    return this.persist({
      ...job,
      state: 'running',
      pauseReason: null,
      completedBlocks: this.countCompleted(job),
      currentPage: null,
    });
  }

  /** Mark a running job as cleanly completed. */
  completeJob(jobId: string): Job {
    const job = this.requireJob(jobId);
    if (job.state !== 'running') throw invalidInput(`job ${jobId} cannot complete from state ${job.state}`);
    return this.persist({ ...job, state: 'completed', pauseReason: null, currentPage: null });
  }

  /** Mark a running job as completed with gaps (some blocks failed/unsupported). */
  completeJobWithGaps(jobId: string): Job {
    const job = this.requireJob(jobId);
    if (job.state !== 'running') throw invalidInput(`job ${jobId} cannot complete from state ${job.state}`);
    return this.persist({ ...job, state: 'completed_with_gaps', pauseReason: null, currentPage: null });
  }

  /**
   * Close out a running job, choosing `completed` only when every translatable
   * block has a completed translation for the pinned model/prompt. Any failed,
   * unsupported or never-attempted block yields `completed_with_gaps`.
   *
   * A block the extractor marked `translatable:false` (figure, table, reference,
   * unsupported region) is never counted here at all — it was never a translation
   * attempt, so its presence must not by itself downgrade an otherwise-complete run.
   */
  finalizeJob(jobId: string): Job {
    const job = this.requireJob(jobId);
    if (job.state !== 'running') throw invalidInput(`job ${jobId} cannot be finalized from state ${job.state}`);
    const total = this.countTranslatable(job.paperKey);
    const done = this.countCompleted(job);
    const state: JobState = done === total ? 'completed' : 'completed_with_gaps';
    return this.persist({ ...job, state, pauseReason: null, completedBlocks: done, totalTranslatableBlocks: total, currentPage: null });
  }

  /** Mark a running job as failed. */
  failJob(jobId: string, _error?: AppError): Job {
    const job = this.requireJob(jobId);
    if (job.state !== 'running' && job.state !== 'paused') {
      throw invalidInput(`job ${jobId} cannot fail from state ${job.state}`);
    }
    return this.persist({ ...job, state: 'failed', pauseReason: null, currentPage: null });
  }

  // ------------------------------------------------------------ generation

  /**
   * Cancel a job and bump its generation so in-flight results are discarded.
   * The job returns to `idle` and the active slot is freed.
   */
  cancelJob(jobId: string): Job {
    const job = this.requireJob(jobId);
    return this.persist({
      ...job,
      generation: job.generation + 1,
      state: 'idle',
      pauseReason: null,
    });
  }

  /**
   * Invalidate all work tied to the current block identity before the stored
   * PDF is extracted again. Persist the generation bump before dropping the
   * job record, so an already-running worker can never accept a late result.
   */
  invalidateForReextraction(paperKey: string): Job | null {
    const job = this.store.getJobForPaper(paperKey);
    if (job === null) {
      this.store.clearDerivedWork(paperKey);
      return null;
    }
    const invalidated = this.cancelJob(job.jobId);
    this.store.clearDerivedWork(paperKey);
    return invalidated;
  }

  /**
   * After a re-extraction carried finished translations over to the new blocks, pin a fresh
   * job to the model and prompt version that made them: the revision keeps its model, and a
   * resume sends only the paragraphs that lost their translation. Nothing is sent here — the
   * job starts completed when every page is covered, otherwise paused(reextracted) until the
   * user resumes it. The new job id also keeps any late answer for the old blocks out.
   */
  adoptCarriedTranslations(paperKey: string, modelId: string, promptVersion: string): Job {
    if (this.store.getJobForPaper(paperKey) !== null) throw invalidInput(`paper ${paperKey} already has a translation job`);
    const draft: Job = {
      jobId: randomUUID(),
      paperKey,
      modelId,
      promptVersion,
      generation: 1,
      state: 'paused',
      pauseReason: 'reextracted',
      completedBlocks: 0,
      totalTranslatableBlocks: this.countTranslatable(paperKey),
      usage: EMPTY_USAGE,
      updatedAt: nowIso(),
      currentPage: null,
    };
    const done = this.countCompleted(draft);
    const complete = done === draft.totalTranslatableBlocks;
    return this.persist({ ...draft, completedBlocks: done, state: complete ? 'completed' : 'paused', pauseReason: complete ? null : 'reextracted' });
  }

  /**
   * Called when a paper's data is deleted: bump the generation so any late
   * result is discarded, and free the active slot.
   */
  onPaperDeleted(paperKey: string): Job | null {
    const job = this.store.getJobForPaper(paperKey);
    if (job === null) return null;
    return this.persist({ ...job, generation: job.generation + 1, state: 'idle', pauseReason: null });
  }

  /**
   * Delete a revision's app-owned data together with its job record.
   * Local only — no remote/arXiv data is touched.
   */
  deletePaperAndJobs(paperKey: string): void {
    this.onPaperDeleted(paperKey);
    this.store.deletePaper(paperKey);
  }

  /**
   * Store a translation result produced by a worker.
   * Returns false (and writes nothing) when the result belongs to a stale
   * generation or to a job/paper that no longer exists.
   */
  acceptResult(jobId: string, generation: number, translation: Translation): boolean {
    const job = this.store.getJob(jobId);
    if (job === null) return false;
    if (job.generation !== generation) return false;
    if (this.store.getPaper(job.paperKey) === null) return false;

    this.store.saveTranslation(job.paperKey, translation);
    const fresh = this.store.getJob(jobId);
    if (fresh === null || fresh.generation !== generation) return false;
    this.persist({ ...fresh, completedBlocks: this.countCompleted(fresh) });
    return true;
  }

  // -------------------------------------------------------------- recovery

  /**
   * Startup recovery: every persisted `running` job is turned into
   * paused(interrupted), because no worker survived the restart.
   * Returns the ids that were recovered; safe to call repeatedly.
   */
  recoverInterrupted(): string[] {
    const recovered: string[] = [];
    for (const job of this.store.listJobs()) {
      if (job.state !== 'running') continue;
      this.persist({ ...job, state: 'paused', pauseReason: 'interrupted' });
      recovered.push(job.jobId);
    }
    return recovered;
  }

  // -------------------------------------------------------------- progress

  /** Record progress for a job. */
  updateProgress(jobId: string, completedBlocks: number): Job {
    const job = this.requireJob(jobId);
    if (!Number.isInteger(completedBlocks) || completedBlocks < 0) {
      throw invalidInput('completedBlocks must be a non-negative integer');
    }
    return this.persist({ ...job, completedBlocks });
  }

  /** Record the latest observed usage/limits for a job. */
  updateUsage(jobId: string, usage: Usage): Job {
    const job = this.requireJob(jobId);
    return this.persist({ ...job, usage });
  }

  /** Record which page is currently being sent. This is the signal a caller reads to tell
   * actively-working apart from waiting/stopped, so it is only ever set on a running job. */
  updateCurrentPage(jobId: string, page: number | null): Job {
    const job = this.requireJob(jobId);
    if (page !== null && (!Number.isInteger(page) || page < 1)) throw invalidInput('currentPage must be a positive integer or null');
    if (job.state !== 'running') throw invalidInput(`job ${jobId} cannot update currentPage from state ${job.state}`);
    return this.persist({ ...job, currentPage: page });
  }
}

export { appError, busy, invalidInput, notFound };
export default JobManager;
