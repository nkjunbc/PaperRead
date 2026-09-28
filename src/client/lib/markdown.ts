/**
 * A small markdown reader for model answers.
 *
 * It produces a plain tree, never HTML: the view turns the tree into React elements, so any
 * markup in an answer (`<script>`, `<img onerror>`) can only ever be text. Links survive only
 * with an http(s) address. Formulas are found by `lib/math` and typeset later by KaTeX.
 *
 * Streaming-friendly: the text is re-read as it grows, and a half-written construct (an
 * unclosed fence, a table without its delimiter row yet) reads as something sensible.
 */
import { scanMath, splitMath } from './math';

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'math'; tex: string; display: boolean }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'break' };

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'math'; tex: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { type: 'blockquote'; children: MdBlock[] }
  | { type: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }
  | { type: 'hr' };

/** Quotes and lists nest; past this depth the rest reads as a paragraph. */
const MAX_DEPTH = 12;

// ------------------------------------------------------------------ links

/** The address a link may carry: absolute http(s) only. Anything else is not a link. */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- inline

// Atoms (code, formulas, escapes, bare links, breaks) are parked behind these markers while
// emphasis and links are read, so a `*` or `_` inside a formula or an address is never markup.
const ATOM_OPEN = '';
const ATOM_CLOSE = '';
const ATOMS_IN_SOURCE = /[]/g;

interface Atom {
  node: MdInline;
  raw: string;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
/** A bare address: ASCII URL characters only, so Korean right after it is not swallowed. */
const BARE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()+,;=%]+/;

function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) return url;
    if ('.,;:!?\'"'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const open = (url.match(/\(/g) ?? []).length;
      const close = (url.match(/\)/g) ?? []).length;
      if (close > open) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

function codeRun(src: string, index: number): number {
  let end = index;
  while (src[end] === '`') end += 1;
  return end - index;
}

/** Split out code spans first: nothing inside backticks is markup or math. */
function splitCode(src: string): { code: boolean; text: string; raw: string }[] {
  const parts: { code: boolean; text: string; raw: string }[] = [];
  let buffer = '';
  let index = 0;
  while (index < src.length) {
    if (src[index] !== '`') {
      buffer += src[index];
      index += 1;
      continue;
    }
    const length = codeRun(src, index);
    let search = index + length;
    let close = -1;
    while (search < src.length) {
      const at = src.indexOf('`', search);
      if (at < 0) break;
      const run = codeRun(src, at);
      if (run === length) {
        close = at;
        break;
      }
      search = at + run;
    }
    if (close < 0) {
      buffer += src.slice(index, index + length);
      index += length;
      continue;
    }
    if (buffer.length > 0) parts.push({ code: false, text: buffer, raw: buffer });
    buffer = '';
    let text = src.slice(index + length, close).replace(/\n/g, ' ');
    if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim().length > 0) text = text.slice(1, -1);
    parts.push({ code: true, text, raw: src.slice(index, close + length) });
    index = close + length;
  }
  if (buffer.length > 0) parts.push({ code: false, text: buffer, raw: buffer });
  return parts;
}

function tokenize(source: string): { s: string; atoms: Atom[] } {
  const atoms: Atom[] = [];
  let s = '';
  const put = (node: MdInline, raw: string) => {
    s += `${ATOM_OPEN}${atoms.length}${ATOM_CLOSE}`;
    atoms.push({ node, raw });
  };

  const plain = (text: string) => {
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        const next = text[index + 1];
        if (next === '\n') {
          put({ type: 'break' }, '\\\n');
          index += 2;
          continue;
        }
        if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
          put({ type: 'text', text: next }, `\\${next}`);
          index += 2;
          continue;
        }
      }
      if (char === '<') {
        const rest = text.slice(index);
        const br = /^<br\s*\/?>/i.exec(rest);
        if (br !== null) {
          put({ type: 'break' }, br[0]);
          index += br[0].length;
          continue;
        }
        const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(rest);
        const href = auto === null ? null : safeHref(auto[1]);
        if (auto !== null && href !== null) {
          put({ type: 'link', href, children: [{ type: 'text', text: auto[1] }] }, auto[0]);
          index += auto[0].length;
          continue;
        }
      }
      if ((char === 'h' || char === 'H') && !/[A-Za-z0-9]/.test(text[index - 1] ?? '')) {
        const match = BARE_URL.exec(text.slice(index));
        if (match !== null) {
          const url = trimUrl(match[0]);
          const href = safeHref(url);
          if (href !== null && url.length > 'https://'.length) {
            put({ type: 'link', href, children: [{ type: 'text', text: url }] }, url);
            index += url.length;
            continue;
          }
        }
      }
      s += char;
      index += 1;
    }
  };

  for (const part of splitCode(source.replace(ATOMS_IN_SOURCE, '�'))) {
    if (part.code) {
      put({ type: 'code', text: part.text }, part.raw);
      continue;
    }
    for (const segment of splitMath(part.text)) {
      if (segment.type === 'math') put({ type: 'math', tex: segment.tex, display: segment.display }, segment.raw);
      else plain(segment.text);
    }
  }
  return { s, atoms };
}

