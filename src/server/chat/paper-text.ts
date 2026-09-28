import type { Block, Paper } from '../../shared/contracts';

/** Longest paper body handed to the model; beyond it the text is cut at a paragraph boundary. */
export const PAPER_BODY_LIMIT = 600_000;

export const PAPER_CUT_NOTICE = '[The rest of the paper was cut here because of its length.]';

const FRAMING = 'The user is reading the paper below. Its full text was extracted from the PDF, so equations, tables and figures may be garbled or missing.';

/**
 * The system instructions of a paper's question thread: a minimal factual framing and the
 * paper's full extracted text — no role, no style, no answer rules. The model answers with its
 * own judgement.
 *
 * Deterministic by construction: the same revision and blocks always give byte-identical text,
 * because this text is the prefix the provider caches across every question about the paper.
 * Nothing here may depend on time, randomness, locale or the order the caller passed blocks in.
 */
export function paperInstructions(paper: Pick<Paper, 'title' | 'arxivId' | 'version'>, blocks: readonly Block[]): string {
  const title = paper.title?.replace(/\s+/g, ' ').trim() ?? '';
  const revision = paper.arxivId !== null && paper.version !== null ? `arXiv: ${paper.arxivId}v${paper.version}\n` : '';
  const head = `${FRAMING}\n\n${title ? `Title: ${title}\n` : ''}${revision}\n`;
  return `${head}<paper>\n${paperBody(blocks)}\n</paper>`;
}

/** Blocks in reading order, a `[page N]` line wherever the page changes, one blank line between
 * blocks, empty blocks left out, and the whole cut at a block boundary past the limit. */
export function paperBody(blocks: readonly Block[], limit = PAPER_BODY_LIMIT): string {
  const ordered = [...blocks].sort((a, b) => a.order - b.order || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
  const chunks: string[] = [];
  let length = 0;
  let page: number | null = null;
  for (const block of ordered) {
    const text = block.sourceText.trim();
    if (text.length === 0) continue;
    const blockPage: number | null = block.regions[0]?.page ?? page;
    const chunk = blockPage !== null && blockPage !== page ? `[page ${blockPage}]\n${text}` : text;
    const added = (chunks.length === 0 ? 0 : 2) + chunk.length;
    if (length + added > limit) {
      chunks.push(PAPER_CUT_NOTICE);
      break;
    }
    chunks.push(chunk);
    length += added;
    page = blockPage;
  }
  return chunks.join('\n\n');
}
