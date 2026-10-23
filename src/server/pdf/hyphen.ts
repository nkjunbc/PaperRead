import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { SourceSpan } from '../../shared/contracts';
import { SourceError } from '../arxiv/index';
import { union } from './inline';

/**
 * Words broken at a line end.
 *
 * Two lines of one block reach the text joined with one space, so a word the typesetter broke
 * reads "informa- tion". At each such line break — and nowhere else — the word is put back:
 *
 * - A soft hyphen (U+00AD) is the typesetter's own mark of a broken word: the two halves are
 *   joined when the word resumes in lowercase. Otherwise only the invisible mark goes and the
 *   break stays a space. A soft hyphen never stays in the text.
 * - A hyphen ("-", U+2010) between a letter and a lowercase letter is a broken word, unless the
 *   word is a compound: then the hyphen stays and only the space goes ("state-of-the-art").
 *   A compound is recognised, in this order, when
 *   1. the continuation opens with an uppercase letter or a digit, or a digit ends the first half
 *      ("non-English", "GPT-4", "L2-norm");
 *   2. either half already holds a hyphen or a non-letter ("state-of-|the-art", a URL);
 *   3. TeX would never break there: fewer than two letters before the break or fewer than three
 *      after it, its default \lefthyphenmin and \righthyphenmin ("x-axis", "top-k");
 *   4. the first half is an acronym or a CamelCase name ("GRPO-trained", "LLaMA-based");
 *   5. the paper itself, read as its own word list, says so: the hyphenated word appears
 *      elsewhere inside a line ("multi-turn"); failing that, the joined word appearing elsewhere
 *      makes it a broken word; failing that, both halves standing elsewhere as words of their
 *      own ("well-known"), or the second half ending another hyphenated word of the paper
 *      ("rule-based" beside "model-based"), make it a compound;
 *   6. failing that, an English word list (the an-array-of-english-words package) says so: a first
 *      half opening in uppercase is a name or a sentence start and is joined ("Ben-gio"); else the
 *      joined word in the list makes it a broken word ("net-work"), and both halves in the list
 *      make it a compound ("sequence-aligned").
 *   Anything else is a broken word and is joined.
 *
 * Limits, since the paper's own words and one general word list are the only evidence:
 * - a compound that opens a sentence is joined like a name ("Log-|likelihood" → "Loglikelihood");
 * - a word missing from the list keeps its hyphen when both its fragments are listed words, be it
 *   a technical word or a name written in lowercase ("soft-|max" → "soft-max", "tensor-|flow");
 * - a compound with a half missing from the list is joined ("multi-|turn" → "multiturn");
 * - a suspended hyphen at a line end loses its space ("pre-|and post-training" →
 *   "pre-and post-training");
 * - a break beside or inside a formula span is left as it is.
 */

const SOFT_HYPHEN = '\u00AD';
const HYPHENS = new Set(['-', '\u2010', SOFT_HYPHEN]);

/** A block's text and the offsets of the spaces that stand for its line breaks. */
export interface HyphenSource { text:string; breaks:readonly number[] }
/** Words and hyphenated words the paper uses inside its lines, lowercased, and the words that
 * end those hyphenated words. */
export interface HyphenVocabulary { words:ReadonlySet<string>; compounds:ReadonlySet<string>; endings:ReadonlySet<string> }

const edgePunctuation = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Every word of the paper outside a line-end break: the halves of a broken word are not
 * words of the paper, and must not vouch for themselves. */
export function hyphenVocabulary(sources:Iterable<HyphenSource>):HyphenVocabulary {
  const words = new Set<string>(), compounds = new Set<string>(), endings = new Set<string>();
  for (const { text, breaks } of sources) {
    const hyphenated = new Set(breaks.filter((at) => HYPHENS.has(text[at - 1] ?? '')));
    for (const match of text.matchAll(/\S+/g)) {
      const start = match.index, end = start + match[0].length;
      if (hyphenated.has(end) || hyphenated.has(start - 1)) continue;
      const word = match[0].replace(edgePunctuation, '').replace(/\u2010/g, '-').toLowerCase();
      if (/^\p{L}+$/u.test(word)) words.add(word);
      else if (/^\p{L}+(?:-\p{L}+)+$/u.test(word)) {
        compounds.add(word);
        endings.add(word.slice(word.lastIndexOf('-') + 1));
      }
    }
  }
  return { words, compounds, endings };
}

