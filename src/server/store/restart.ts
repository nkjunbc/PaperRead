import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readRecord, writeRecord } from './atomic';
import { storageError } from './errors';
import type { RestartTranslationRequest } from '../../shared/contracts';
import { assertSafeKey, validateRestartTranslationRequest } from './validate';

export const TRANSLATION_RESET_FILE = 'translation-reset.json';

export type TranslationResetPhase = 'intent' | 'complete';

/**
 * Durable identity for one translation restart. The record is intentionally
 * self-contained: after a process restart it is enough to discard any
 * partially published derived state and create the recorded fresh job.
 */
export interface TranslationResetRecord {
  kind: 'translation-reset';
  version: 1;
  paperKey: string;
  phase: TranslationResetPhase;
  requestId: string;
  expectedJobId: string;
  modelId: string;
  promptVersion: string;
  jobId: string;
  generation: number;
  totalTranslatableBlocks: number;
  createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Validate a reset journal. Invalid on-disk records fail closed as STORAGE. */
export function validateTranslationResetRecord(value: unknown): TranslationResetRecord {
  if (!value || typeof value !== 'object') throw new Error('reset journal is not an object');
  const record = value as Partial<TranslationResetRecord>;
  if (record.kind !== 'translation-reset' || record.version !== 1) throw new Error('reset journal version is unknown');
  const paperKey = record.paperKey;
  assertSafeKey(paperKey);
  if (record.phase !== 'intent' && record.phase !== 'complete') throw new Error('reset journal phase is invalid');
  const request = validateRestartTranslationRequest({
    modelId: record.modelId,
    requestId: record.requestId,
    expectedJobId: record.expectedJobId,
  });
  if (!isNonEmptyString(record.promptVersion)) throw new Error('reset journal promptVersion is invalid');
  if (!isNonEmptyString(record.jobId)) throw new Error('reset journal jobId is invalid');
  if (!isInteger(record.generation) || record.generation < 0) throw new Error('reset journal generation is invalid');
  if (!isInteger(record.totalTranslatableBlocks) || record.totalTranslatableBlocks < 0) {
    throw new Error('reset journal totalTranslatableBlocks is invalid');
  }
  if (!isNonEmptyString(record.createdAt)) throw new Error('reset journal createdAt is invalid');
  return {
    kind: 'translation-reset',
    version: 1,
    paperKey,
    phase: record.phase,
    requestId: request.requestId,
    expectedJobId: request.expectedJobId,
    modelId: request.modelId,
    promptVersion: record.promptVersion,
    jobId: record.jobId,
    generation: record.generation,
    totalTranslatableBlocks: record.totalTranslatableBlocks,
    createdAt: record.createdAt,
  };
}

export function resetJournalPath(paperDir: string): string {
  return join(paperDir, TRANSLATION_RESET_FILE);
}

/** Read a reset journal, distinguishing absent from corrupt. */
export function readTranslationReset(file: string): TranslationResetRecord | null {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw storageError(`failed to inspect translation reset journal: ${file}`, cause);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw storageError(`translation reset journal is not a regular file: ${file}`);
  }
  const value = readRecord<unknown>(file);
  if (value === null) throw storageError(`corrupt translation reset journal: ${file}`);
  try {
    return validateTranslationResetRecord(value);
  } catch (cause) {
    throw storageError(`corrupt translation reset journal: ${file}`, cause);
  }
}

/** Write either the initial intent or its completion receipt atomically. */
export function writeTranslationReset(file: string, record: TranslationResetRecord): void {
  try {
    writeRecord(file, validateTranslationResetRecord(record));
  } catch (cause) {
    throw storageError(`failed to write translation reset journal: ${file}`, cause);
  }
}

export function makeTranslationResetIntent(
  paperKey: string,
  request: RestartTranslationRequest,
  promptVersion: string,
  jobId: string,
  generation: number,
  totalTranslatableBlocks: number,
  createdAt: string,
): TranslationResetRecord {
  return {
    kind: 'translation-reset',
    version: 1,
    paperKey,
    phase: 'intent',
    requestId: request.requestId,
    expectedJobId: request.expectedJobId,
    modelId: request.modelId,
    promptVersion,
    jobId,
    generation,
    totalTranslatableBlocks,
    createdAt,
  };
}

export function completeTranslationReset(record: TranslationResetRecord): TranslationResetRecord {
  return { ...record, phase: 'complete' };
}
