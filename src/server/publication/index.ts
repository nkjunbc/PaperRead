import type { Block, Paper } from '../../shared/contracts';
import { SourceError } from '../arxiv/index';
import { extractPdf, inferTitle, sha256 } from '../pdf/index';
import { publicGet, validatePublicUrl, type PublicNetworkOptions } from './network';

export function identifyPublication(input: string): string | null {
  return /^pdf-[a-f0-9]{64}-[a-f0-9]{64}$/.test(input) ? input : null;
}
function text(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? '';
  }).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1]!.toLowerCase()] = text(match[2] ?? match[3] ?? match[4] ?? '');
  return result;
}
/** Read passive citation fields or one main PDF anchor only. Scripts, base tags and embedded resources are never used. */
function discover(html: string, base: string): { pdfUrl: string; title: string | null; authors: string[] } {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const metadata = new Map<string, string[]>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const fields = attributes(match[0]), name = (fields.name ?? fields.property ?? '').toLowerCase();
    if (fields.content) metadata.set(name, [...(metadata.get(name) ?? []), fields.content]);
  }
  const links = metadata.get('citation_pdf_url') ?? [];
  if (!links.length) {
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const href = attributes(match[1]!).href, label = text(match[2]!.replace(/<[^>]*>/g, ' '));
      if (!href || /supplement|appendix|supporting/i.test(label + ' ' + href)) continue;
      try {
        const url = new URL(href, base);
        if (/\.pdf$/i.test(url.pathname) && /^(?:\[?pdf\]?|paper|full\s*(?:text|paper)(?:\s*\(pdf\))?|download(?:\s*pdf)?)$/i.test(label)) links.push(href);
      } catch { /* ignore unusable anchors */ }
    }
  }
  const candidates = [...new Set(links.map((link) => {
    const url = new URL(link, base);
    // Some proceedings still advertise HTTP PDF links. Request their HTTPS equivalent only.
    if (url.protocol === 'http:') url.protocol = 'https:';
    return validatePublicUrl(url.href).href;
  }))];
  if (candidates.length !== 1) throw new SourceError('INVALID_INPUT', '이 페이지에서 논문 PDF를 하나로 확인할 수 없습니다. PDF 직접 주소를 입력하세요.');
  return { pdfUrl: candidates[0]!, title: metadata.get('citation_title')?.[0]?.slice(0, 2000) ?? null, authors: (metadata.get('citation_author') ?? []).slice(0, 100).map((author) => author.slice(0, 300)) };
}
export interface LoadedPublication { paper: Paper; pdf: Buffer }

/** A URL revision is the final PDF URL plus its content hash. It never shares an arXiv revision key. */
export async function loadPublication(input: string, options: PublicNetworkOptions = {}): Promise<LoadedPublication> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 60_000), ...(options.signal ? [options.signal] : [])]);
  const first = await publicGet(input.trim(), { ...options, signal });
  let downloaded = first, title: string | null = null, authors: string[] = [];
  if (!first.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    if (!['text/html', 'application/xhtml+xml'].includes(first.contentType)) throw new SourceError('UNSUPPORTED_PDF', '이 주소의 응답은 PDF가 아닙니다. PDF 직접 주소를 확인하세요.');
    const discovered = discover(first.bytes.toString('utf8'), first.url);
    title = discovered.title; authors = discovered.authors;
    downloaded = await publicGet(discovered.pdfUrl, { ...options, signal });
  }
  if (!downloaded.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new SourceError('UNSUPPORTED_PDF', '이 주소의 응답은 PDF가 아닙니다. 로그인 없이 접근할 수 있는 PDF 직접 주소를 확인하세요.');
  const hash = sha256(downloaded.bytes);
  return { pdf: downloaded.bytes, paper: {
    paperKey: `pdf-${sha256(downloaded.url)}-${hash}`, sourceKind: 'publication', arxivId: null, version: null,
    title, authors, sourceUrl: downloaded.url, pdfSha256: hash, pageCount: null, extractionVersion: null,
    status: 'fetching', coverage: null, createdAt: new Date().toISOString(),
  } };
}
export async function extractPublication(loaded: LoadedPublication, expectedKey: string): Promise<{ paper: Paper; blocks: Block[]; pdf: Buffer }> {
  if (loaded.paper.paperKey !== expectedKey) throw new SourceError('SOURCE_CHANGED', '논문 PDF가 열기 요청 이후 변경되었습니다. 주소를 다시 열어 새 버전으로 저장하세요.');
  const { blocks, coverage, extractionVersion } = await extractPdf(loaded.pdf, expectedKey);
  return { pdf: loaded.pdf, blocks, paper: { ...loaded.paper, title: loaded.paper.title ?? inferTitle(blocks), coverage, extractionVersion, pageCount: coverage.totalPages,
    status: coverage.textPages === 0 ? 'unsupported' : coverage.unsupportedPages.length || blocks.some((b) => b.kind === 'unsupported') ? 'partial' : 'ready' } };
}
