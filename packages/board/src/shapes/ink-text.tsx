import { getStroke } from 'perfect-freehand';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { SVGContainer, T, type TLBaseShape } from 'tldraw';
import { FallbackFont, type GlyphSource, getHandFont, whenHandFont } from '../font.js';
import { type HandTextLayout, layoutHandText } from '../glyphs.js';
import { handUnderline, outlineToPath, revealStrokes } from '../primitives.js';
import { hasNonFinite, sanitisePathData } from '../svg-path.js';
import { EMPHASIS_VALUES, inkVar, PaperShapeUtil, resolveInk } from './paper-shape.js';
import {
  type InkTextProps,
  inkTextUnits,
  SHAPE_TYPE,
  STROKE_STYLE,
  UNDERLINE_UNITS,
} from './props.js';

/**
 * `ink-text`: handwriting. Glyph outlines come from the Caveat font via
 * opentype.js; the reveal is glyph by glyph, and inside the current glyph a
 * clip sweeps left→right across its advance so the ink appears the way a nib
 * lays it down. Symbols the font lacks are synthesised pen strokes revealed
 * by dash offset; characters with no outline at all fall back to CSS text in
 * the hand font under the same clip. Titles finish with an accent underline.
 */
export type InkTextShape = TLBaseShape<'ink-text', InkTextProps>;

const fallbackFont = new FallbackFont();

/** Re-render once the font arrives so early shapes upgrade from CSS text to outlines. */
function useGlyphSource(): GlyphSource {
  const [font, setFont] = useState<GlyphSource | null>(() => getHandFont());
  useEffect(() => {
    if (font) return;
    let alive = true;
    whenHandFont().then((f) => {
      if (alive) setFont(f);
    });
    return () => {
      alive = false;
    };
  }, [font]);
  return font ?? fallbackFont;
}

export class InkTextShapeUtil extends PaperShapeUtil<InkTextShape> {
  static override type = SHAPE_TYPE.inkText;
  static override props = {
    text: T.string,
    style: T.literalEnum('title', 'write', 'label'),
    emphasis: T.literalEnum(...EMPHASIS_VALUES),
    fontSize: T.number,
    maxWidth: T.number,
    align: T.literalEnum('left', 'center'),
    w: T.number,
    h: T.number,
    progress: T.number,
    seed: T.string,
    underline: T.boolean,
  };

  getDefaultProps(): InkTextProps {
    return {
      text: '',
      style: 'write',
      emphasis: 'ink',
      fontSize: 36,
      maxWidth: 640,
      align: 'left',
      w: 1,
      h: 1,
      progress: 1,
      seed: 'seed',
      underline: false,
    };
  }

  component(shape: InkTextShape) {
    return <InkTextView shape={shape} />;
  }

  override toSvg(shape: InkTextShape) {
    const font = getHandFont() ?? fallbackFont;
    const p = shape.props;
    const layout = layoutFor(font, p.text, p.fontSize, p.maxWidth, p.seed, p.align);
    const color = resolveInk(this.editor.getContainer(), shape.props.emphasis);
    return (
      <InkTextGlyphs
        layout={layout}
        props={{ ...shape.props, progress: 1 }}
        color={color}
        clipId={null}
      />
    );
  }
}

function layoutFor(
  font: GlyphSource,
  text: string,
  fontSize: number,
  maxWidth: number,
  seed: string,
  align: 'left' | 'center',
): HandTextLayout {
  return layoutHandText(font, text, {
    fontSize,
    maxWidth: Math.max(fontSize, maxWidth),
    seed,
    align,
  });
}

function InkTextView({ shape }: { shape: InkTextShape }) {
  const font = useGlyphSource();
  const { text, fontSize, maxWidth, seed, align } = shape.props;
  const layout = useMemo(
    () => layoutFor(font, text, fontSize, maxWidth, seed, align),
    [font, text, fontSize, maxWidth, seed, align],
  );
  const color = inkVar(shape.props.emphasis);
  return (
    <SVGContainer style={{ overflow: 'visible' }}>
      <InkTextGlyphs
        layout={layout}
        props={shape.props}
        color={color}
        clipId={`${shape.id}-clip`}
      />
    </SVGContainer>
  );
}

interface GlyphsProps {
  layout: HandTextLayout;
  props: InkTextProps;
  color: string;
  /** Unique id for the partial-glyph clip; null disables partial rendering (exports). */
  clipId: string | null;
}