let englishWords:ReadonlySet<string> | undefined;
/** Whether the pinned word list, read from disk on first use and kept for every extraction,
 * has `word`. Without the list an extraction fails rather than guessing. */
function isEnglishWord(word:string):boolean {
  if (englishWords === undefined) {
    try {
      englishWords = new Set(JSON.parse(readFileSync(createRequire(import.meta.url).resolve('an-array-of-english-words'), 'utf8')) as string[]);
    } catch {
      throw new SourceError('INTERNAL', '줄 끝 하이픈을 판단할 영어 단어 목록(an-array-of-english-words)을 읽을 수 없습니다.');
    }
  }
  return englishWords.has(word);
}

type Repair = 'join' | 'compound' | 'unmark' | 'keep';
/** Tells a broken word from a compound at the line break `at` where the break's own letters
 * leave it open, from the word before the hyphen and the two halves lowercased. */
type WordEvidence = (at:number, head:string, first:string, second:string) => 'join' | 'compound';

/** Steps 5 and 6: the paper's own words, then the word list. */
const paperThenEnglishWords = (vocabulary:HyphenVocabulary):WordEvidence => (_at, head, first, second) => {
  if (vocabulary.compounds.has(`${first}-${second}`)) return 'compound';
  if (vocabulary.words.has(first + second)) return 'join';
  if ((vocabulary.words.has(first) && vocabulary.words.has(second)) || vocabulary.endings.has(second)) return 'compound';
  if (/^\p{Lu}/u.test(head) || isEnglishWord(first + second)) return 'join';
  return isEnglishWord(first) && isEnglishWord(second) ? 'compound' : 'join';
};

