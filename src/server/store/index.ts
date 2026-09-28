import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Block, Highlight, Job, Paper, RestartTranslationRequest, Translation } from '../../shared/contracts';
import { atomicWriteBytes, readRecord, writeRecord } from './atomic';
import { AppErrorException, appError, busy, invalidInput, notFound, storageError } from './errors';
import {
  assertSafeKey,
  validateBlock,
  validateConversationRecord,
  validateHighlight,
  validateJob,
  validatePaper,
  validateRestartTranslationRequest,
  validateTranslation,
  type ConversationRecord,
} from './validate';
import {
  completeTranslationReset,
  makeTranslationResetIntent,
  readTranslationReset,
  resetJournalPath,
  type TranslationResetRecord,
  writeTranslationReset,
} from './restart';

export { AppErrorException, appError, busy, invalidInput, notFound, storageError } from './errors';
export type { Envelope } from './atomic';
export type { ConversationRecord } from './validate';

const PAPER_FILE = 'paper.json';
const BLOCKS_FILE = 'blocks.json';
const TRANSLATIONS_FILE = 'translations.json';
const JOB_FILE = 'job.json';
const PDF_FILE = 'original.pdf';
const PDF_MARKER = 'pdf.committed';
const JOBS_INDEX = 'jobs-index.json';
const HIGHLIGHTS_FILE = 'highlights.json';
const CHAT_FILE = 'chat.json';

/** Result of a local delete. `scope` is always 'local' — the app never deletes remote/arXiv data. */
export interface DeleteReport {
  paperKey: string;
  scope: 'local';
  remoteDeleted: false;
  removedPaper: boolean;
  removedPdf: boolean;
  removedBlocks: number;
  removedTranslations: number;
  removedJob: boolean;
  removedHighlights: number;
  removedChatMessages: number;
}

/** Composite identity of a translation attempt. */
function translationId(t: Pick<Translation, 'blockId' | 'sourceHash' | 'modelId' | 'promptVersion'>): string {
  return `${t.blockId}\u0000${t.sourceHash}\u0000${t.modelId}\u0000${t.promptVersion}`;
}

/**
 * File-backed, per-paperKey store for the app-owned folder.
 *
 * Layout:
 *   <root>/<paperKey>/paper.json         checksummed Paper record
 *   <root>/<paperKey>/blocks.json        checksummed Block[]
 *   <root>/<paperKey>/translations.json  checksummed Translation[]
 *   <root>/<paperKey>/job.json           checksummed Job
 *   <root>/<paperKey>/original.pdf       source PDF bytes
 *   <root>/<paperKey>/chat.json          checksummed question conversation
 *   <root>/jobs-index.json               jobId -> paperKey lookup
 *
 * Every write goes through a temp-file + fsync + rename commit and every record
 * carries a sha256 checksum, so a torn write is never read back as a complete
 * record. Failures raise an AppErrorException with code STORAGE.
 */
