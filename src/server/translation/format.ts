import type { Block, SourceSpan } from '../../shared/contracts';
import { appError } from '../store/errors';

export const FORMAT_PROMPT_VERSION = 'paperread-ko-v2';
const PREFIX = '[[PR-';
const mathToken = (index: number) => `[[PR-MATH-${index}]]`;
const boldToken = (index: number, edge: 'START'|'END') => `[[PR-BOLD-${index}-${edge}]]`;
const invalid = () => appError('INVALID_TRANSLATION', '번역에서 원문의 수식이나 강조 표시를 보존하지 못했습니다.', false);
const enabled = (version: string | undefined) => version === FORMAT_PROMPT_VERSION;

function spansOf(block: Block): { span: SourceSpan; index: number }[] {
  const spans = (block.sourceSpans ?? []).map((span, index) => ({ span, index })).sort((a, b) => a.span.start - b.span.start);
  let end = 0;
  for (const { span } of spans) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < end || span.end <= span.start || span.end > block.sourceText.length || !['bold', 'math'].includes(span.kind)) throw invalid();
    end = span.end;
  }
  return spans;
}

/** Preserve only measured formatting. PDF math is never guessed or regenerated. */
export function formattedSource(block: Block, version?: string): { text: string; math: { token: string; source: string }[] } {
  if (!enabled(version)) return { text: block.sourceText, math: [] };
  if (block.sourceText.includes(PREFIX)) throw invalid();
  const spans = spansOf(block);
  const math: { token: string; source: string }[] = [];
  let text = '', cursor = 0;
  for (const { span, index } of spans) {
    text += block.sourceText.slice(cursor, span.start);
    const source = block.sourceText.slice(span.start, span.end);
    if (span.kind === 'math') {
      text += mathToken(index);
      math.push({ token: mathToken(index), source });
    } else {
      text += `${boldToken(index, 'START')}${source}${boldToken(index, 'END')}`;
    }
    cursor = span.end;
  }
  return { text: text + block.sourceText.slice(cursor), math };
}

function occurrences(text: string, token: string): number { return text.split(token).length - 1; }

/** Turn only verified paired emphasis markers into safe Markdown. Math markers
 * remain as references to immutable source-PDF regions for the reader renderer. */
export function restoreFormatting(block: Block, text: string, version?: string): string {
  if (!enabled(version)) return text;
  const spans = spansOf(block);
  const expected = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  for (const { span, index } of spans) {
    if (span.kind === 'math') {
      const token = mathToken(index);
      if (occurrences(text, token) !== 1) throw invalid();
      expected.add(token);
    } else {
      const startToken = boldToken(index, 'START'), endToken = boldToken(index, 'END');
      if (occurrences(text, startToken) !== 1 || occurrences(text, endToken) !== 1) throw invalid();
      const start = text.indexOf(startToken), end = text.indexOf(endToken);
      if (end <= start + startToken.length || !text.slice(start + startToken.length, end).trim()) throw invalid();
      expected.add(startToken); expected.add(endToken);
      ranges.push({ start, end: end + endToken.length });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1]!.end)) throw invalid();
  let remainder = text;
  for (const token of expected) remainder = remainder.replace(token, '');
  if (remainder.includes(PREFIX)) throw invalid();
  let restored = text;
  for (const { span, index } of spans) {
    if (span.kind === 'bold') {
      const startToken = boldToken(index, 'START'), endToken = boldToken(index, 'END');
      const start = restored.indexOf(startToken), end = restored.indexOf(endToken);
      const body = restored.slice(start + startToken.length, end);
      const leading = body.slice(0, body.length - body.trimStart().length);
      const trailing = body.slice(body.trimEnd().length);
      // Markdown delimiters must touch their content. Keep boundary whitespace
      // outside the emphasis instead of deleting it or silently losing the style.
      restored = restored.slice(0, start) + leading + '**' + body.trim() + '**' + trailing + restored.slice(end + endToken.length);
    }
  }
  validateFormattedTranslation(block, restored, version);
  return restored;
}

