import type { Database } from "bun:sqlite";
import type { Companies, SlackChannel } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, required } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import { SlackApi } from "./slack-api.ts";
import {
  SlackHistory,
  type SlackHistoryPorts,
  type SlackMessageEvent,
} from "./slack-history.ts";
import { SlackSocket, type SocketLike } from "./slack-socket.ts";

/** How often the changed days of the channels are written, and quiet channels get their brief. */
export const SLACK_FLUSH_INTERVAL = 60_000;
/** How often Shadow reads the whole window of every channel again, for what the events missed. */
const DAILY_CHECK_MS = 24 * 60 * 60_000;
/** A new connection reads from a little before the last event, as an event and its reading can cross. */
const CATCH_UP_OVERLAP_MS = 5 * 60_000;
/** The events that change the list of public channels. */
const CHANNEL_EVENTS = new Set([
  "channel_created",
  "channel_rename",
  "channel_archive",
  "channel_unarchive",
  "channel_deleted",
]);

/** The Slack bot of a company, for its admins; the tokens never leave the server. */
export interface SlackBotStatus {
  readonly connected: boolean;
  /** Whether Slack's events reach Shadow now, over Socket Mode. */
  readonly listening: boolean;
  /** The Slack workspace of the bot, such as "Acme". */
  readonly team: string | null;
  /** When Shadow last heard from Slack: an event, or the end of a reading; null before the first. */
  readonly syncedAt: number | null;
  /** Why the last reading or connection failed; null when it worked. */
  readonly error: string | null;
}

type BotCompanies = Pick<
  Companies,
  "requireAdmin" | "ids" | "syncSlackChannels" | "channelsIn"
>;

interface BotRow {
  token: Uint8Array;
  bot_user_id: string | null;
  app_token: Uint8Array | null;
  team_name: string;
  synced_at: number | null;
  listened_at: number | null;
  checked_at: number | null;
  error: string | null;
}

/**
 * What the bot gives the module that talks in Slack: the events of conversations, after the mirror kept them, and the
 * clicks on Shadow's buttons. `event` returns quickly; long work runs on after it.
 */
export interface SlackSurfacePort {
  readonly event: (
    companyId: string,
    event: Record<string, unknown>
  ) => Promise<void>;
  readonly interaction: (
    companyId: string,
    payload: Record<string, unknown>
  ) => void;
}

/** Slack's Web API for a company's bot, for the module that talks in Slack; the token stays inside. */
export interface SlackClient {
  /** The bot's own Slack user, whose mentions wake Shadow and whose messages it skips. */
  readonly botUserId: string | null;
  readonly call: (
    method: string,
    params: Record<string, string>
  ) => Promise<Record<string, unknown>>;
  readonly post: (
    method: string,
    body: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  /** Slack's markup as plain Markdown, with people's names. */
  readonly plain: (text: string) => Promise<string>;
  /** The kept messages of a thread, or of the channel for a null `rootTs`; see `SlackHistory.transcript`. */
  readonly transcript: (
    slackChannelId: string,
    rootTs: string | null,
    limit: number,
    afterTs?: string
  ) => {
    readonly ts: string;
    readonly author: string;
    readonly text: string;
  }[];
  readonly download: (url: string) => Promise<Uint8Array>;
}

/** How a test replaces the network and the clock's work. */
export interface SlackBotOptions {
  readonly fetch?: typeof fetch;
  readonly connectTo?: (url: string) => SocketLike;
}

/**
 * The company's Slack bot, which listens: an admin gives Shadow its bot token (`xoxb-…`) and its app token (`xapp-…`),
 * and Slack sends its events over Socket Mode, so nothing reads Slack on a timer. The public channels become the
 * channels that every member sees, and a channel event makes the bot list them again. Each message event goes into
 * `SlackHistory`, which keeps the channel's day files and its brief. A new connection reads what it missed since the
 * last event, and once a day the bot reads the whole window again, for what an event never brought.
 *
 * @example
 * const bot = new SlackBot(database, secrets, companies, (id) => threads.channelsChanged(id), ports);
 * await bot.connect(companyId, admin, "xoxb-…", "xapp-…");
 * bot.start();
 */
export class SlackBot {
  private readonly api: SlackApi;
  private readonly history: SlackHistory;
  private readonly sockets = new Map<string, SlackSocket>();
  private readonly listening = new Set<string>();
  /** The work of each company, one task after the other, so events keep their order. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly stopping = new AbortController();
  private readonly connectTo: ((url: string) => SocketLike) | undefined;
  private surface: SlackSurfacePort | null = null;

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly companies: BotCompanies,
    /** Called after the channels of a company changed. */
    private readonly changed: (companyId: string) => void,
    ports: SlackHistoryPorts,
    options: SlackBotOptions = {}
  ) {
    this.api = new SlackApi(options.fetch);
    this.history = new SlackHistory(database, this.api, companies, ports);
    this.connectTo = options.connectTo;
  }

