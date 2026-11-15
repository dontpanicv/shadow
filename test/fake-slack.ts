import type { SocketLike } from "../src/integrations/slack-socket.ts";

/** A Socket Mode connection that a test speaks for Slack on; it keeps what Shadow sends back. */
export class FakeSocket implements SocketLike {
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

/**
 * A Slack whose channels, messages, and replies a test changes. It answers the methods that the bot calls, lists the
 * channels in two pages, answers `not_in_channel` until the bot joins a channel, and speaks Socket Mode on the newest
 * connection.
 */
export function fakeSlack() {
  const slack = {
    channels: [] as Record<string, unknown>[],
    /** The messages of each channel, newest first, with the replies of each thread in `replies`. */
    messages: {} as Record<string, Record<string, unknown>[]>,
    replies: {} as Record<string, Record<string, unknown>[]>,
    users: { U1: "Alice Novak", U2: "Bob Smith" } as Record<string, string>,
    /** The email of each user, which users.info gives. */
    emails: {} as Record<string, string>,
    /** What Shadow posted, updated, or published, in order, with the JSON body of each write. */
    writes: [] as {
      method: string;
      body: Record<string, unknown>;
      /** The ts of the message that Slack gave back. */
      ts: string;
    }[],
    joined: new Set<string>(),
    token: "xoxb-good",
    appToken: "xapp-good",
    /** Each call, with its query. */
    calls: [] as { method: string; query: URLSearchParams }[],
    sockets: [] as FakeSocket[],
    connectTo: (_url: string) => {
      const socket = new FakeSocket();
      slack.sockets.push(socket);
      return socket;
    },
    /** Sends an envelope on the newest connection. */
    send(envelope: Record<string, unknown>) {
      slack.sockets.at(-1)!.onmessage!({
        data: JSON.stringify({ envelope_id: crypto.randomUUID(), ...envelope }),
      });
    },
    event(event: Record<string, unknown>) {
      slack.send({ type: "events_api", payload: { event } });
    },
    /** A write of Shadow, such as chat.postMessage: kept in `writes`, with a new message ts. */
    write(method: string, body: Record<string, unknown>) {
      const ts =
        method === "chat.update"
          ? String(body.ts)
          : String(slack.writes.length + 1_000_001);
      slack.writes.push({ method, body, ts });
      if (method === "conversations.open") {
        return Response.json({ ok: true, channel: { id: `D-${body.users}` } });
      }
      return Response.json({ ok: true, ts });
    },
    /** A read of Shadow, such as conversations.history. */
    read(pathname: string, query: URLSearchParams) {
      const channel = query.get("channel") ?? "";
      switch (pathname) {
        case "/api/auth.test":
          return Response.json({
            ok: true,
            team: "Acme",
            team_id: "T1",
            url: "https://acme.slack.com/",
            user_id: "B1",
          });
        case "/api/conversations.info":
          // A group DM's id starts with G here; the others are channels.
          return Response.json({
            ok: true,
            channel: { id: channel, is_mpim: channel.startsWith("G") },
          });
        case "/api/conversations.join":
          slack.joined.add(channel);
          return Response.json({ ok: true });
        case "/api/conversations.history": {
          if (slack.messages[channel] && !slack.joined.has(channel)) {
            return Response.json({ ok: false, error: "not_in_channel" });
          }
          const oldest = Number(query.get("oldest"));
          return Response.json({
            ok: true,
            messages: (slack.messages[channel] ?? []).filter(
              (message) => Number(message.ts) >= oldest
            ),
          });
        }
        case "/api/conversations.replies": {
          const ts = query.get("ts")!;
          const parent = slack.messages[channel]!.find(
            (message) => message.ts === ts
          )!;
          return Response.json({
            ok: true,
            messages: [parent, ...(slack.replies[ts] ?? [])],
          });
        }
        case "/api/users.info": {
          const id = query.get("user")!;
          return Response.json({
            ok: true,
            user: {
              real_name: slack.users[id],
              profile: { email: slack.emails[id] },
            },
          });
        }
        case "/api/conversations.list": {
          // Two pages, so the bot follows the cursor.
          const second = query.get("cursor") === "next";
          const half = Math.ceil(slack.channels.length / 2);
          return Response.json({
            ok: true,
            channels: second
              ? slack.channels.slice(half)
              : slack.channels.slice(0, half),
            response_metadata: { next_cursor: second ? "" : "next" },
          });
        }
        default:
          // An attachment's download.
          return new Response(`bytes of ${pathname}`);
      }
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const query = url.searchParams;
      slack.calls.push({ method: url.pathname, query });
      const auth = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/api/apps.connections.open") {
        return Response.json(
          auth === `Bearer ${slack.appToken}`
            ? { ok: true, url: "wss://socket.slack.example/1" }
            : { ok: false, error: "invalid_auth" }
        );
      }
      if (init?.method === "POST" && init.body) {
        return slack.write(
          url.pathname.replace("/api/", ""),
          JSON.parse(String(init.body)) as Record<string, unknown>
        );
      }
      if (auth !== `Bearer ${slack.token}`) {
        return Response.json({ ok: false, error: "invalid_auth" });
      }
      return slack.read(url.pathname, query);
    }) as typeof fetch,
  };
  return slack;
}
