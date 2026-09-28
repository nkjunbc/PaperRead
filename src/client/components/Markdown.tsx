import 'katex/dist/katex.min.css';
import { Fragment, memo, useMemo, type JSX, type ReactNode } from 'react';
import { parseMarkdown, streamingView, type MdBlock, type MdInline } from '../lib/markdown';
import { renderTex } from '../lib/tex';
import { CopyButton } from './CopyButton';

/**
 * An answer's markdown as React elements.
 *
 * Every piece of the answer reaches the page as React text or as an element this file chose;
 * the one exception is KaTeX's own output for a formula (lib/tex), rendered with trust off.
 */

/** Inline code up to this long stays on one line; a longer span may wrap like prose. */
const SHORT_CODE = 24;

function Caret(): JSX.Element {
  return <span className="md-caret" aria-hidden="true" />;
}

/** What follows the last words of an answer still being written: a formula that has opened but
 * not closed yet stands as a placeholder (after the space that preceded it), then the caret. */
function Tail({ pending, spaced }: { pending: boolean; spaced: boolean }): JSX.Element {
  return (
    <>
      {pending && spaced ? ' ' : null}
      {pending ? <span className="md-math-pending">수식…</span> : null}
      <Caret />
    </>
  );
}

function Formula({ tex, display }: { tex: string; display: boolean }): JSX.Element {
  // The one injected HTML in the answer view: KaTeX output, typeset with trust off (lib/tex).
  return <span className={display ? 'md-math md-math--display' : 'md-math'} dangerouslySetInnerHTML={{ __html: renderTex(tex, display) }} />;
}

function renderInline(nodes: MdInline[], key: string, inLink = false): ReactNode[] {
  return nodes.map((node, index) => {
    const id = `${key}.${index}`;
    switch (node.type) {
      case 'text':
        return node.text;
      case 'break':
        return <br key={id} />;
      case 'strong':
        return <strong key={id}>{renderInline(node.children, id, inLink)}</strong>;
      case 'em':
        return <em key={id}>{renderInline(node.children, id, inLink)}</em>;
      case 'del':
        return <del key={id}>{renderInline(node.children, id, inLink)}</del>;
      case 'code':
        // A short span (`dropout = 0.1`) is one token to the reader; it never splits across lines.
        return (
          <code key={id} className={node.text.length <= SHORT_CODE ? 'md-inline-code md-inline-code--short' : 'md-inline-code'}>
            {node.text}
          </code>
        );
      case 'math':
        return <Formula key={id} tex={node.tex} display={node.display} />;
      case 'link':
        // A link inside a link label is only its words.
        if (inLink) return <span key={id}>{renderInline(node.children, id, true)}</span>;
        return (
          <a key={id} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children, id, true)}
          </a>
        );
    }
  });
}

function withTail(children: ReactNode[], tail: ReactNode): ReactNode[] {
  return tail === null ? children : [...children, <Fragment key="tail">{tail}</Fragment>];
}

/** Renders one block; `tail` (or null) goes after its last words. */
function renderBlock(block: MdBlock, key: string, tail: ReactNode): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{withTail(renderInline(block.children, key), tail)}</p>;
    case 'heading': {
      // Answer headings sit under the panel's own heading (h2), so they start at h3.
      const Tag = `h${Math.min(6, block.level + 2)}` as 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag key={key} className={`md-h md-h${block.level}`}>
          {withTail(renderInline(block.children, key), tail)}
        </Tag>
      );
    }
    case 'code':
      return (
        <div key={key} className="md-code">
          <div className="md-code__bar">
            <span className="md-code__lang">{block.lang ?? '코드'}</span>
            <CopyButton text={block.text} label="코드 복사" />
          </div>
          <pre tabIndex={0}>
            <code>
              {block.text}
              {tail}
            </code>
          </pre>
        </div>
      );
    case 'math':
      return (
        <div key={key} className="md-math-block">
          <Formula tex={block.tex} display />
          {tail}
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => {
        const id = `${key}.${index}`;
        return <li key={id}>{renderBlocks(item, id, index === block.items.length - 1 ? tail : null)}</li>;
      });
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks(block.children, key, tail)}</blockquote>;
    case 'table': {
      const table = (
        <div key={key} className="md-table" role="region" aria-label="표" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th key={column} scope="col" style={block.align[column] === null ? undefined : { textAlign: block.align[column] ?? undefined }}>
                    {renderInline(cell, `${key}.h${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} style={block.align[column] === null ? undefined : { textAlign: block.align[column] ?? undefined }}>
                      {renderInline(cell, `${key}.${rowIndex}.${column}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      // The caret goes under the table, never inside its bordered box.
      return tail === null ? (
        table
      ) : (
        [
          table,
          <div key={`${key}.tail`} className="md-tail md-tail--block">
            {tail}
          </div>,
        ]
      );
    }
    case 'hr':
      return tail === null ? (
        <hr key={key} />
      ) : (
        <div key={key}>
          <hr />
          {tail}
        </div>
      );
  }
}

function renderBlocks(blocks: MdBlock[], key: string, tail: ReactNode): ReactNode[] {
  if (blocks.length === 0) return tail === null ? [] : [<Fragment key={`${key}.tail`}>{tail}</Fragment>];
  return blocks.map((block, index) => renderBlock(block, `${key}.${index}`, index === blocks.length - 1 ? tail : null));
}

export interface MarkdownProps {
  text: string;
  /** Show a writing caret at the end of the text (an answer still streaming in). */
  caret?: boolean;
  className?: string;
}

/** Re-parsed only when the text changes; a finished answer is never parsed again. */
export const Markdown = memo(function Markdown({ text, caret = false, className }: MarkdownProps): JSX.Element {
  // While the answer streams, a formula that has opened but not closed is held back (lib/markdown).
  const view = useMemo(() => (caret ? streamingView(text) : { text, pending: null }), [text, caret]);
  const blocks = useMemo(() => parseMarkdown(view.text), [view.text]);
  const tail = caret ? <Tail pending={view.pending !== null} spaced={view.pending === 'inline' && /[ \t]$/.test(view.text)} /> : null;
  // A display formula still being written stands on its own line under the last block.
  const blockTail = view.pending === 'block';
  return (
    <div className={className === undefined ? 'md' : `md ${className}`}>
      {renderBlocks(blocks, 'b', blockTail ? null : tail)}
      {blockTail ? <p className="md-tail md-tail--block">{tail}</p> : null}
    </div>
  );
});

export default Markdown;
