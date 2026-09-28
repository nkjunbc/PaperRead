import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { storageError } from './errors';

/**
 * Commit envelope. A record is only considered complete when the file parses
 * AND `checksum` matches sha256(data). A torn or truncated write fails one of
 * those checks, so partial writes are never read as completed records.
 */
export interface Envelope {
  v: number;
  checksum: string;
  data: string;
}

const ENVELOPE_VERSION = 1;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Write bytes to `file` atomically: temp file in the same directory, fsync, then rename. */
export function atomicWriteBytes(file: string, bytes: Buffer): void {
  const dir = dirname(file);
  if (!existsSync(dir)) throw storageError(`storage directory does not exist: ${dir}`);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (cause) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw storageError(`failed to write ${file}`, cause);
  }
}

/** Serialize `value` into a checksummed envelope and write it atomically. */
export function writeRecord(file: string, value: unknown): void {
  let data: string;
  try {
    data = JSON.stringify(value);
  } catch (cause) {
    throw storageError(`failed to serialize record for ${file}`, cause);
  }
  const envelope: Envelope = { v: ENVELOPE_VERSION, checksum: sha256(data), data };
  atomicWriteBytes(file, Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/**
 * Read a committed record. Returns null when the file is absent, unparsable,
 * of an unknown version, or when the checksum does not match — i.e. anything
 * that is not a verified complete write.
 */
export function readRecord<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.v !== ENVELOPE_VERSION) return null;
  if (typeof envelope.data !== 'string' || typeof envelope.checksum !== 'string') return null;
  if (sha256(envelope.data) !== envelope.checksum) return null;
  try {
    return JSON.parse(envelope.data) as T;
  } catch {
    return null;
  }
}

/** Best-effort removal of stale temp files left by a crashed write. */
export function removeStaleTemp(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
