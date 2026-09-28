import katex from 'katex';

/**
 * Typeset one formula to HTML with KaTeX.
 *
 * `trust: false` keeps \href, \url, \includegraphics and the \html… commands inert, so a
 * formula can never become a link, an image or an attribute. Bad TeX renders as its own source
 * in the error colour instead of throwing. This string is the only HTML the answer view ever
 * injects; everything else is React text.
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 400;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderTex(tex: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 40, maxExpand: 500 });
  } catch {
    html = `<span class="md-math-error">${escapeHtml(tex)}</span>`;
  }
  // A streamed answer re-renders many times; keep recent formulas, forget the oldest.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
  return html;
}
