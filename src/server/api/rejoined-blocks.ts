import type { Block, SourceSpan, Translation } from '../../shared/contracts';
import { hyphenVocabulary, joinLineBreakHyphens, repairedSpaces } from '../pdf/hyphen';
import { FORMAT_PROMPT_VERSION } from '../translation/format';

/** The kinds whose words the extractor tells broken words from compounds by. */
const PROSE = new Set<Block['kind']>(['paragraph', 'heading', 'caption', 'reference']);

/** A text with every hyphen and space taken out: what a line-end repair cannot change. */
const letters = (text: string) => text.replace(/[-\u2010\u00AD ]/g, '');

const sameSpans = (a: readonly SourceSpan[], b: readonly SourceSpan[]) =>
  a.length === b.length && a.every((span, index) => span.kind === b[index].kind && span.start === b[index].start && span.end === b[index].end);

/**
 * The earlier extraction's paragraphs as the translation carry matches them. A paragraph that
 * the new extraction reads differently only because it now puts back the words broken at a line
 * end (pdf/hyphen.ts) is the same sentence. It takes the text that repair makes of it, when that
 * is exactly a new paragraph's text, and is then carried by that paragraph's source hash like an
 * unchanged one. Its line breaks were not kept, so the repair runs at each hyphen whose space the
 * new text no longer has, and the new paragraphs' own words decide each break as they decided
 * the extraction's. A formatted translation names the paragraph's spans by number, so it moves
 * only while every span survives the repair and covers the same characters as the new
 * paragraph's spans. Every other paragraph is returned as it was.
 */
export function rejoinedForCarry(previousBlocks: readonly Block[], blocks: readonly Block[], shown: ReadonlyMap<string, Translation>): Block[] {
  const texts = new Set(blocks.map((block) => block.sourceText));
  const similar = new Map<string, Block[]>();
  for (const block of blocks) {
    const key = letters(block.sourceText);
    similar.set(key, [...similar.get(key) ?? [], block]);
  }
  const vocabulary = hyphenVocabulary(blocks.filter((block) => PROSE.has(block.kind)).map((block) => ({ text: block.sourceText, breaks: [] })));
  return previousBlocks.map((previous) => {
    if (texts.has(previous.sourceText)) return previous;
    const spans = previous.sourceSpans ?? [];
    const formatted = shown.get(previous.blockId)?.promptVersion === FORMAT_PROMPT_VERSION;
    for (const target of similar.get(letters(previous.sourceText)) ?? []) {
      const rejoined = joinLineBreakHyphens({ text: previous.sourceText, breaks: repairedSpaces(previous.sourceText, target.sourceText), sourceSpans: spans }, vocabulary);
      if (rejoined.text !== target.sourceText) continue;
      if (formatted && !(rejoined.sourceSpans.length === spans.length && sameSpans(rejoined.sourceSpans, target.sourceSpans ?? []))) continue;
      return { ...previous, sourceText: rejoined.text, sourceHash: target.sourceHash, sourceSpans: rejoined.sourceSpans };
    }
    return previous;
  });
}