  /** Gives the conversations of Slack to the module that talks there. */
  attach(surface: SlackSurfacePort): void {
    this.surface = surface;
  }

  /** The Web API of the company's bot; null without a connected bot. */
  client(companyId: string): SlackClient | null {
    const row = this.row(companyId);
    if (!row) {
      return null;
    }
    const token = this.secrets.decrypt(row.token);
    const { signal } = this.stopping;
    return {
      botUserId: row.bot_user_id,
      call: (method, params) => this.api.call(token, method, params, signal),
      post: (method, body) => this.api.post(token, method, body, signal),
      plain: (text) => this.history.plain(companyId, token, text, signal),
      transcript: (slackChannelId, rootTs, limit, afterTs) =>
        this.history.transcript(
          companyId,
          slackChannelId,
          rootTs,
          limit,
          afterTs
        ),
      download: (url) => this.api.download(token, url, signal),
    };
  }

  status(companyId: string, user: User): SlackBotStatus {
    this.companies.requireAdmin(companyId, user);
    const row = this.row(companyId);
    return {
      connected: row !== null,
      listening: this.listening.has(companyId),
      team: row?.team_name ?? null,
      syncedAt: row?.synced_at ?? null,
      error: row?.error ?? null,
    };
  }

  /**
   * Checks both tokens with Slack, keeps them encrypted, lists the channels at once, and starts to listen; the history
   * of the channels comes in the background.
   */
  async connect(
    companyId: string,
    user: User,
    token: unknown,
    appToken: unknown
  ): Promise<SlackBotStatus> {
    this.companies.requireAdmin(companyId, user);
    const bot = required(token, "Bot token");
    const app = required(appToken, "App token");
    if (!bot.startsWith("xoxb-")) {
      throw new HttpError(400, "Use the bot token of the Slack app (xoxb-…)");
    }
    if (!app.startsWith("xapp-")) {
      throw new HttpError(
        400,
        "Use the app-level token of the Slack app (xapp-…)"
      );
    }
    const team = await this.api
      .call(bot, "auth.test", {})
      .catch((error: unknown) => {
        throw new HttpError(
          400,
          `Slack refused the bot token: ${message(error)}`
        );
      });
    await this.api.openSocket(app).catch((error: unknown) => {
      throw new HttpError(
        400,
        `Slack refused the app token: ${message(error)}`
      );
    });
    this.database
      .query(
        "INSERT INTO slack_bot (company_id, token, app_token, team_id, team_name, bot_user_id, connected_by, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (company_id) DO UPDATE SET token = excluded.token, app_token = excluded.app_token, team_id = excluded.team_id, team_name = excluded.team_name, bot_user_id = excluded.bot_user_id, connected_by = excluded.connected_by, connected_at = excluded.connected_at, synced_at = NULL, listened_at = NULL, checked_at = NULL, error = NULL, deleted_at = NULL"
      )
      .run(
        companyId,
        this.secrets.encrypt(bot),
        this.secrets.encrypt(app),
        String(team.team_id),
        String(team.team),
        team.user_id ? String(team.user_id) : null,
        user.id,
        Date.now()
      );
    await this.listChannels(companyId, bot);
    this.listen(companyId);
    return this.status(companyId, user);
  }

