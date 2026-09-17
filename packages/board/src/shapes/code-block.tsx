import { HTMLContainer, T, type TLBaseShape } from 'tldraw';
import { PaperShapeUtil } from './paper-shape.js';
import { CODE_PADDING, type CodeBlockProps, SHAPE_TYPE } from './props.js';

/**
 * `code-block`: Shiki-tokenised code revealed like a typewriter, character by
 * character across tokens, with a caret at the tip while typing. Colours are
 * github-light's on the paper; the default foreground is the ink token.
 */
export type CodeBlockShape = TLBaseShape<'code-block', CodeBlockProps>;

const tokenValidator = T.object({
  t: T.string,
  c: T.nullable(T.string),
  b: T.boolean,
  i: T.boolean,
});

export class CodeBlockShapeUtil extends PaperShapeUtil<CodeBlockShape> {
  static override type = SHAPE_TYPE.codeBlock;
  static override props = {
    code: T.string,
    lang: T.string,
    lines: T.arrayOf(T.arrayOf(tokenValidator)),
    w: T.number,
    h: T.number,
    progress: T.number,
    fontSize: T.number,
  };

  getDefaultProps(): CodeBlockProps {
    return { code: '', lang: '', lines: [], w: 1, h: 1, progress: 1, fontSize: 17 };
  }

  component(shape: CodeBlockShape) {
    const { code, lines, progress, fontSize, w, h, lang } = shape.props;
    const budget = Math.floor(Math.max(0, Math.min(1, progress)) * code.length);
    const typing = progress > 0 && progress < 1;
    let left = budget;
    const rows: JSX.Element[] = [];
    for (let li = 0; li < lines.length; li++) {
      if (left <= 0 && li > 0) break;
      const line = lines[li] ?? [];
      const spans: JSX.Element[] = [];
      for (let ti = 0; ti < line.length; ti++) {
        const tok = line[ti];
        if (!tok || left <= 0) break;
        const text = tok.t.length <= left ? tok.t : tok.t.slice(0, left);
        left -= text.length;
        spans.push(
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: token order is fixed for a shape
            key={ti}
            style={{
              color: tok.c ?? undefined,
              fontWeight: tok.b ? 600 : undefined,
              fontStyle: tok.i ? 'italic' : undefined,
            }}
          >
            {text}
          </span>,
        );
      }
      const isTip = typing && left <= 0;
      rows.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder
        <div key={li} className="pen-code__line">
          {spans.length ? spans : '​'}
          {isTip ? <span className="pen-code__caret" aria-hidden="true" /> : null}
        </div>,
      );
      if (left <= 0) break;
      left -= 1; // the newline
    }
    return (
      <HTMLContainer style={{ width: w, height: h, pointerEvents: 'none' }}>
        <div className="pen-code" style={{ fontSize, padding: CODE_PADDING }}>
          {lang ? <span className="pen-code__lang">{lang}</span> : null}
          <pre className="pen-code__pre">{rows}</pre>
        </div>
      </HTMLContainer>
    );
  }
}
