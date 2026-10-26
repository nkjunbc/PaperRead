import type { Block, SourceSpan, Translation } from '../../shared/contracts';
import { hyphenVocabulary, joinLineBreakHyphens, repairedSpaces } from '../pdf/hyphen';
import { FORMAT_PROMPT_VERSION } from '../translation/format';

/** The kinds whose words the extractor tells broken words from compounds by. */
const PROSE = new Set<Block['kind']>(['paragraph', 'heading', 'caption', 'reference']);

/** A text with every hyphen and space taken out: what a line-end repair cannot change. */
const letters = (text: string) => text.replace(/[-\u2010\u00AD ]/g, '');

const sameSpans = (a: readonly SourceSpan[], b: readonly SourceSpan[]) =>
  a.length === b.length && a.every((span, index) => span.kind === b[index].kind && span.start === b[index].start && span.end === b[index].end);

/** The offsets of `before` in front of which `after` adds a visible hyphen between two letters,
 * when nothing else differs; null otherwise. */
function addedHyphens(before: string, after: string): number[] | null {
  const added: number[] = [];
  let at = 0;
  // An added hyphen has a letter on each side, never a hyphen, so a character that matches is
  // never an added one: matching first is the only alignment.
  for (let next = 0; next < after.length; next++) {
    if (after[next] === before[at]) at++;
    else if ((after[next] === '-' || after[next] === '\u2010') && /\p{L}/u.test(after[next - 1] ?? '') && /\p{L}/u.test(after[next + 1] ?? '')) added.push(at);
    else return null;
  }
  return at === before.length ? added : null;
}

/**
 * The earlier extraction's paragraphs as the translation carry matches them. A paragraph that
 * the new extraction reads differently only because it now puts back the words broken at a line
 * end (pdf/hyphen.ts) is the same sentence. It takes the text that repair makes of it, when that
 * is exactly a new paragraph's text, and is then carried by that paragraph's source hash like an
 * unchanged one. Its line breaks were not kept, so the repair runs at each hyphen whose space the
 * new text no longer has, and the new paragraphs' own words decide each break as they decided
 * the extraction's. A formatted translation names the paragraph's spans by number, so it moves
 * only while every span survives the repair and covers the same characters as the new
 * paragraph's spans.
 *
 * An earlier extraction can have joined a compound broken at a line end ("sequencealigned"), whose
 * hyphen a later one may keep. A paragraph is the same sentence when a new paragraph reads it with
 * only hyphens added, each between two letters, and the match is the only one: exactly one new
 * paragraph reads it so, and no other earlier paragraph reads as that new paragraph or matches it
 * so. Its spans move with the added hyphens; a formatted translation also needs them to be the
 * new paragraph's spans and every formula to read as it did. Every other paragraph is returned
 * as it was.
 */
export function rejoinedForCarry(previousBlocks: readonly Block[], blocks: readonly Block[], shown: ReadonlyMap<string, Translation>): Block[] {
  const texts = new Set(blocks.map((block) => block.sourceText));
  const similar = new Map<string, Block[]>();
  for (const block of blocks) {
    const key = letters(block.sourceText);
    similar.set(key, [...similar.get(key) ?? [], block]);
  }
  const vocabulary = hyphenVocabulary(blocks.filter((block) => PROSE.has(block.kind)).map((block) => ({ text: block.sourceText, breaks: [] })));
  const repaired = previousBlocks.map((previous) => {
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
  const read = new Set(repaired.map((block) => block.sourceText));
  // Paragraphs of one text match alike: each pair of texts is aligned once, and its match counts
  // once for every paragraph of the other text.
  const earlier = new Map<string, number>();
  for (const { sourceText } of repaired) if (!texts.has(sourceText)) earlier.set(sourceText, (earlier.get(sourceText) ?? 0) + 1);
  const copies = new Map<string, Block[]>();
  for (const block of blocks) {
    const same = copies.get(block.sourceText);
    if (same === undefined) copies.set(block.sourceText, [block]);
    else same.push(block);
  }
  const matches = [...earlier].flatMap(([before, count]) => [...new Set((similar.get(letters(before)) ?? []).map((target) => target.sourceText))].flatMap((after) => {
    const added = read.has(after) ? null : addedHyphens(before, after);
    return added === null ? [] : [{ before, count, after, targets: copies.get(after)!, added }];
  }));
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const { before, count, after, targets } of matches) {
    outgoing.set(before, (outgoing.get(before) ?? 0) + targets.length);
    incoming.set(after, (incoming.get(after) ?? 0) + count);
  }
  const only = new Map(matches.filter((match) => outgoing.get(match.before) === 1 && incoming.get(match.after) === 1).map((match) => [match.before, match]));
  return repaired.map((previous) => {
    const match = only.get(previous.sourceText);
    if (match === undefined) return previous;
    const { targets: [target], added } = match;
    // Each added hyphen ended a printed line, which the extraction measures with the text before
    // it: a span ending at the hyphen takes it, a span starting there moves past it.
    const shifted = (offset: number) => offset + added.filter((at) => at <= offset).length;
    const spans = previous.sourceSpans ?? [];
    const moved = spans.map((span) => ({ ...span, start: shifted(span.start), end: shifted(span.end) }));
    const formatted = shown.get(previous.blockId)?.promptVersion === FORMAT_PROMPT_VERSION;
    const sameFormulas = spans.every((span, n) => span.kind !== 'math' || previous.sourceText.slice(span.start, span.end) === target.sourceText.slice(moved[n].start, moved[n].end));
    if (formatted && !(sameSpans(moved, target.sourceSpans ?? []) && sameFormulas)) return previous;
    return { ...previous, sourceText: target.sourceText, sourceHash: target.sourceHash, sourceSpans: moved };
  });
}