  /** Stops listening; the channels and files that the bot made stay. */
  disconnect(companyId: string, user: User): void {
    this.companies.requireAdmin(companyId, user);
    this.database
      .query(
        "UPDATE slack_bot SET deleted_at = ? WHERE company_id = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), companyId);
    this.sockets.get(companyId)?.close();
    this.sockets.delete(companyId);
    this.listening.delete(companyId);
  }

  /** Listens for every company with a bot, writes changed days every minute, and checks the whole window daily. */
  start(): void {
    for (const companyId of this.companies.ids()) {
      if (this.row(companyId)) {
        this.listen(companyId);
      }
    }
    this.timers.push(
      setInterval(() => {
        for (const companyId of this.sockets.keys()) {
          this.enqueue(companyId, () => this.history.flush(companyId));
        }
      }, SLACK_FLUSH_INTERVAL),
      setInterval(() => {
        for (const companyId of this.sockets.keys()) {
          this.dailyCheck(companyId);
        }
      }, 60 * 60_000)
    );
  }

  async close(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
    this.stopping.abort();
    await Promise.all(this.queues.values());
  }

  /** Waits for the work of a company, then writes its changed days and every brief that waits, quiet or not. */
  async flush(companyId: string): Promise<void> {
    await this.queues.get(companyId);
    await this.history.flush(companyId, Number.POSITIVE_INFINITY);
  }

  /** Opens the company's Socket Mode connection, which connects again by itself until the bot is disconnected. */
  private listen(companyId: string): void {
    const row = this.row(companyId);
    if (!row?.app_token || this.sockets.has(companyId)) {
      return;
    }
    const appToken = this.secrets.decrypt(row.app_token);
    const socket = new SlackSocket(
      () => this.api.openSocket(appToken),
      {
        hello: () => {
          this.listening.add(companyId);
          this.catchUp(companyId);
        },
        event: (event) => this.event(companyId, event),
        interaction: (payload) => this.surface?.interaction(companyId, payload),
        lost: (error) => {
          this.listening.delete(companyId);
          this.fail(companyId, error);
        },
      },
      this.connectTo
    );
    this.sockets.set(companyId, socket);
    socket.start();
  }

  /**
   * A new connection: the list of channels, then what the channels got since the last event before it. The time is
   * read now, before the events of this connection move it on.
   */
  private catchUp(companyId: string): void {
    const listened = this.row(companyId)?.listened_at ?? null;
    const since = listened === null ? null : listened - CATCH_UP_OVERLAP_MS;
    this.enqueue(companyId, async (token) => {
      await this.readWorkspace(companyId, token);
      await this.listChannels(companyId, token);
      await this.history.catchUp(companyId, token, since, this.stopping.signal);
      await this.history.flush(companyId);
      this.heard(companyId);
      if (since === null) {
        // A reading of the whole window is the daily check of today.
        this.checked(companyId);
      } else {
        this.dailyCheck(companyId);
      }
    });
  }

  /**
   * Reads the address of the workspace at each connection, as an admin can rename it. A new address writes every day
   * file again, for the links of its messages.
   */
  private async readWorkspace(companyId: string, token: string): Promise<void> {
    const { url } = await this.api.call(
      token,
      "auth.test",
      {},
      this.stopping.signal
    );
    if (typeof url !== "string") {
      return;
    }
    const { changes } = this.database
      .query(
        "UPDATE slack_bot SET team_url = ? WHERE company_id = ? AND deleted_at IS NULL AND team_url IS NOT ?"
      )
      .run(url, companyId, url);
    if (changes) {
      this.database
        .query("UPDATE slack_day SET dirty = 1 WHERE company_id = ?")
        .run(companyId);
    }
  }

  private event(companyId: string, event: { readonly type: string }): void {
    this.heard(companyId);
    if (CHANNEL_EVENTS.has(event.type)) {
      // A new channel gets its history at once; the others have nothing to read from now.
      this.enqueue(companyId, async (token) => {
        await this.listChannels(companyId, token);
        await this.history.catchUp(
          companyId,
          token,
          Date.now(),
          this.stopping.signal
        );
      });
    } else if (event.type === "message") {
      this.enqueue(companyId, (token) =>
        this.history.event(
          companyId,
          token,
          event as SlackMessageEvent,
          this.stopping.signal
        )
      );
    }
    // After the mirror kept a message, the module that talks in Slack sees it, and the other conversation events.
    if (this.surface && !CHANNEL_EVENTS.has(event.type)) {
      const { surface } = this;
      this.enqueue(companyId, () =>
        surface.event(companyId, event as Record<string, unknown>)
      );
    }
  }

  /** Reads the whole window of every channel again once a day, for an event that never came. */
  private dailyCheck(companyId: string): void {
    const row = this.row(companyId);
    if (!row || (row.checked_at ?? 0) > Date.now() - DAILY_CHECK_MS) {
      return;
    }
    this.checked(companyId);
    this.enqueue(companyId, async (token) => {
      await this.listChannels(companyId, token);
      await this.history.catchUp(companyId, token, null, this.stopping.signal);
    });
  }

  /** Runs `task` after the company's earlier work, with its bot token; a failure goes to the status. */
  private enqueue(
    companyId: string,
    task: (token: string) => Promise<void>
  ): void {
    const previous = this.queues.get(companyId) ?? Promise.resolve();
    this.queues.set(
      companyId,
      previous.then(async () => {
        const row = this.row(companyId);
        if (!row || this.stopping.signal.aborted) {
          return;
        }
        try {
          await task(this.secrets.decrypt(row.token));
          this.database
            .query("UPDATE slack_bot SET error = NULL WHERE company_id = ?")
            .run(companyId);
        } catch (error) {
          this.fail(companyId, error);
        }
      })
    );
  }

  /** Copies the public channels of Slack into the company. */
  private async listChannels(companyId: string, token: string): Promise<void> {
    const counts = this.companies.syncSlackChannels(
      companyId,
      await this.publicChannels(token)
    );
    if (Object.values(counts).some((count) => count > 0)) {
      this.changed(companyId);
    }
  }

  /** Every public channel that Slack has not archived, page by page. */
  private async publicChannels(token: string): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor = "";
    do {
      const page = await this.api.call(token, "conversations.list", {
        types: "public_channel",
        exclude_archived: "true",
        limit: "1000",
        cursor,
      });
      for (const channel of page.channels as SlackApiChannel[]) {
        channels.push({
          id: channel.id,
          name: channel.name,
          purpose: channel.purpose?.value ?? "",
          general: channel.is_general === true,
        });
      }
      cursor =
        (page.response_metadata as { next_cursor?: string } | undefined)
          ?.next_cursor ?? "";
    } while (cursor);
    return channels;
  }

  private checked(companyId: string): void {
    this.database
      .query("UPDATE slack_bot SET checked_at = ? WHERE company_id = ?")
      .run(Date.now(), companyId);
  }

  /** Notes that Shadow heard from Slack now: a new connection reads from about here. */
  private heard(companyId: string): void {
    const now = Date.now();
    this.database
      .query(
        "UPDATE slack_bot SET listened_at = ?, synced_at = ? WHERE company_id = ?"
      )
      .run(now, now, companyId);
  }

  private fail(companyId: string, error: unknown): void {
    if (!this.stopping.signal.aborted) {
      this.database
        .query("UPDATE slack_bot SET error = ? WHERE company_id = ?")
        .run(message(error), companyId);
    }
  }

  private row(companyId: string): BotRow | null {
    return this.database
      .query(
        "SELECT token, app_token, bot_user_id, team_name, synced_at, listened_at, checked_at, error FROM slack_bot WHERE company_id = ? AND deleted_at IS NULL"
      )
      .get(companyId) as BotRow | null;
  }
}

interface SlackApiChannel {
  id: string;
  name: string;
  is_general?: boolean;
  purpose?: { value?: string };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