function InkTextGlyphs({ layout, props, color, clipId }: GlyphsProps) {
  const units = inkTextUnits(props.text, props.underline);
  const revealedUnits = Math.max(0, Math.min(1, props.progress)) * units;
  const textUnits = props.text.length;
  const revealed = Math.min(textUnits, revealedUnits);
  const strokeW = Math.max(0.6, props.fontSize * 0.05);
  const nodes: ReactElement[] = [];
  let nib: { x: number; y: number } | null = null;

  for (const line of layout.lines) {
    for (const g of line.glyphs) {
      if (g.char === ' ') continue;
      const start = g.index;
      if (revealed <= start) continue;
      // A right-to-left run reveals over its whole length; a glyph over its own width.
      const frac = Math.min(1, (revealed - start) / (g.kind === 'run' ? (g.chars ?? 1) : 1));
      const partial = frac < 1 && clipId !== null;
      const transform = g.rotation
        ? `rotate(${g.rotation.toFixed(2)} ${g.x.toFixed(2)} ${g.y.toFixed(2)})`
        : undefined;
      const key = `${line.baseline}-${g.index}`;
      // Last line of defence: nothing non-finite reaches the DOM.
      const d = hasNonFinite(g.d) ? sanitisePathData(g.d).d : g.d;
      let el: ReactElement;
      if (g.kind === 'run') {
        // The browser shapes and joins the run; the pen only decides how much of it shows.
        const id = clipId ? `${clipId}-run-${g.index}` : null;
        const visible = (
          <text
            key={key}
            x={g.x}
            y={g.y}
            fill={color}
            fontFamily="var(--font-hand)"
            fontSize={props.fontSize}
            direction="rtl"
            textAnchor="start"
            style={{ userSelect: 'none', unicodeBidi: 'plaintext' }}
          >
            {g.char}
          </text>
        );
        if (frac < 1 && id) {
          nodes.push(
            <g key={`${key}-clip`} clipPath={`url(#${id})`}>
              <clipPath id={id}>
                {/* The hand moves right to left: the window opens from the right edge. */}
                <rect
                  x={g.x - g.advance * frac}
                  y={0}
                  width={Math.max(0, g.advance * frac)}
                  height={props.h + props.fontSize}
                />
              </clipPath>
              {visible}
            </g>,
          );
          nib = { x: g.x - g.advance * frac, y: g.y - props.fontSize * 0.28 };
        } else nodes.push(visible);
        continue;
      }
      if (g.kind === 'outline') {
        el = (
          <path
            key={key}
            d={d}
            transform={transform}
            fill={color}
            stroke={color}
            strokeWidth={strokeW * 0.5}
            strokeLinejoin="round"
          />
        );
      } else if (g.kind === 'stroke') {
        el = (
          <path
            key={key}
            d={d}
            transform={transform}
            fill="none"
            stroke={color}
            strokeWidth={strokeW * 1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={partial ? 1 - frac : 0}
          />
        );
      } else {
        el = (
          <text
            key={key}
            x={g.x}
            y={g.y}
            transform={transform}
            fill={color}
            fontFamily="var(--font-hand)"
            fontSize={props.fontSize}
            style={{ userSelect: 'none' }}
          >
            {g.char}
          </text>
        );
      }
      if (partial && g.kind !== 'stroke' && clipId) {
        const id = `${clipId}-${g.index}`;
        const pad = props.fontSize * 0.08;
        nodes.push(
          <g key={`${key}-clip`} clipPath={`url(#${id})`}>
            <clipPath id={id}>
              <rect
                x={g.x - pad}
                y={0}
                width={Math.max(0, (g.advance + pad * 2) * frac)}
                height={props.h + props.fontSize}
              />
            </clipPath>
            {el}
          </g>,
        );
        nib = { x: g.x - pad + (g.advance + pad * 2) * frac, y: g.y - props.fontSize * 0.28 };
      } else {
        nodes.push(el);
        if (partial) nib = { x: g.x + g.advance * frac, y: g.y - props.fontSize * 0.28 };
      }
    }
  }

  // Title underline: the last UNDERLINE_UNITS of progress, drawn as a marker stroke.
  let underline: ReactElement | null = null;
  if (props.underline && revealedUnits > textUnits) {
    const frac = Math.min(1, (revealedUnits - textUnits) / UNDERLINE_UNITS);
    const y = layout.height + 2;
    const strokes = handUnderline(layout.width, `${props.seed}:underline`);
    const parts = revealStrokes(strokes, frac);
    underline = (
      <g
        transform={`translate(0 ${y.toFixed(2)})`}
        fill="var(--color-ink-accent)"
        style={{ mixBlendMode: 'multiply' }}
      >
        {parts.map((p, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional and never reorder
            key={i}
            d={outlineToPath(getStroke(p.points, { ...STROKE_STYLE, size: 3.4, last: p.complete }))}
          />
        ))}
      </g>
    );
    if (frac < 1) {
      const last = parts[parts.length - 1]?.points.at(-1);
      if (last) nib = { x: last[0], y: y + last[1] };
    }
  }

  return (
    <g>
      {nodes}
      {underline}
      {nib && clipId ? (
        <circle
          cx={nib.x}
          cy={nib.y}
          r={Math.max(1.4, props.fontSize * 0.045)}
          fill={color}
          opacity={0.9}
        />
      ) : null}
    </g>
  );
}
