import { type ReactNode, useMemo } from 'react';
import { HTMLContainer, T, type TLBaseShape } from 'tldraw';
import { type MdBlock, type MdInline, parseMarkdown } from '../markdown.js';
import { PaperShapeUtil } from './paper-shape.js';
import { MD_PADDING, type MdBlockProps, SHAPE_TYPE } from './props.js';

/**
 * `md-block`: the markdown subset rendered as React (escaped by construction)
 * and revealed like a typewriter with a running character budget.
 */
export type MdBlockShape = TLBaseShape<'md-block', MdBlockProps>;

export class MdBlockShapeUtil extends PaperShapeUtil<MdBlockShape> {
  static override type = SHAPE_TYPE.mdBlock;
  static override props = {
    source: T.string,
    w: T.number,
    h: T.number,
    progress: T.number,
    fontSize: T.number,
  };

  getDefaultProps(): MdBlockProps {
    return { source: '', w: 1, h: 1, progress: 1, fontSize: 19 };
  }

  component(shape: MdBlockShape) {
    return <MdBlockView shape={shape} />;
  }
}

function MdBlockView({ shape }: { shape: MdBlockShape }) {
  const { source, w, h, progress, fontSize } = shape.props;
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const total = useMemo(() => countChars(blocks), [blocks]);
  const budget = { left: Math.floor(Math.max(0, Math.min(1, progress)) * total) };
  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: 'none' }}>
      <div className="pen-md" style={{ fontSize, padding: MD_PADDING }}>
        {blocks.map((b, i) => (budget.left > 0 || i === 0 ? renderBlock(b, i, budget) : null))}
      </div>
    </HTMLContainer>
  );
}

interface Budget {
  left: number;
}

function countInline(inlines: readonly MdInline[]): number {
  let n = 0;
  for (const x of inlines) n += x.type === 'text' || x.type === 'code' ? x.text.length : countInline(x.children);
  return n;
}

function countChars(blocks: readonly MdBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'heading' || b.type === 'paragraph') n += countInline(b.children);
    else if (b.type === 'list') for (const i of b.items) n += countInline(i);
    else if (b.type === 'table') {
      for (const c of b.header) n += countInline(c);
      for (const r of b.rows) for (const c of r) n += countInline(c);
    } else if (b.type === 'code') n += b.text.length;
    else n += 1;
  }
  return n;
}

function renderInlines(inlines: readonly MdInline[], budget: Budget): ReactNode[] {
  const out: ReactNode[] = [];
  inlines.forEach((n, i) => {
    if (budget.left <= 0) return;
    switch (n.type) {
      case 'text': {
        const t = n.text.slice(0, budget.left);
        budget.left -= t.length;
        out.push(t);
        break;
      }
      case 'code': {
        const t = n.text.slice(0, budget.left);
        budget.left -= t.length;
        // biome-ignore lint/suspicious/noArrayIndexKey: inline order is fixed
        out.push(<code key={i}>{t}</code>);
        break;
      }
      case 'bold':
        // biome-ignore lint/suspicious/noArrayIndexKey: inline order is fixed
        out.push(<strong key={i}>{renderInlines(n.children, budget)}</strong>);
        break;
      case 'italic':
        // biome-ignore lint/suspicious/noArrayIndexKey: inline order is fixed
        out.push(<em key={i}>{renderInlines(n.children, budget)}</em>);
        break;
    }
  });
  return out;
}

function renderBlock(b: MdBlock, key: number, budget: Budget): ReactNode {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${b.level}` as 'h1' | 'h2' | 'h3';
      return <Tag key={key}>{renderInlines(b.children, budget)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{renderInlines(b.children, budget)}</p>;
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key}>
          {b.items.map((item, i) =>
            budget.left > 0 || i === 0 ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: items never reorder
              <li key={i}>{renderInlines(item, budget)}</li>
            ) : null,
          )}
        </Tag>
      );
    }
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>
              {b.header.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells never reorder
                <th key={i}>{renderInlines(c, budget)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, ri) =>
              budget.left > 0 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
                <tr key={ri}>
                  {r.map((c, ci) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells never reorder
                    <td key={ci}>{renderInlines(c, budget)}</td>
                  ))}
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      );
    case 'code': {
      const t = b.text.slice(0, Math.max(0, budget.left));
      budget.left -= t.length;
      return (
        <pre key={key}>
          <code>{t}</code>
        </pre>
      );
    }
    case 'rule':
      budget.left -= 1;
      return <hr key={key} />;
  }
}
