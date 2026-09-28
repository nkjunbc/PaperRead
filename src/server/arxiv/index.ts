import type { AppError, ErrorCode } from '../../shared/contracts';

export class SourceError extends Error implements AppError {
  constructor(public code: ErrorCode, message: string, public retryable = false,
    public reason?: string) { super(message); this.name = 'SourceError'; }
}
export interface ArxivIdentifier { arxivId: string; version: number | null; paperKey: string }

/** Only identifiers and canonical arxiv.org reading URLs, never arbitrary fetch URLs. */
export function normalizeArxiv(input: string): ArxivIdentifier {
  const invalid = () => new SourceError('INVALID_INPUT', '올바른 arXiv 식별자 또는 HTTPS 주소를 입력하세요.');
  if (typeof input !== 'string' || input.length > 512) throw invalid();
  let id = input.trim().replace(/^arxiv:/i, '');
  if (id.includes('://')) {
    // Validate the raw form too: URL parsing otherwise normalizes credentials/dot segments/ports.
    const match = /^https:\/\/arxiv\.org\/(?:abs|pdf|html)\/([^?#%\\]+)$/.exec(id);
    if (!match) throw invalid();
    id = match[1].replace(/\.pdf$/, '');
  }
  const match = /^(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v([1-9]\d*))?$/.exec(id);
  if (!match) throw invalid();
  const version = match[2] ? Number(match[2]) : null;
  if (version !== null && !Number.isSafeInteger(version)) throw invalid();
  return { arxivId: match[1], version, paperKey: match[1] + (version === null ? '' : `v${version}`) };
}
