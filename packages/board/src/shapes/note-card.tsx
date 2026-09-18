import { HTMLContainer, T, type TLBaseShape } from 'tldraw';
import { isRtlText } from '../text-direction.js';
import { PaperShapeUtil } from './paper-shape.js';
import { NOTE_PADDING, type NoteCardProps, SHAPE_TYPE } from './props.js';

/**
 * `note-card`: the pinned "YOU ASKED" card. Label in small caps accent, the
 * question in the hand font, the detail in sans; rises in on mount.
 */
export type NoteCardShape = TLBaseShape<'note-card', NoteCardProps>;

export class NoteCardShapeUtil extends PaperShapeUtil<NoteCardShape> {
  static override type = SHAPE_TYPE.noteCard;
  static override props = {
    label: T.string,
    question: T.string,
    detail: T.string,
    lang: T.string,
    w: T.number,
    h: T.number,
  };

  getDefaultProps(): NoteCardProps {
    return { label: 'You asked', question: '', detail: '', lang: '', w: 300, h: 120 };
  }

  component(shape: NoteCardShape) {
    const { label, question, detail, lang, w, h } = shape.props;
    // The question is the learner's own sentence: Persian, Arabic and Hebrew read right to left.
    const dir = isRtlText(question || detail, lang) ? 'rtl' : 'ltr';
    return (
      <HTMLContainer style={{ width: w, height: h, pointerEvents: 'none' }}>
        <article
          className="pen-note"
          style={{ padding: NOTE_PADDING, minHeight: h }}
          aria-label="You asked"
          {...(lang ? { lang } : {})}
          dir={dir}
        >
          <div className="pen-note__label">
            <span className="pen-note__kicker">You asked</span>
            {label && label.toLowerCase() !== 'you asked' ? (
              <span className="pen-note__headline">{label}</span>
            ) : null}
          </div>
          <p className="pen-note__question">{question}</p>
          {detail ? <p className="pen-note__detail">{detail}</p> : null}
        </article>
      </HTMLContainer>
    );
  }
}