/** What the line break at `at` (the space joining two lines) holds. */
function repairAt(text:string, at:number, spans:readonly SourceSpan[], words:WordEvidence):Repair {
  const hyphen = text[at - 1] ?? '';
  if (text[at] !== ' ' || !HYPHENS.has(hyphen)) return 'keep';
  if (spans.some((span) => span.kind === 'math' && span.start < at + 2 && span.end > at - 2)) return 'keep';
  const before = text[at - 2] ?? '', after = text[at + 1] ?? '';
  const soft = hyphen === SOFT_HYPHEN;
  // A dash set off from its words is punctuation, not a broken word.
  if (!/[\p{L}\p{N}]/u.test(before) || !/[\p{L}\p{N}]/u.test(after)) return soft ? 'unmark' : 'keep';
  if (soft) return /\p{L}/u.test(before) && /\p{Ll}/u.test(after) ? 'join' : 'unmark';
  const head = (/\S*$/.exec(text.slice(0, at - 1))?.[0] ?? '').replace(/^[^\p{L}\p{N}]+/u, '');
  const tail = (/^\S*/.exec(text.slice(at + 1))?.[0] ?? '').replace(/[^\p{L}\p{N}]+$/u, '');
  if (!/^\p{Ll}/u.test(tail) || !/\p{L}$/u.test(head)) return 'compound';
  const wordlike = /^\p{L}+(?:['’]\p{L}+)?$/u;
  if (!wordlike.test(head) || !wordlike.test(tail)) return 'compound';
  const first = head.toLowerCase(), second = /^\p{L}+/u.exec(tail)![0].toLowerCase();
  if (first.length < 2 || second.length < 3) return 'compound';
  if ((head.match(/\p{Lu}/gu)?.length ?? 0) >= 2) return 'compound';
  return words(at, head, first, second);
}

/** Puts back the words broken at the block's line breaks. Every span keeps covering the same
 * characters; the two bold runs of a rejoined word become one run. */
export function joinLineBreakHyphens(source:HyphenSource & { sourceSpans?:readonly SourceSpan[] }, vocabulary:HyphenVocabulary):{ text:string; sourceSpans:SourceSpan[] } {
  return repairBreaks(source, paperThenEnglishWords(vocabulary));
}

/**
 * `before`, a text that kept no record of its line breaks (an earlier extraction's), with the
 * breaks a later extraction repaired into `after` put back by the same rules. A break is a space
 * after a hyphen that `after`, read as `before` with characters taken out, no longer has. Where
 * the break's own letters leave a broken word and a compound apart, `after` keeping the hyphen or
 * not says which it was: the later extraction's words cannot, since they now hold the compounds
 * those very repairs made ("lower-bound" reads "bound" as the end of a compound).
 */
export function repairedAs(before:{ text:string; sourceSpans?:readonly SourceSpan[] }, after:string):{ text:string; sourceSpans:SourceSpan[] } {
  const kept = new Map<number, boolean>();
  let next = 0, matched = false;
  for (let at = 0; at < before.text.length; at++) {
    const same = before.text[at] === after[next];
    if (same) next++;
    else if (before.text[at] === ' ' && HYPHENS.has(before.text[at - 1] ?? '')) kept.set(at, matched);
    matched = same;
  }
  return repairBreaks({ ...before, breaks: [...kept.keys()] }, (at) => kept.get(at) ? 'compound' : 'join');
}

function repairBreaks(source:HyphenSource & { sourceSpans?:readonly SourceSpan[] }, words:WordEvidence):{ text:string; sourceSpans:SourceSpan[] } {
  const { text, breaks } = source, spans = source.sourceSpans ?? [];
  const removed = new Set<number>(), seams:number[] = [];
  for (const at of breaks) {
    const repair = repairAt(text, at, spans, words);
    if (repair === 'join') { removed.add(at - 1); removed.add(at); seams.push(at + 1); }
    else if (repair === 'compound') { removed.add(at); seams.push(at + 1); }
    else if (repair === 'unmark') removed.add(at - 1);
  }
  for (let at = text.indexOf(SOFT_HYPHEN); at >= 0; at = text.indexOf(SOFT_HYPHEN, at + 1)) removed.add(at);
  if (removed.size === 0) return { text, sourceSpans: [...spans] };
  const gone = [...removed].sort((a, b) => a - b);
  /** Where an old offset lands once the removed characters are gone. */
  const moved = (offset:number) => { let count = 0; while (count < gone.length && gone[count] < offset) count++; return offset - count; };
  let joined = '';
  for (let at = 0; at < text.length; at++) if (!removed.has(at)) joined += text[at];
  const joints = new Set(seams.map(moved));
  const kept:SourceSpan[] = [];
  for (const span of spans) {
    const next = { ...span, start: moved(span.start), end: moved(span.end) };
    if (next.end <= next.start) continue;
    const previous = kept.at(-1);
    if (previous !== undefined && previous.kind === 'bold' && next.kind === 'bold' && previous.end === next.start && joints.has(next.start)
      && previous.regions.length === 1 && next.regions.length === 1 && previous.regions[0].page === next.regions[0].page) {
      kept[kept.length - 1] = { ...previous, end: next.end, regions: [union([previous.regions[0], next.regions[0]])] };
    } else kept.push(next);
  }
  return { text: joined, sourceSpans: kept };
}

/**
 * pdf.js leaves invisible format characters, the soft hyphen among them, out of a page's text
 * content: a word broken at a soft hyphen reads "infor" + "mation", with nothing to tell it from
 * two words. The drawn glyphs still carry it. Counted here, by the letters before it, is every
 * soft hyphen that ends its text-showing operation — the end of a printed line — so the text item
 * ending in the same letters can get its mark back.
 */
export function softHyphenEnds(runs:Iterable<readonly unknown[]>):Map<string, number> {
  const ends = new Map<string, number>();
  for (const run of runs) {
    let word = '', marked:string | null = null;
    for (const glyph of run) {
      // A spacing adjustment wider than a tenth of an em parts two words.
      if (typeof glyph === 'number') { if (glyph < -100) word = ''; continue; }
      const unicode = typeof glyph === 'object' && glyph !== null && typeof (glyph as { unicode?:unknown }).unicode === 'string' ? (glyph as { unicode:string }).unicode : '';
      if (unicode === SOFT_HYPHEN) { marked = word || null; word = ''; continue; }
      if (/^\s*$/.test(unicode)) { word = ''; continue; }
      marked = null;
      word = /^\p{L}+$/u.test(unicode) ? word + unicode : '';
    }
    if (marked !== null) ends.set(marked, (ends.get(marked) ?? 0) + 1);
  }
  return ends;
}

/** The text item's own soft hyphen, put back where its line ended on one (see softHyphenEnds). */
export function restoreSoftHyphen(text:string, ends:Map<string, number>):string {
  const word = /(\p{L}+)\s*$/u.exec(text)?.[1];
  const left = word === undefined ? 0 : ends.get(word) ?? 0;
  if (left <= 0) return text;
  ends.set(word!, left - 1);
  return text.trimEnd() + SOFT_HYPHEN;
}
