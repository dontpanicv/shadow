/** The first wait before the socket connects again; it doubles on each failure, up to `LONGEST_WAIT`. */
const FIRST_WAIT = 1000;
const LONGEST_WAIT = 60_000;

/** What a Socket Mode connection tells its owner. */
export interface SlackSocketHandlers {
  /** The connection is open: Slack sends events from now on, so whatever came before needs a catch-up. */
  readonly hello: () => void;
  /** An event of the Events API, such as `message` or `channel_rename`. */
  readonly event: (event: { readonly type: string }) => void;
  /** The connection failed or closed; it connects again by itself. */
  readonly lost: (error: unknown) => void;
}

/** The part of a WebSocket that the socket uses, so tests give their own. */
export interface SocketLike {
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send: (data: string) => void;
  close: () => void;
}

/**
 * Slack's Socket Mode: Shadow opens a WebSocket to Slack with the app token, so Slack's events reach it without a
 * public address. Each envelope is acknowledged at once. When Slack asks for a new connection, or the connection drops,
 * the socket connects again, waiting longer after each failure.
 *
 * @example
 * const socket = new SlackSocket(() => api.openSocket(appToken), { hello, event, lost });
 * socket.start();
 */
export class SlackSocket {
  private socket: SocketLike | null = null;
  private stopped = false;
  private wait = FIRST_WAIT;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** The address of a new connection, from apps.connections.open. */
    private readonly open: () => Promise<string>,
    private readonly handlers: SlackSocketHandlers,
    private readonly connectTo: (url: string) => SocketLike = (url) =>
      new WebSocket(url) as unknown as SocketLike
  ) {}

  start(): void {
    this.connect();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    const { socket } = this;
    this.socket = null;
    socket?.close();
  }

  private async connect(): Promise<void> {
    try {
      const url = await this.open();
      if (this.stopped) {
        return;
      }
      const socket = this.connectTo(url);
      this.socket = socket;
      socket.onmessage = (message) =>
        this.receive(socket, String(message.data));
      socket.onclose = () => {
        // A socket that Shadow replaced or closed says nothing more.
        if (this.socket === socket) {
          this.again(new Error("Slack closed the connection"));
        }
      };
    } catch (error) {
      this.again(error);
    }
  }

  private receive(socket: SocketLike, data: string): void {
    const envelope = JSON.parse(data) as {
      envelope_id?: string;
      type?: string;
      payload?: { event?: { type: string } };
    };
    if (envelope.envelope_id) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type === "hello") {
      this.wait = FIRST_WAIT;
      this.handlers.hello();
    } else if (envelope.type === "events_api" && envelope.payload?.event) {
      this.handlers.event(envelope.payload.event);
    } else if (envelope.type === "disconnect") {
      // Slack refreshes connections now and then: the next one opens at once.
      this.socket = null;
      socket.close();
      this.connect();
    }
  }

  private again(error: unknown): void {
    this.socket = null;
    if (this.stopped) {
      return;
    }
    this.handlers.lost(error);
    this.timer = setTimeout(() => this.connect(), this.wait);
    this.wait = Math.min(this.wait * 2, LONGEST_WAIT);
  }
}