function atomAt(s: string, index: number): { id: number; end: number } | null {
  if (s[index] !== ATOM_OPEN) return null;
  const close = s.indexOf(ATOM_CLOSE, index);
  if (close < 0) return null;
  return { id: Number(s.slice(index + 1, close)), end: close + 1 };
}

/** The source text of a stretch that may contain parked atoms (used for link addresses). */
function rawText(s: string, atoms: Atom[]): string {
  return s.replace(/(\d+)/g, (_match, id: string) => atoms[Number(id)]?.raw ?? '');
}

function canOpen(s: string, index: number, delimiter: string): boolean {
  const next = s[index + delimiter.length];
  if (next === undefined || SPACE.test(next)) return false;
  if (delimiter[0] === '_' && WORD.test(s[index - 1] ?? '')) return false;
  return true;
}

function findClose(s: string, from: number, delimiter: string): number {
  const char = delimiter[0];
  for (let index = from; index < s.length; index += 1) {
    const atom = atomAt(s, index);
    if (atom !== null) {
      index = atom.end - 1;
      continue;
    }
    if (!s.startsWith(delimiter, index)) continue;
    if (delimiter.length === 1 && s[index + 1] === char) {
      // A `**` inside `*…*` is its own pair, never the single closer.
      while (s[index + 1] === char) index += 1;
      continue;
    }
    if (index === from || SPACE.test(s[index - 1] ?? ' ')) continue;
    if (char === '_' && WORD.test(s[index + delimiter.length] ?? '')) continue;
    return index;
  }
  return -1;
}

interface LinkMatch {
  end: number;
  label: string;
  target: string;
}

function readLink(s: string, index: number): LinkMatch | null {
  let depth = 0;
  let close = -1;
  for (let at = index; at < s.length; at += 1) {
    const atom = atomAt(s, at);
    if (atom !== null) {
      at = atom.end - 1;
      continue;
    }
    if (s[at] === '[') depth += 1;
    else if (s[at] === ']') {
      depth -= 1;
      if (depth === 0) {
        close = at;
        break;
      }
    }
  }
  if (close < 0 || s[close + 1] !== '(') return null;
  let balance = 0;
  let end = close + 2;
  for (; end < s.length; end += 1) {
    const char = s[end];
    if (char === '\n') return null;
    if (char === '(') balance += 1;
    else if (char === ')') {
      if (balance === 0) break;
      balance -= 1;
    }
  }
  if (end >= s.length) return null;
  return { end: end + 1, label: s.slice(index + 1, close), target: s.slice(close + 2, end) };
}

function linkTarget(target: string): string {
  let value = target.trim();
  // An optional title after the address: [text](url "title").
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(value);
  if (titled !== null) value = titled[1];
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  return value;
}

function pushText(out: MdInline[], text: string): void {
  if (text.length === 0) return;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: 'break' });
    if (line.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + line };
    else out.push({ type: 'text', text: line });
  });
}

function pushNode(out: MdInline[], node: MdInline): void {
  if (node.type === 'text') pushText(out, node.text);
  else out.push(node);
}

