import type { Paper } from '../../shared/contracts';
import { extractPdf, inferTitle, sha256 } from './index';

export function identifyLocalPdf(input: string): string | null {
  return /^local-pdf-[a-f0-9]{64}$/.test(input) ? input : null;
}

/** Identity depends on bytes, so renaming the same file preserves its translations. */
export function uploadedPaper(pdf: Buffer, filename: string): Paper {
  const hash = sha256(pdf);
  const title = filename.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.pdf$/i, '').trim().slice(0, 255);
  return {
    paperKey: `local-pdf-${hash}`, sourceKind: 'local', arxivId: null, version: null,
    title: title || null, authors: [], sourceUrl: `local-pdf:${hash}`, pdfSha256: hash,
    pageCount: null, extractionVersion: null, status: 'extracting', coverage: null,
    createdAt: new Date().toISOString(),
  };
}

export async function extractUploadedPdf(paper: Paper, pdf: Buffer) {
  const { blocks, coverage, extractionVersion } = await extractPdf(pdf, paper.paperKey);
  return {
    blocks,
    paper: {
      ...paper, title: inferTitle(blocks) ?? paper.title, coverage, extractionVersion, pageCount: coverage.totalPages,
      status: coverage.textPages === 0 ? 'unsupported' : coverage.unsupportedPages.length || blocks.some((block) => block.kind === 'unsupported') ? 'partial' : 'ready',
    } satisfies Paper,
  };
}
