/**
 * Where TeX sits inside an answer's prose.
 *
 * Pure string work, no typesetting: the markdown renderer asks this module where formulas are
 * and hands only those spans to KaTeX. Everything else stays text.
 */

export type MathSegment = { type: 'text'; text: string } | { type: 'math'; tex: string; display: boolean; raw: string };

export interface MathMatch {
  /** Index just past the closing delimiter. */
  end: number;
  tex: string;
  display: boolean;
}

const SPACE = /\s/;
const DIGIT = /[0-9]/;

function paired(src: string, start: number, open: string, close: string, display: boolean): MathMatch | null {
  const closeAt = src.indexOf(close, start + open.length);
  if (closeAt < 0) return null;
  const tex = src.slice(start + open.length, closeAt).trim();
  // A formula never spans a paragraph break; an empty pair is not a formula.
  if (tex.length === 0 || /\n[ \t]*\n/.test(tex)) return null;
  return { end: closeAt + close.length, tex, display };
}

/**
 * The formula that opens at `start`, or null when nothing opens there.
 *
 * `$$…$$` and `\[…\]` are display math; `$…$` and `\(…\)` are inline. A single `$` opens only
 * before a non-space and never right after a digit, and the very next unescaped `$` must close
 * it: preceded by a non-space and not followed by a digit. So "$5 and $10" and Korean amounts
 * written after the number ("5$이고 3$입니다") stay money, and inline math never crosses a line
 * break. (A closer may be followed by a letter: Korean particles attach to formulas, "$x$는".)
 */
export function scanMath(src: string, start: number): MathMatch | null {
  if (src.startsWith('$$', start)) return paired(src, start, '$$', '$$', true);
  if (src.startsWith('\\[', start)) return paired(src, start, '\\[', '\\]', true);
  if (src.startsWith('\\(', start)) return paired(src, start, '\\(', '\\)', false);
  if (src[start] !== '$') return null;
  if (DIGIT.test(src[start - 1] ?? '')) return null;
  const first = src[start + 1];
  if (first === undefined || SPACE.test(first)) return null;
  for (let index = start + 1; index < src.length; index += 1) {
    const char = src[index];
    if (char === '\n') return null;
    if (char === '\\') {
      index += 1; // an escaped character (\$, \{) belongs to the formula
      continue;
    }
    if (char !== '$') continue;
    if (SPACE.test(src[index - 1] ?? ' ') || DIGIT.test(src[index + 1] ?? '')) return null;
    return { end: index + 1, tex: src.slice(start + 1, index), display: false };
  }
  return null;
}

/**
 * Split prose into text and formulas. `\$` is a literal dollar sign (the backslash is dropped);
 * `\\` is kept as written so the markdown pass can read it; an unclosed opener stays text.
 */
export function splitMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer.length > 0) segments.push({ type: 'text', text: buffer });
    buffer = '';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '$') {
        buffer += '$';
        index += 2;
        continue;
      }
      if (next === '\\') {
        buffer += '\\\\';
        index += 2;
        continue;
      }
      if (next === '(' || next === '[') {
        const match = scanMath(text, index);
        if (match !== null) {
          flush();
          segments.push({ type: 'math', tex: match.tex, display: match.display, raw: text.slice(index, match.end) });
          index = match.end;
          continue;
        }
      }
      buffer += char;
      index += 1;
      continue;
    }
    if (char === '$') {
      const match = scanMath(text, index);
      if (match !== null) {
        flush();
        segments.push({ type: 'math', tex: match.tex, display: match.display, raw: text.slice(index, match.end) });
        index = match.end;
        continue;
      }
      // An unclosed `$$` stays text as a pair, so its second `$` cannot open inline math.
      const run = text.startsWith('$$', index) ? 2 : 1;
      buffer += text.slice(index, index + run);
      index += run;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return segments;
}