function parseSpan(s: string, atoms: Atom[], depth: number): MdInline[] {
  const out: MdInline[] = [];
  let buffer = '';
  const flush = () => {
    pushText(out, buffer);
    buffer = '';
  };
  let index = 0;
  while (index < s.length) {
    const atom = atomAt(s, index);
    if (atom !== null) {
      flush();
      const parked = atoms[atom.id];
      if (parked !== undefined) pushNode(out, parked.node);
      index = atom.end;
      continue;
    }
    const char = s[index];
    if (depth < MAX_DEPTH && (char === '*' || char === '_' || char === '~')) {
      if (s.startsWith('***', index) && canOpen(s, index, '***')) {
        const close = findClose(s, index + 3, '***');
        if (close >= 0) {
          flush();
          out.push({ type: 'strong', children: [{ type: 'em', children: parseSpan(s.slice(index + 3, close), atoms, depth + 1) }] });
          index = close + 3;
          continue;
        }
      }
      const double = s.slice(index, index + 2);
      if ((double === '**' || double === '__' || double === '~~') && canOpen(s, index, double)) {
        const close = findClose(s, index + 2, double);
        if (close >= 0) {
          flush();
          out.push({ type: double === '~~' ? 'del' : 'strong', children: parseSpan(s.slice(index + 2, close), atoms, depth + 1) });
          index = close + 2;
          continue;
        }
      }
      if (char !== '~' && s[index + 1] !== char && canOpen(s, index, char)) {
        const close = findClose(s, index + 1, char);
        if (close >= 0) {
          flush();
          out.push({ type: 'em', children: parseSpan(s.slice(index + 1, close), atoms, depth + 1) });
          index = close + 1;
          continue;
        }
      }
      // A delimiter run that opens nothing is text, all of it.
      let end = index;
      while (s[end] === char) end += 1;
      buffer += s.slice(index, end);
      index = end;
      continue;
    }
    if (char === '[' || (char === '!' && s[index + 1] === '[')) {
      const start = char === '!' ? index + 1 : index;
      const link = depth < MAX_DEPTH ? readLink(s, start) : null;
      if (link !== null) {
        flush();
        const children = parseSpan(link.label, atoms, depth + 1);
        const href = safeHref(linkTarget(rawText(link.target, atoms)));
        // An address that is not http(s) never becomes a link; its words stay as text.
        if (href !== null) out.push({ type: 'link', href, children });
        else for (const child of children) pushNode(out, child);
        index = link.end;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

export function parseInline(text: string): MdInline[] {
  const { s, atoms } = tokenize(text);
  return parseSpan(s, atoms, 0);
}

// ------------------------------------------------------------------ blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const MARKER = /^( *)(?:([-*+])|(\d{1,9})([.)]))(?=[ \t]|$)([ \t]*)/;
const DELIMITER_CELL = /^:?-+:?$/;

interface Marker {
  indent: number;
  ordered: boolean;
  number: number;
  /** The column item content starts at. */
  content: number;
  rest: string;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function listMarker(line: string): Marker | null {
  if (HR.test(line)) return null;
  const match = MARKER.exec(line);
  if (match === null) return null;
  const indent = match[1].length;
  const markerWidth = match[2] !== undefined ? 1 : match[3].length + 1;
  const rest = line.slice(match[0].length);
  const gap = match[5].length;
  // Content of an empty item, or one set off by a wide gap, starts one space after the marker.
  const content = indent + markerWidth + (rest.length === 0 || gap > 4 ? 1 : gap);
  return { indent, ordered: match[3] !== undefined, number: match[3] === undefined ? 1 : Number(match[3]), content, rest: gap > 4 ? line.slice(indent + markerWidth + 1) : rest };
}

function stripColumns(line: string, columns: number): string {
  let removed = 0;
  while (removed < columns && line[removed] === ' ') removed += 1;
  return line.slice(removed);
}

/** Cells of a table row; a `|` inside code, inside a formula or escaped does not split. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let buffer = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      buffer += '\\|';
      index += 2;
      continue;
    }
    if (char === '`') {
      const length = codeRun(text, index);
      const close = text.indexOf('`'.repeat(length), index + length);
      if (close >= 0) {
        buffer += text.slice(index, close + length);
        index = close + length;
        continue;
      }
    }
    if (char === '$' || (char === '\\' && (text[index + 1] === '(' || text[index + 1] === '['))) {
      const math = scanMath(text, index);
      if (math !== null) {
        buffer += text.slice(index, math.end);
        index = math.end;
        continue;
      }
    }
    if (char === '|') {
      cells.push(buffer.trim());
      buffer = '';
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  cells.push(buffer.trim());
  return cells;
}

function delimiterAlign(cells: string[]): MdAlign[] | null {
  const align: MdAlign[] = [];
  for (const cell of cells) {
    const value = cell.replace(/\s+/g, '');
    if (!DELIMITER_CELL.test(value)) return null;
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

function tableStart(lines: string[], index: number): MdAlign[] | null {
  const head = lines[index];
  const delimiter = lines[index + 1];
  if (head === undefined || delimiter === undefined || !head.includes('|') || !delimiter.includes('-')) return null;
  const headCells = splitRow(head);
  const delimiterCells = splitRow(delimiter);
  if (headCells.length !== delimiterCells.length) return null;
  if (headCells.length < 2 && !(head.trim().startsWith('|') || delimiter.trim().startsWith('|'))) return null;
  return delimiterAlign(delimiterCells);
}

/** A `$$…$$` or `\[…\]` block whose closer ends a line; null when it is not closed that way. */
function readMathBlock(lines: string[], index: number): { tex: string; next: number } | null {
  const first = lines[index].trimStart();
  const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
  if (open === null) return null;
  const close = open === '$$' ? '$$' : '\\]';
  let body = first.slice(open.length);
  for (let at = index; at < lines.length; at += 1) {
    if (at > index) body += `\n${lines[at]}`;
    const closeAt = body.indexOf(close);
    if (closeAt < 0) {
      if (at > index && isBlank(lines[at])) return null;
      continue;
    }
    if (body.slice(closeAt + close.length).trim().length > 0) return null;
    const tex = body.slice(0, closeAt).trim();
    return tex.length === 0 ? null : { tex, next: at + 1 };
  }
  return null;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const marker = listMarker(line);
  if (marker !== null && marker.rest.trim().length > 0) return true;
  if (tableStart(lines, index) !== null) return true;
  return readMathBlock(lines, index) !== null;
}

function readList(lines: string[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = listMarker(lines[start])!;
  const items: string[][] = [[first.rest]];
  let itemIndent = first.indent;
  let content = first.content;
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    const item = items[items.length - 1];
    if (isBlank(line)) {
      let ahead = index + 1;
      while (ahead < lines.length && isBlank(lines[ahead])) ahead += 1;
      const next = lines[ahead];
      if (next === undefined) break;
      const marker = listMarker(next);
      const continues = indentOf(next) >= content || (marker !== null && marker.ordered === first.ordered && marker.indent <= itemIndent + 3);
      if (!continues) break;
      item.push('');
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    const marker = listMarker(line);
    if (marker !== null && indent <= itemIndent) {
      if (marker.ordered !== first.ordered) break;
      items.push([marker.rest]);
      itemIndent = marker.indent;
      content = marker.content;
      index += 1;
      continue;
    }
    if (indent >= content || (marker !== null && indent > itemIndent)) {
      item.push(stripColumns(line, Math.min(indent, content)));
      index += 1;
      continue;
    }
    // A lazy continuation of the item's last paragraph.
    const previous = item[item.length - 1];
    if (previous !== undefined && !isBlank(previous) && !HR.test(line) && !FENCE.test(line) && !HEADING.test(line) && !QUOTE.test(line)) {
      item.push(line.trim());
      index += 1;
      continue;
    }
    break;
  }
  return {
    block: { type: 'list', ordered: first.ordered, start: first.number, items: items.map((lines_) => parseLines(lines_, depth + 1)) },
    next: index,
  };
}

function parseLines(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1];
      const indent = indentOf(line);
      const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      index += 1;
      // An unclosed fence (still streaming) runs to the end.
      while (index < lines.length && !closing.test(lines[index])) {
        body.push(stripColumns(lines[index], indent));
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', lang: fence[2].length > 0 ? fence[2] : null, text: body.join('\n') });
      continue;
    }

    const math = readMathBlock(lines, index);
    if (math !== null) {
      blocks.push({ type: 'math', tex: math.tex });
      index = math.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline((heading[2] ?? '').trim()) });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(lines[index].replace(QUOTE, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', children: parseLines(quoted, depth + 1) });
      continue;
    }

    if (listMarker(line) !== null && depth < MAX_DEPTH) {
      const list = readList(lines, index, depth);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    const align = tableStart(lines, index);
    if (align !== null) {
      const header = splitRow(line).map((cell) => parseInline(cell));
      const rows: MdInline[][][] = [];
      index += 2;
      while (index < lines.length && !isBlank(lines[index]) && lines[index].includes('|')) {
        const cells = splitRow(lines[index]);
        rows.push(align.map((_, column) => parseInline(cells[column] ?? '')));
        index += 1;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

// ------------------------------------------------------------- streaming

/** Where an answer still being written may be cut: the text to show, and what was held back. */
export interface StreamingView {
  text: string;
  /** A formula still being written was held back; 'block' when it opened a display block. */
  pending: 'inline' | 'block' | null;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * An answer as it streams in, without a formula that has opened but not closed yet.
 *
 * Until its closer arrives, `$$…`, `\[…`, `\(…` or `$…` is only raw TeX — every backslash, drawn
 * as ₩ in a Korean UI font — that snaps into a typeset formula a moment later. The text is cut
 * at such an opener in the last block so a placeholder can stand in for it. Only openers that
 * can still close count: a single `$` on the line being written (inline math never crosses a
 * line break), not after a digit and not before a space or digit (money). Nothing inside code
 * (a fence, a closed code span, or after an unclosed backtick run) is ever cut.
 */
export function streamingView(source: string): StreamingView {
  const text = source.replace(/\r\n?/g, '\n');
  // The last block starts after the last blank line or fence line outside a fence; a formula
  // never spans a blank line, and one still open inside a fence is code.
  let fence: { char: string; length: number } | null = null;
  let blockStart = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    const next = offset + line.length + 1;
    if (fence !== null) {
      const closing = new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}[ \\t]*$`);
      if (closing.test(line)) {
        fence = null;
        blockStart = next;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open !== null) {
        fence = { char: open[1][0], length: open[1].length };
        blockStart = next;
      } else if (line.trim().length === 0) {
        blockStart = next;
      }
    }
    offset = next;
  }
  if (fence !== null) return { text, pending: null };

  const lineStartsAt = (index: number) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', index - 1) + 1, index));
  let index = blockStart;
  while (index < text.length) {
    const char = text[index];
    if (char === '`') {
      const length = codeRun(text, index);
      const close = text.indexOf('`'.repeat(length), index + length);
      // A code span still being written may hold anything; nothing after it is cut.
      if (close < 0) return { text, pending: null };
      index = close + length;
      continue;
    }
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '(' || next === '[') {
        const match = scanMath(text, index);
        if (match === null) return { text: text.slice(0, index), pending: next === '[' && lineStartsAt(index) ? 'block' : 'inline' };
        index = match.end;
        continue;
      }
      index += 2; // an escaped character, `\$` and `\\` included
      continue;
    }
    if (char === '$') {
      const match = scanMath(text, index);
      if (match !== null) {
        index = match.end;
        continue;
      }
      if (text.startsWith('$$', index)) return { text: text.slice(0, index), pending: lineStartsAt(index) ? 'block' : 'inline' };
      const after = text[index + 1];
      const lastLine = !text.includes('\n', index);
      const opens = after !== undefined && !SPACE.test(after) && !/[0-9$]/.test(after) && !/[0-9]/.test(text[index - 1] ?? '');
      if (lastLine && opens && !text.includes('$', index + 1)) return { text: text.slice(0, index), pending: 'inline' };
      index += 1;
      continue;
    }
    index += 1;
  }
  return { text, pending: null };
}

/** Read an answer into blocks. */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // Leading tabs count as four columns each; tabs elsewhere stay as written.
    .map((line) => line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    ')));
  return parseLines(lines, 0);
}
