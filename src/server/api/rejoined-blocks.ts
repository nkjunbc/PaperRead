import type { Block, SourceSpan, Translation } from '../../shared/contracts';
import { repairedAs } from '../pdf/hyphen';
import { FORMAT_PROMPT_VERSION } from '../translation/format';

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
 * The earlier extraction's paragraphs as the translation carry matches them. A paragraph whose
 * text a new paragraph has is carried by that paragraph's source hash. Another one is the same
 * sentence as a new paragraph that reads it in one of two ways, and then takes that paragraph's
 * text and hash, its own spans moved onto that text:
 *
 * - with the words broken at a line end put back (pdf/hyphen.ts). Its line breaks were not kept,
 *   so the repair runs at each hyphen whose space the new text no longer has, and where the
 *   extraction's rules leave a break to the paper's words and the word list, the new text shows
 *   whether the word was joined or kept its hyphen.
 * - with only hyphens added, each between two letters: the earlier extraction joined compounds
 *   broken at a line end ("sequencealigned"), whose hyphen the new one keeps. Its spans move
 *   with the added hyphens.
 *
 * Since the new text decides each repair, one paragraph can read as several new ones
 * ("re- bound's" as "re-bound's" and "rebound's"). A match holds only when it is the only one
 * both ways: exactly one new paragraph reads the paragraph either way, and no other earlier
 * paragraph has that new paragraph's text or reads as it. A formatted translation names the
 * paragraph's spans by number, so it moves only while every span survives, covers the same
 * characters as the new paragraph's spans and, past added hyphens, every formula reads as it did.
 * Every other paragraph is returned as it was.
 */
export function rejoinedForCarry(previousBlocks: readonly Block[], blocks: readonly Block[], shown: ReadonlyMap<string, Translation>): Block[] {
  const copies = new Map<string, Block[]>();
  for (const block of blocks) {
    const same = copies.get(block.sourceText);
    if (same === undefined) copies.set(block.sourceText, [block]);
    else same.push(block);
  }
  const similar = new Map<string, string[]>();
  for (const text of copies.keys()) {
    const same = similar.get(letters(text));
    if (same === undefined) similar.set(letters(text), [text]);
    else same.push(text);
  }
  // Paragraphs of one text match alike: each pair of texts is read once, and its match counts
  // once for every paragraph of the other text. A paragraph read exactly owns its new text.
  const earlier = new Map<string, number>();
  const claims = new Map<string, number>();
  for (const { sourceText } of previousBlocks) {
    const counts = copies.has(sourceText) ? claims : earlier;
    counts.set(sourceText, (counts.get(sourceText) ?? 0) + 1);
  }
  // Read without its spans, a text loses only the formula guard, which keeps a break and so can
  // only turn a match into none: every paragraph of the text has its matches among these, and
  // the one carried is read again with its own spans.
  const matches = [...earlier].flatMap(([before, count]) => (similar.get(letters(before)) ?? []).flatMap((after) => {
    const how = repairedAs({ text: before }, after).text === after ? 'rejoined' as const : addedHyphens(before, after);
    return how === null ? [] : [{ before, count, after, targets: copies.get(after)!, how }];
  }));
  const outgoing = new Map<string, number>();
  for (const { before, count, after, targets } of matches) {
    outgoing.set(before, (outgoing.get(before) ?? 0) + targets.length);
    claims.set(after, (claims.get(after) ?? 0) + count);
  }
  const only = new Map(matches.filter((match) => outgoing.get(match.before) === 1 && claims.get(match.after) === 1).map((match) => [match.before, match]));
  return previousBlocks.map((previous) => {
    const match = only.get(previous.sourceText);
    if (match === undefined) return previous;
    const { targets: [target], how } = match;
    const spans = previous.sourceSpans ?? [];
    const formatted = shown.get(previous.blockId)?.promptVersion === FORMAT_PROMPT_VERSION;
    if (how === 'rejoined') {
      const rejoined = repairedAs({ text: previous.sourceText, sourceSpans: spans }, target.sourceText);
      if (rejoined.text !== target.sourceText) return previous;
      if (formatted && !(rejoined.sourceSpans.length === spans.length && sameSpans(rejoined.sourceSpans, target.sourceSpans ?? []))) return previous;
      return { ...previous, sourceText: target.sourceText, sourceHash: target.sourceHash, sourceSpans: rejoined.sourceSpans };
    }
    // Each added hyphen ended a printed line, which the extraction measures with the text before
    // it: a span ending at the hyphen takes it, a span starting there moves past it.
    const shifted = (offset: number) => offset + how.filter((at) => at <= offset).length;
    const moved = spans.map((span) => ({ ...span, start: shifted(span.start), end: shifted(span.end) }));
    const sameFormulas = spans.every((span, n) => span.kind !== 'math' || previous.sourceText.slice(span.start, span.end) === target.sourceText.slice(moved[n].start, moved[n].end));
    if (formatted && !(sameSpans(moved, target.sourceSpans ?? []) && sameFormulas)) return previous;
    return { ...previous, sourceText: target.sourceText, sourceHash: target.sourceHash, sourceSpans: moved };
  });
}
