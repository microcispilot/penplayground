import {
  type ClientMessage,
  type DownstreamAudioHeader,
  decodeAudioFrame,
  ServerMessage,
} from '@pen/contracts';

export interface RoomClientHandlers {
  onMessage(message: ServerMessage): void;
  onAudio(header: DownstreamAudioHeader, pcm: Uint8Array): void;
  onStatus(status: RoomConnectionStatus): void;
}

export type RoomConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

/**
 * Room WebSocket client: auth-then-join handshake, Zod-validated inbound
 * messages, binary audio frames, and exponential-backoff reconnect that
 * re-joins the same session (the server replays the backlog).
 */
export class RoomClient {
  private socket: WebSocket | null = null;
  private status: RoomConnectionStatus = 'closed';
  private attempts = 0;
  private closedByUser = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly sessionId: string,
    private readonly handlers: RoomClientHandlers,
    private readonly name?: string,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendAudio(frame: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(1000, 'leave');
    this.socket = null;
    this.setStatus('closed');
  }

  private open(): void {
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      socket.send(JSON.stringify({ kind: 'auth', token: this.token } satisfies ClientMessage));
      socket.send(
        JSON.stringify({
          kind: 'join',
          sessionId: this.sessionId,
          ...(this.name ? { name: this.name } : {}),
        } satisfies ClientMessage),
      );
      this.setStatus('open');
    };
    socket.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        try {
          const { header, pcm } = decodeAudioFrame(new Uint8Array(evt.data));
          if (header.dir === 'down') this.handlers.onAudio(header, pcm);
        } catch (error) {
          console.warn('[room] bad audio frame', error);
        }
        return;
      }
      if (typeof evt.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      const message = ServerMessage.safeParse(parsed);
      if (!message.success) {
        console.warn('[room] unknown message', message.error.issues[0]?.message);
        return;
      }
      this.handlers.onMessage(message.data);
    };
    socket.onclose = (evt) => {
      if (this.closedByUser) return;
      if (evt.code === 4001) {
        this.setStatus('failed');
        return;
      }
      this.attempts += 1;
      if (this.attempts > 8) {
        this.setStatus('failed');
        return;
      }
      const delay = Math.min(8000, 400 * 2 ** this.attempts);
      this.setStatus('reconnecting');
      this.timer = setTimeout(() => this.open(), delay);
    };
    socket.onerror = () => {
      /* onclose follows and drives the reconnect policy */
    };
  }

  private setStatus(status: RoomConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }
}