/** A provider-independent gate before persistence, including test/alternate adapters. */
export function validateFormattedTranslation(block: Block, text: string, version?: string): void {
  if (!enabled(version)) return;
  const spans = spansOf(block);
  let remainder = text, emphasis = 0;
  for (const { span, index } of spans) {
    if (span.kind === 'math') {
      const token = mathToken(index);
      if (occurrences(text, token) !== 1) throw invalid();
      // Korean grammar can move independent formulas, e.g. "p at time t" to
      // "시점 t의 p". The immutable marker ID, not its sentence position,
      // selects the exact source formula; every ID must still occur once.
      remainder = remainder.replace(token, '');
    } else emphasis++;
  }
  if (remainder.includes(PREFIX)) throw invalid();
  const strong = [...text.matchAll(/\*\*(?=\S)([\s\S]*?\S|\S)\*\*/g)];
  if (strong.length < emphasis) throw invalid();
}

export interface FormattedBlockPart { block: Block; indices: number[] }

/** Split prose near its midpoint. A measured formula is indivisible. Emphasis
 * may span both fragments; each fragment receives a complete emphasis span. */
export function splitFormattedBlock(block: Block): [FormattedBlockPart, FormattedBlockPart] {
  const text = block.sourceText;
  const spans = spansOf(block);
  const firstCharacter = text.search(/\S/), lastCharacter = text.trimEnd().length;
  const validCut = (cut: number) => cut > firstCharacter && cut < lastCharacter
    && !(cut > 0 && /[\ud800-\udbff]/.test(text[cut - 1]!) && /[\udc00-\udfff]/.test(text[cut]!))
    && !spans.some(({ span }) => span.kind === 'math' && span.start < cut && span.end > cut);
  let cut = -1;
  const middle = Math.floor(text.length / 2);
  for (const whitespaceOnly of [true, false]) {
    for (let offset = 0; offset < text.length && cut < 0; offset++) {
      for (const candidate of [middle - offset, middle + offset]) {
        if (validCut(candidate) && (!whitespaceOnly || /\s/.test(text[candidate]!))) { cut = candidate; break; }
      }
    }
    if (cut >= 0) break;
  }
  if (cut < 0) throw appError('TOO_LARGE', '수식 하나가 번역 입력 한도를 초과해 나눌 수 없습니다.', false);
  const part = (start: number, end: number): FormattedBlockPart => {
    const raw = text.slice(start, end);
    const sourceText = raw.trim();
    const offset = start + raw.length - raw.trimStart().length;
    const limit = offset + sourceText.length;
    const kept = spans.filter(({ span }) => span.end > offset && span.start < limit);
    return { indices: kept.map(({ index }) => index), block: { ...block, sourceText,
      ...(block.sourceSpans ? { sourceSpans: kept.map(({ span }) => ({ ...span, start: Math.max(span.start, offset) - offset, end: Math.min(span.end, limit) - offset })) } : {}),
    } };
  };
  return [part(0, cut), part(cut, text.length)];
}

/** A re-extraction keeps a paragraph's text but may measure its spans again: new geometry, or
 * new numbers once another span is found. A formatted translation still holds while every
 * formula it refers to is measured again with the same source text; its markers then follow
 * those formulas. Null when one of them is gone or changed. */
export function carryMathMarkers(before: Block, after: Block, text: string, version?: string): string | null {
  if (!enabled(version)) return text;
  // Equal formulas are told apart by order: the k-th "x" stays the k-th "x".
  const formulas = (block: Block) => {
    const seen = new Map<string, number>(), keys = new Map<number, string>();
    (block.sourceSpans ?? []).forEach((span, index) => {
      if (span.kind !== 'math') return;
      const source = block.sourceText.slice(span.start, span.end);
      const rank = seen.get(source) ?? 0;
      seen.set(source, rank + 1);
      keys.set(index, `${rank}\u0000${source}`);
    });
    return keys;
  };
  const previous = formulas(before);
  const next = new Map([...formulas(after)].map(([index, key]) => [key, index] as const));
  let lost = false;
  const carried = text.replace(/\[\[PR-MATH-(\d+)\]\]/g, (marker, raw: string) => {
    const index = next.get(previous.get(Number(raw)) ?? '');
    if (index === undefined) lost = true;
    return index === undefined ? marker : mathToken(index);
  });
  return lost ? null : carried;
}

/** Fragment-local span numbers become the parent block's numbers before joining. */
export function remapMathMarkers(text: string, indices: readonly number[]): string {
  return text.replace(/\[\[PR-MATH-(\d+)\]\]/g, (_, raw: string) => {
    const original = indices[Number(raw)];
    if (original === undefined) throw invalid();
    return mathToken(original);
  });
}
