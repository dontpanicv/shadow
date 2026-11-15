import type { Database } from "bun:sqlite";
import type { Companies, SlackChannel } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, required } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import { SlackApi } from "./slack-api.ts";
import { SlackHistory, type SlackHistoryPorts } from "./slack-history.ts";

/** How often the bot lists the public channels of Slack. */
export const SLACK_SYNC_INTERVAL = 5 * 60_000;
/** How often the bot copies what happened in the channels into their files. */
export const SLACK_HISTORY_INTERVAL = 15 * 60_000;

/** The Slack bot of a company, for its admins; the token never leaves the server. */
export interface SlackBotStatus {
  readonly connected: boolean;
  /** The Slack workspace of the bot, such as "Acme". */
  readonly team: string | null;
  /** When the last sync ended, in ms since the epoch; null before the first. */
  readonly syncedAt: number | null;
  /** Why the last sync failed; null when it worked. */
  readonly error: string | null;
}

type BotCompanies = Pick<
  Companies,
  "requireAdmin" | "ids" | "syncSlackChannels" | "channelsIn"
>;

interface BotRow {
  token: Uint8Array;
  team_name: string;
  synced_at: number | null;
  error: string | null;
}

/**
 * The company's Slack bot. An admin gives Shadow its bot token (`xoxb-…`), and every 5 minutes the bot lists the
 * public channels of Slack, which the channels that every member sees then copy. A new channel gets the last
 * 30 days of its Slack channel at once, and every 15 minutes each channel gets what happened since,
 * in its files and its brief (`SlackHistory`). The people's own Slack accounts stay in the Slack integration.
 *
 * @example
 * const bot = new SlackBot(database, secrets, companies, (id) => threads.channelsChanged(id), ports);
 * await bot.connect(companyId, admin, "xoxb-…");
 * bot.start();
 */
export class SlackBot {
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private running: Promise<void> = Promise.resolve();
  private readonly stopping = new AbortController();
  private readonly api: SlackApi;
  private readonly history: SlackHistory;

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly companies: BotCompanies,
    /** Called after a sync changed the channels of a company. */
    private readonly changed: (companyId: string) => void,
    ports: SlackHistoryPorts,
    fetchSlack: typeof fetch = fetch
  ) {
    this.api = new SlackApi(fetchSlack);
    this.history = new SlackHistory(database, this.api, companies, ports);
  }

  status(companyId: string, user: User): SlackBotStatus {
    this.companies.requireAdmin(companyId, user);
    const row = this.row(companyId);
    return {
      connected: row !== null,
      team: row?.team_name ?? null,
      syncedAt: row?.synced_at ?? null,
      error: row?.error ?? null,
    };
  }

  /** Checks the token with Slack, keeps it encrypted, and syncs the channels at once. */
  async connect(
    companyId: string,
    user: User,
    token: unknown
  ): Promise<SlackBotStatus> {
    this.companies.requireAdmin(companyId, user);
    const trimmed = required(token, "Bot token");
    if (!trimmed.startsWith("xoxb-")) {
      throw new HttpError(400, "Use the bot token of the Slack app (xoxb-…)");
    }
    const team = await this.api
      .call(trimmed, "auth.test", {})
      .catch((error: unknown) => {
        throw new HttpError(400, `Slack refused the token: ${message(error)}`);
      });
    this.database
      .query(
        "INSERT INTO slack_bot (company_id, token, team_id, team_name, connected_by, connected_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (company_id) DO UPDATE SET token = excluded.token, team_id = excluded.team_id, team_name = excluded.team_name, connected_by = excluded.connected_by, connected_at = excluded.connected_at, synced_at = NULL, error = NULL, deleted_at = NULL"
      )
      .run(
        companyId,
        this.secrets.encrypt(trimmed),
        String(team.team_id),
        String(team.team),
        user.id,
        Date.now()
      );
    await this.sync(companyId);
    return this.status(companyId, user);
  }

  /** Stops the sync; the channels it made stay. */
  disconnect(companyId: string, user: User): void {
    this.companies.requireAdmin(companyId, user);
    this.database
      .query(
        "UPDATE slack_bot SET deleted_at = ? WHERE company_id = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), companyId);
  }

  start(): void {
    this.timers.push(
      setInterval(() => this.syncAll(false), SLACK_SYNC_INTERVAL),
      setInterval(() => this.syncAll(true), SLACK_HISTORY_INTERVAL)
    );
    this.syncAll(true);
  }

  async close(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.stopping.abort();
    await this.running;
  }

  /**
   * Copies the public channels of Slack into the company, then the history of each channel that never got it, or of
   * every channel with `history`. A failure stays in the status until a sync works.
   */
  async sync(companyId: string, history = false): Promise<void> {
    const row = this.row(companyId);
    if (!row) {
      return;
    }
    const { signal } = this.stopping;
    try {
      const token = this.secrets.decrypt(row.token);
      const counts = this.companies.syncSlackChannels(
        companyId,
        await this.publicChannels(token)
      );
      if (Object.values(counts).some((count) => count > 0)) {
        this.changed(companyId);
      }
      await this.history.sync(companyId, token, !history, signal);
      this.database
        .query(
          "UPDATE slack_bot SET synced_at = ?, error = NULL WHERE company_id = ?"
        )
        .run(Date.now(), companyId);
    } catch (error) {
      if (!signal.aborted) {
        this.database
          .query("UPDATE slack_bot SET error = ? WHERE company_id = ?")
          .run(message(error), companyId);
      }
    }
  }

  private syncAll(history: boolean): void {
    // One failed round must not stop the rounds after it.
    this.running = this.running
      .then(async () => {
        for (const companyId of this.companies.ids()) {
          await this.sync(companyId, history);
        }
      })
      .catch((error: unknown) => console.error("Syncing Slack failed", error));
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

  private row(companyId: string): BotRow | null {
    return this.database
      .query(
        "SELECT token, team_name, synced_at, error FROM slack_bot WHERE company_id = ? AND deleted_at IS NULL"
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