export class PaperStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Create the app folder if it is missing. Not called implicitly by writes. */
  ensureRoot(): void {
    try {
      mkdirSync(this.root, { recursive: true });
    } catch (cause) {
      throw storageError(`failed to create storage root ${this.root}`, cause);
    }
  }

  private paperDir(paperKey: string): string {
    assertSafeKey(paperKey);
    return join(this.root, paperKey);
  }

  /**
   * Ensure the per-paper directory exists. The root itself is NOT created
   * implicitly: an unreachable root is a real storage fault and must surface
   * as STORAGE rather than silently materialising a new tree.
   */
  private ensurePaperDir(paperKey: string): string {
    const dir = this.paperDir(paperKey);
    if (!existsSync(this.root)) throw storageError(`storage root does not exist: ${this.root}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (cause) {
      throw storageError(`failed to create paper directory for ${paperKey}`, cause);
    }
    return dir;
  }

  private resetRecordForPaper(paperKey: string): TranslationResetRecord | null {
    return readTranslationReset(resetJournalPath(join(this.root, paperKey)));
  }

  /**
   * Derived translation/job reads are blocked while a reset intent is
   * incomplete. Metadata, blocks, PDFs and highlights intentionally do not use
   * this gate and remain readable during recovery.
   */
  assertTranslationReadable(paperKey: string): void {
    assertSafeKey(paperKey);
    const reset = this.resetRecordForPaper(paperKey);
    if (reset !== null && reset.paperKey !== paperKey) {
      throw storageError(`translation reset journal paperKey mismatch for ${paperKey}`);
    }
    if (reset === null || reset.phase === 'complete') {
      if (reset !== null) {
        const current = this.readJobForPaperRaw(paperKey);
        if (current === null || current.jobId !== reset.jobId) {
          throw storageError(`translation reset receipt has no matching current job for ${paperKey}`);
        }
      }
      return;
    }
    throw busy(`translation reset is in progress for ${paperKey}`);
  }

  // ---------------------------------------------------------------- papers

  /** Persist a paper (and optionally its PDF bytes) atomically. */
  savePaper(paper: Paper, pdfBytes?: Buffer | Uint8Array): Paper {
    const validated = validatePaper(paper);
    const dir = this.ensurePaperDir(validated.paperKey);
    if (pdfBytes !== undefined) {
      this.writePdfBytes(dir, pdfBytes);
    }
    writeRecord(join(dir, PAPER_FILE), validated);
    return validated;
  }

  /** Commit PDF bytes plus the marker that records "this revision owns a PDF". */
  private writePdfBytes(dir: string, bytes: Buffer | Uint8Array): void {
    atomicWriteBytes(join(dir, PDF_FILE), Buffer.from(bytes));
    writeRecord(join(dir, PDF_MARKER), { committedAt: new Date().toISOString() });
  }

  /**
   * Load a paper. Returns null when no committed record exists.
   * When a revision committed PDF bytes that have since disappeared, the
   * metadata and file no longer agree, so a ready/partial record is reported
   * as 'failed' rather than as a usable revision.
   */
  getPaper(paperKey: string): Paper | null {
    assertSafeKey(paperKey);
    const dir = join(this.root, paperKey);
    const record = readRecord<Paper>(join(dir, PAPER_FILE));
    if (record === null) return null;
    let paper: Paper;
    try {
      paper = validatePaper(record);
    } catch {
      return null;
    }
    const pdfWasCommitted = readRecord<unknown>(join(dir, PDF_MARKER)) !== null;
    const pdfPresent = existsSync(join(dir, PDF_FILE));
    if (pdfWasCommitted && !pdfPresent && (paper.status === 'ready' || paper.status === 'partial')) {
      return { ...paper, status: 'failed' };
    }
    return paper;
  }

  /** List paperKeys that have a committed paper record. */
  listPapers(): string[] {
    if (!existsSync(this.root)) return [];
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch (cause) {
      throw storageError(`failed to list storage root ${this.root}`, cause);
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      let isDir = false;
      try {
        isDir = statSync(join(this.root, entry)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (readRecord<Paper>(join(this.root, entry, PAPER_FILE)) === null) continue;
      keys.push(entry);
    }
    return keys.sort();
  }

  // ------------------------------------------------------------------ pdf

  /** Read the stored PDF bytes, or null when absent. */
  getPdf(paperKey: string): Buffer | null {
    assertSafeKey(paperKey);
    const file = join(this.root, paperKey, PDF_FILE);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file);
    } catch (cause) {
      throw storageError(`failed to read PDF for ${paperKey}`, cause);
    }
  }

  /** Store PDF bytes for an existing paper. */
  savePdf(paperKey: string, bytes: Buffer | Uint8Array): void {
    const dir = this.ensurePaperDir(paperKey);
    this.writePdfBytes(dir, bytes);
  }

  // --------------------------------------------------------------- blocks

  /**
   * Replace the block list for a paper in a single atomic commit.
   * Validation happens up front, so a bad batch never leaves partial blocks.
   */
  saveBlocks(paperKey: string, blocks: Block[]): Block[] {
    assertSafeKey(paperKey);
    if (!Array.isArray(blocks)) throw invalidInput('blocks must be an array');
    const validated = blocks.map((b) => validateBlock(b, paperKey));
    const seen = new Set<string>();
    for (const b of validated) {
      if (seen.has(b.blockId)) throw invalidInput(`duplicate blockId in batch: ${b.blockId}`);
      seen.add(b.blockId);
    }
    const dir = this.ensurePaperDir(paperKey);
    writeRecord(join(dir, BLOCKS_FILE), validated);
    return validated;
  }

  /** Read the committed block list, ordered. Returns [] when absent or torn. */
  listBlocks(paperKey: string): Block[] {
    assertSafeKey(paperKey);
    const record = readRecord<Block[]>(join(this.root, paperKey, BLOCKS_FILE));
    if (record === null || !Array.isArray(record)) return [];
    try {
      return record.map((b) => validateBlock(b, paperKey)).sort((a, b) => a.order - b.order);
    } catch {
      return [];
    }
  }

  /** Look up a single block by id. */
  getBlock(paperKey: string, blockId: string): Block | null {
    return this.listBlocks(paperKey).find((b) => b.blockId === blockId) ?? null;
  }

  // --------------------------------------------------------- translations

  /**
   * Upsert a translation, keyed by blockId + sourceHash + modelId + promptVersion,
   * so at most one record exists per combination. The sourceHash must match the
   * stored block; a completed result is never overwritten by a later failure.
   */
  saveTranslation(paperKey: string, translation: Translation): Translation {
    assertSafeKey(paperKey);
    const validated = validateTranslation(translation);
    const block = this.getBlock(paperKey, validated.blockId);
    if (block === null) throw notFound(`block not found for translation: ${validated.blockId}`);
    if (block.sourceHash !== validated.sourceHash) {
      throw appError(
        'SOURCE_CHANGED',
        `translation sourceHash ${validated.sourceHash} does not match block sourceHash ${block.sourceHash}`,
        false,
      );
    }

    const existing = this.listTranslations(paperKey);
    const id = translationId(validated);
    const index = existing.findIndex((t) => translationId(t) === id);

    if (index >= 0) {
      const current = existing[index];
      // A completed translation is authoritative: never downgrade it.
      if (current.status === 'completed' && validated.status !== 'completed') return current;
      existing[index] = validated;
    } else {
      existing.push(validated);
    }

    const dir = this.ensurePaperDir(paperKey);
    writeRecord(join(dir, TRANSLATIONS_FILE), existing);
    return validated;
  }

  private listTranslationsRaw(paperKey: string): Translation[] {
    const record = readRecord<Translation[]>(join(this.root, paperKey, TRANSLATIONS_FILE));
    if (record === null || !Array.isArray(record)) return [];
    try {
      return record.map((t) => validateTranslation(t));
    } catch {
      return [];
    }
  }

  /** Read all committed translations for a paper. */
  listTranslations(paperKey: string): Translation[] {
    assertSafeKey(paperKey);
    this.assertTranslationReadable(paperKey);
    return this.listTranslationsRaw(paperKey);
  }

  /**
   * Find a reusable completed translation. Reuse requires an exact match on
   * blockId, sourceHash, modelId and promptVersion — a changed source hash
   * always forces a fresh translation.
   */
  findReusableTranslation(
    paperKey: string,
    blockId: string,
    sourceHash: string,
    modelId: string,
    promptVersion: string,
  ): Translation | null {
    const id = translationId({ blockId, sourceHash, modelId, promptVersion });
    return (
      this.listTranslations(paperKey).find((t) => t.status === 'completed' && t.text !== null && translationId(t) === id) ?? null
    );
  }

  // ------------------------------------------------------------------ job

  /** Persist the job record for a paper and keep the jobId index in sync. */
  saveJob(job: Job): Job {
    this.assertTranslationReadable(job.paperKey);
    const validated = validateJob(job);
    const dir = this.ensurePaperDir(validated.paperKey);
    writeRecord(join(dir, JOB_FILE), validated);
    const index = this.readJobsIndex();
    if (index[validated.jobId] !== validated.paperKey) {
      index[validated.jobId] = validated.paperKey;
      writeRecord(join(this.root, JOBS_INDEX), index);
    }
    return validated;
  }

  private readJobForPaperRaw(paperKey: string): Job | null {
    const record = readRecord<Job>(join(this.root, paperKey, JOB_FILE));
    if (record === null) return null;
    try {
      return validateJob(record);
    } catch {
      return null;
    }
  }

  /** Read the job record attached to a paper revision. */
  getJobForPaper(paperKey: string): Job | null {
    assertSafeKey(paperKey);
    this.assertTranslationReadable(paperKey);
    return this.readJobForPaperRaw(paperKey);
  }

  /** Read a job by id via the index. */
  getJob(jobId: string): Job | null {
    const paperKey = this.readJobsIndex()[jobId];
    if (paperKey === undefined) return null;
    const job = this.getJobForPaper(paperKey);
    return job !== null && job.jobId === jobId ? job : null;
  }

  /** All committed jobs across every paper. */
  listJobs(): Job[] {
    const jobs: Job[] = [];
    for (const key of this.listPapers()) {
      const job = this.getJobForPaper(key);
      if (job !== null) jobs.push(job);
    }
    return jobs;
  }

  private readJobsIndex(): Record<string, string> {
    const record = readRecord<Record<string, string>>(join(this.root, JOBS_INDEX));
    return record !== null && typeof record === 'object' ? { ...record } : {};
  }

  private removeFromJobsIndex(paperKey: string): void {
    const index = this.readJobsIndex();
    let changed = false;
    for (const [jobId, key] of Object.entries(index)) {
      if (key === paperKey) {
        delete index[jobId];
        changed = true;
      }
    }
    if (changed) writeRecord(join(this.root, JOBS_INDEX), index);
  }

  private writeRestartJob(job: Job): void {
    writeRecord(join(this.paperDir(job.paperKey), JOB_FILE), validateJob(job));
  }

  private writeRestartJobsIndex(record: TranslationResetRecord): void {
    const index = this.readJobsIndex();
    for (const [jobId, paperKey] of Object.entries(index)) {
      if (paperKey === record.paperKey || jobId === record.expectedJobId) delete index[jobId];
    }
    index[record.jobId] = record.paperKey;
    writeRecord(join(this.root, JOBS_INDEX), index);
  }

  private restartJob(record: TranslationResetRecord, state: Job['state'], pauseReason: Job['pauseReason']): Job {
    return {
      jobId: record.jobId,
      paperKey: record.paperKey,
      modelId: record.modelId,
      promptVersion: record.promptVersion,
      generation: record.generation,
      state,
      pauseReason,
      completedBlocks: 0,
      totalTranslatableBlocks: record.totalTranslatableBlocks,
      usage: { inputTokens: null, outputTokens: null, limits: null, observedAt: null },
      updatedAt: new Date().toISOString(),
      currentPage: null,
    };
  }

  private resetDerivedWork(record: TranslationResetRecord, state: Job['state'], pauseReason: Job['pauseReason']): Job {
    const dir = this.paperDir(record.paperKey);
    try {
      rmSync(join(dir, TRANSLATIONS_FILE), { force: true });
      rmSync(join(dir, JOB_FILE), { force: true });
      const job = this.restartJob(record, state, pauseReason);
      this.writeRestartJob(job);
      this.writeRestartJobsIndex(record);
      return job;
    } catch (cause) {
      if (cause instanceof AppErrorException) throw cause;
      throw storageError(`failed to publish translation restart for ${record.paperKey}`, cause);
    }
  }

  private recoverReset(record: TranslationResetRecord): void {
    const dir = this.paperDir(record.paperKey);
    // A paper deletion wins a concurrent restart. Never recreate its directory
    // or any job merely because an old reset intent remains.
    if (!existsSync(dir) || this.getPaper(record.paperKey) === null) return;

    this.resetDerivedWork(record, 'paused', 'interrupted');
    writeTranslationReset(resetJournalPath(dir), completeTranslationReset(record));
  }

  /**
   * Recover all durable reset intents left by a crash or a failed storage
   * operation. Existing paper metadata/PDF/blocks/highlights are untouched.
   */
  recoverRestarts(): void {
    if (!existsSync(this.root)) return;
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch (cause) {
      throw storageError(`failed to scan translation reset journals`, cause);
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const dir = join(this.root, entry);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const reset = readTranslationReset(resetJournalPath(dir));
      if (reset === null || reset.phase === 'complete') continue;
      if (reset.paperKey !== entry) {
        throw storageError(`translation reset journal paperKey mismatch for ${entry}`);
      }
      this.recoverReset(reset);
    }
  }

  /**
   * The receipt of the last completed restart, so a replayed request can be recognised
   * before anything is stopped or deleted. Null when the paper was never restarted; an
   * incomplete reset still surfaces as BUSY through the read gate.
   */
  lastTranslationRestart(paperKey: string): Pick<TranslationResetRecord, 'requestId' | 'expectedJobId' | 'modelId' | 'promptVersion' | 'jobId'> | null {
    assertSafeKey(paperKey);
    this.assertTranslationReadable(paperKey);
    const reset = this.resetRecordForPaper(paperKey);
    if (reset === null || reset.phase !== 'complete') return null;
    const { requestId, expectedJobId, modelId, promptVersion, jobId } = reset;
    return { requestId, expectedJobId, modelId, promptVersion, jobId };
  }

  /**
   * Atomically begin a new translation identity and clear only derived
   * translation/job records. The intent is committed before any deletion.
   */
  restartTranslation(paperKey: string, input: RestartTranslationRequest, promptVersion: string): Job {
    assertSafeKey(paperKey);
    const request = validateRestartTranslationRequest(input);
    if (typeof promptVersion !== 'string' || promptVersion.length === 0) {
      throw invalidInput('promptVersion is required');
    }
    if (this.getPaper(paperKey) === null) throw notFound(`paper not found: ${paperKey}`);

    const dir = this.paperDir(paperKey);
    const existingReset = readTranslationReset(resetJournalPath(dir));
    if (existingReset !== null) {
      if (existingReset.phase === 'intent') {
        throw busy(`translation reset is in progress for ${paperKey}`);
      }
      const current = this.readJobForPaperRaw(paperKey);
      if (current === null || current.jobId !== existingReset.jobId) {
        throw storageError(`translation reset receipt has no matching current job for ${paperKey}`);
      }
      const sameRequest =
        existingReset.requestId === request.requestId &&
        existingReset.expectedJobId === request.expectedJobId &&
        existingReset.modelId === request.modelId &&
        existingReset.promptVersion === promptVersion;
      if (sameRequest) return current;
      if (existingReset.requestId === request.requestId) {
        throw busy(`translation restart request ${request.requestId} conflicts with its completion receipt`);
      }
      if (request.expectedJobId !== current.jobId) {
        throw busy(`translation restart expected job ${request.expectedJobId}, current job is ${current.jobId}`);
      }
    }

    const previous = this.readJobForPaperRaw(paperKey);
    if (previous === null) throw notFound(`job not found for paper: ${paperKey}`);
    if (previous.jobId !== request.expectedJobId) {
      throw busy(`translation restart expected job ${request.expectedJobId}, current job is ${previous.jobId}`);
    }

    // Progress is counted in pages, exactly as the job manager counts it: the pages holding at
    // least one translatable block. A paragraph count here showed "7/103" beside "8쪽 처리 중".
    const totalTranslatableBlocks = new Set(
      this.listBlocks(paperKey).filter((block) => block.translatable).map((block) => block.regions[0]?.page ?? 1),
    ).size;
    const intent = makeTranslationResetIntent(
      paperKey,
      request,
      promptVersion,
      randomUUID(),
      previous.generation + 1,
      totalTranslatableBlocks,
      new Date().toISOString(),
    );

    // This is the commit point for destructive work. If it fails, old data
    // remains untouched and no recovery record is left behind.
    writeTranslationReset(resetJournalPath(dir), intent);

    try {
      const fresh = this.resetDerivedWork(intent, 'running', null);
      writeTranslationReset(resetJournalPath(dir), completeTranslationReset(intent));
      return fresh;
    } catch (cause) {
      if (cause instanceof AppErrorException) throw cause;
      throw storageError(`failed to restart translation for ${paperKey}`, cause);
    }
  }

  /**
   * Remove work derived from a prior block identity while retaining the
   * revision metadata and its committed PDF for re-extraction.
   */
  clearDerivedWork(paperKey: string): void {
    assertSafeKey(paperKey);
    this.assertTranslationReadable(paperKey);
    const dir = this.paperDir(paperKey);
    try {
      rmSync(join(dir, TRANSLATIONS_FILE), { force: true });
      rmSync(join(dir, JOB_FILE), { force: true });
      rmSync(resetJournalPath(dir), { force: true });
    } catch (cause) {
      throw storageError(`failed to clear derived work for ${paperKey}`, cause);
    }
    if (existsSync(this.root)) this.removeFromJobsIndex(paperKey);
  }

  // --------------------------------------------------------- highlights

  /**
   * Upsert a highlight for a paper, keyed by highlightId. Highlights are keyed
   * by page-ratio rects, not by block identity, so they survive a re-extraction
   * that changes block ids.
   */
  saveHighlight(paperKey: string, highlight: Highlight): Highlight {
    assertSafeKey(paperKey);
    const validated = validateHighlight(highlight, paperKey);
    const existing = this.listHighlights(paperKey);
    const index = existing.findIndex((h) => h.highlightId === validated.highlightId);
    if (index >= 0) existing[index] = validated;
    else existing.push(validated);
    const dir = this.ensurePaperDir(paperKey);
    writeRecord(join(dir, HIGHLIGHTS_FILE), existing);
    return validated;
  }

  /** Read all committed highlights for a paper. Torn or unreadable records read as []. */
  listHighlights(paperKey: string): Highlight[] {
    assertSafeKey(paperKey);
    const record = readRecord<Highlight[]>(join(this.root, paperKey, HIGHLIGHTS_FILE));
    if (record === null || !Array.isArray(record)) return [];
    try {
      return record.map((h) => validateHighlight(h, paperKey));
    } catch {
      return [];
    }
  }

  /** Look up a single highlight by id. */
  getHighlight(paperKey: string, highlightId: string): Highlight | null {
    return this.listHighlights(paperKey).find((h) => h.highlightId === highlightId) ?? null;
  }

  /** Remove one highlight. Returns true when a record was actually removed. */
  deleteHighlight(paperKey: string, highlightId: string): boolean {
    assertSafeKey(paperKey);
    const existing = this.listHighlights(paperKey);
    const next = existing.filter((h) => h.highlightId !== highlightId);
    if (next.length === existing.length) return false;
    const dir = this.ensurePaperDir(paperKey);
    writeRecord(join(dir, HIGHLIGHTS_FILE), next);
    return true;
  }

  // --------------------------------------------------------- conversation

  /**
   * The paper's stored question conversation. A torn or invalid record reads as no
   * conversation, like highlights: the reader starts over rather than the screen failing.
   */
  getConversation(paperKey: string): ConversationRecord | null {
    assertSafeKey(paperKey);
    const record = readRecord<ConversationRecord>(join(this.root, paperKey, CHAT_FILE));
    if (record === null) return null;
    try {
      return validateConversationRecord(record);
    } catch {
      return null;
    }
  }

  /**
   * Replace the paper's conversation in one atomic commit. Only settled messages are
   * stored. A paper that no longer exists is not recreated by a late answer.
   */
  saveConversation(paperKey: string, record: ConversationRecord): ConversationRecord {
    assertSafeKey(paperKey);
    const validated = validateConversationRecord(record);
    if (readRecord<unknown>(join(this.root, paperKey, PAPER_FILE)) === null) throw notFound(`paper not found: ${paperKey}`);
    const dir = this.ensurePaperDir(paperKey);
    writeRecord(join(dir, CHAT_FILE), validated);
    return validated;
  }

  /** Remove the paper's conversation. Returns true when a file was actually removed. */
  deleteConversation(paperKey: string): boolean {
    assertSafeKey(paperKey);
    const file = join(this.root, paperKey, CHAT_FILE);
    if (!existsSync(file)) return false;
    try {
      rmSync(file, { force: true });
    } catch (cause) {
      throw storageError(`failed to delete the conversation for ${paperKey}`, cause);
    }
    return true;
  }

  // --------------------------------------------------------------- delete

  /**
   * Remove every app-owned artefact for one revision: PDF, metadata, blocks,
   * translations, job record, highlights and the question conversation. Strictly local — nothing on arXiv is touched
   * and the report never claims a remote deletion.
   */
  deletePaper(paperKey: string): DeleteReport {
    assertSafeKey(paperKey);
    const dir = join(this.root, paperKey);
    const report: DeleteReport = {
      paperKey,
      scope: 'local',
      remoteDeleted: false,
      removedPaper: this.getPaper(paperKey) !== null,
      removedPdf: existsSync(join(dir, PDF_FILE)),
      removedBlocks: this.listBlocks(paperKey).length,
      removedTranslations: this.listTranslationsRaw(paperKey).length,
      removedJob: this.readJobForPaperRaw(paperKey) !== null,
      removedHighlights: this.listHighlights(paperKey).length,
      removedChatMessages: this.getConversation(paperKey)?.messages.length ?? 0,
    };

    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (cause) {
        throw storageError(`failed to delete app-owned data for ${paperKey}`, cause);
      }
    }
    if (existsSync(this.root)) this.removeFromJobsIndex(paperKey);
    return report;
  }
}

export default PaperStore;
