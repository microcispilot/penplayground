import { HTMLContainer, T, type TLBaseShape } from 'tldraw';
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
    w: T.number,
    h: T.number,
  };

  getDefaultProps(): NoteCardProps {
    return { label: 'You asked', question: '', detail: '', w: 300, h: 120 };
  }

  component(shape: NoteCardShape) {
    const { label, question, detail, w, h } = shape.props;
    return (
      <HTMLContainer style={{ width: w, height: h, pointerEvents: 'none' }}>
        <article
          className="pen-note"
          style={{ padding: NOTE_PADDING, minHeight: h }}
          aria-label="You asked"
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
