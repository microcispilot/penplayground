import { LessonEvent } from '@pen/contracts';
import { JSONParser } from '@streamparser/json';

export interface ParsedEventSink {
  onEvent(event: LessonEvent): void;
  /** Called for elements that failed contract validation (kept out of the stream, reported). */
  onInvalid(raw: unknown, error: unknown): void;
}

/**
 * Incremental parser over the model's raw JSON text: emits each element of
 * `$.events` the moment its closing brace lands. Long `say` texts are re-split
 * into sentences so TTS never waits on a paragraph.
 */
export class LessonEventParser {
  private readonly parser: JSONParser;

  constructor(private readonly sink: ParsedEventSink) {
    this.parser = new JSONParser({ paths: ['$.events.*'], keepStack: false });
    this.parser.onValue = ({ value }) => this.handle(value);
    this.parser.onError = () => {
      /* end() on truncated JSON is handled by the caller; mid-stream errors surface through onInvalid */
    };
  }

  write(chunk: string): void {
    try {
      this.parser.write(chunk);
    } catch (error) {
      this.sink.onInvalid(chunk, error);
    }
  }

  end(): void {
    try {
      this.parser.end();
    } catch {
      /* truncated tail: elements already emitted are valid; nothing more to recover */
    }
  }

  private handle(raw: unknown): void {
    const parsed = LessonEvent.safeParse(raw);
    if (!parsed.success) {
      // Most common cheap-model slip: an over-long say. Split it rather than drop it.
      if (
        isRecord(raw) &&
        raw.type === 'say' &&
        typeof raw.text === 'string' &&
        raw.text.length > 400
      ) {
        const pieces = splitSentences(raw.text);
        pieces.forEach((piece, i) => {
          // s7 → s7, s7a, s7b … so anchors to s7 still resolve to the first piece.
          const id =
            i === 0
              ? String(raw.id)
              : `${String(raw.id)}${String.fromCharCode(96 + Math.min(i, 26))}`;
          const ev = LessonEvent.safeParse({ ...raw, id, text: piece });
          if (ev.success) this.sink.onEvent(ev.data);
        });
        return;
      }
      this.sink.onInvalid(raw, parsed.error);
      return;
    }
    this.sink.onEvent(parsed.data);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('en', { granularity: 'sentence' })
    : null;

export function splitSentences(text: string): string[] {
  if (!segmenter) return [text];
  const out: string[] = [];
  let buf = '';
  for (const { segment } of segmenter.segment(text)) {
    if ((buf + segment).length > 380 && buf) {
      out.push(buf.trim());
      buf = '';
    }
    buf += segment;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
