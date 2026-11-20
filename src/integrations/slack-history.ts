import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Channel, Companies } from "../companies/companies.ts";
import type { WatchedItem } from "./integrations.ts";
import type { SlackApi } from "./slack-api.ts";
import {
  type SlackUser,
  slackClock,
  slackDay,
  slackMarkdown,
  slackMentions,
  slackPermalink,
  slackPersonName,
} from "./slack-text.ts";

/** How far back the history of a Slack channel reaches when Shadow first reads it, and the daily check reads again. */
export const SLACK_HISTORY_DAYS = 30;
/** How long a channel is quiet before its brief reads its new messages: one brief for each burst of conversation. */
export const SLACK_BRIEF_QUIET_MS = 10 * 60_000;
/**
 * The most text, in UTF-16 code units, that one brief reads; the newest messages come first. A busy channel, such as
 * one of alerts, can have millions of characters in 30 days. The older ones stay in the day files, which search finds.
 */
export const SLACK_BRIEF_TEXT = 180_000;
/** The largest attachment that Shadow keeps; a larger one stays a name with a link to Slack. */
const LARGEST_FILE = 50 * 1024 * 1024;
/** Messages that say only who came or left. */
const SKIPPED = new Set(["channel_join", "channel_leave"]);

/** A message of a Slack channel, for the brief of its channel, with the day file that keeps it. */
export interface SlackHistoryMessage {
  readonly file: { readonly id: string; readonly name: string };
  readonly author: string;
  readonly text: string;
  readonly time: number;
}

/** What the mirror needs of the channels' files and briefs, which another module keeps. */
export interface SlackHistoryPorts {
  /** Saves a file in a channel; `replaces` keeps the id of the file it replaces. */
  writeFile: (
    companyId: string,
    channelId: string,
    file: File,
    replaces?: string
  ) => Promise<{ readonly id: string; readonly name: string }>;
  /** Moves a file of the company aside, as every delete does. */
  deleteFile: (companyId: string, fileId: string) => Promise<void>;
  /** Writes the brief of a channel again from new messages of its Slack channel. */
  brief: (
    companyId: string,
    channelId: string,
    messages: readonly SlackHistoryMessage[]
  ) => Promise<void>;
}

/** The reactions that Shadow keeps: a person's :ledger: makes the message a row of their ledger. */
const KEPT_REACTIONS = new Set(["ledger"]);

/** A reaction event of the Slack Events API: reaction_added or reaction_removed. */
export interface SlackReactionEvent {
  readonly type: "reaction_added" | "reaction_removed";
  readonly user: string;
  readonly reaction: string;
  readonly item: {
    readonly type: string;
    readonly channel?: string;
    readonly ts?: string;
  };
  readonly event_ts: string;
}

/** A kept reaction of one Slack user, with its message. */
export interface SlackReaction {
  readonly permalink: string;
  readonly text: string;
  readonly author: string;
  readonly at: number;
  readonly removed: boolean;
}

/** A message event of the Slack Events API, as Socket Mode gives it. */
export interface SlackMessageEvent {
  readonly type: "message";
  readonly channel: string;
  readonly subtype?: string;
  readonly ts?: string;
  readonly deleted_ts?: string;
  readonly message?: SlackMessage;
  readonly previous_message?: SlackMessage;
}

interface SlackMessage {
  ts: string;
  thread_ts?: string;
  subtype?: string;
  user?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  user_profile?: { real_name?: string; display_name?: string };
  bot_profile?: { name?: string };
  files?: SlackFile[];
}
interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  size?: number;
  url_private_download?: string;
  permalink?: string;
}
interface StoredMessage {
  ts: string;
  thread_ts: string | null;
  author: string;
  text: string;
  files: string;
  day: string;
}
type Kept = { id: string; name: string } | { name: string; link: string };
type SlackChannelOf = Channel & { slackId: string };

/**
 * The history of the public Slack channels in their channels' files. Slack's events bring each new message, reply,
 * edit, delete, and attachment as it happens (`event`); a channel that Shadow has not read yet gets its last
 * `SLACK_HISTORY_DAYS` days at once, and a gap, such as a restart, is read from the time it began (`catchUp`). The
 * messages stay in `slack_message`, and each change marks its day in `slack_day` to write again, so nothing waits only
 * in memory. `flush` writes each marked day as one Markdown file, `slack-YYYY-MM-DD.md`, with the replies of a thread
 * under the message that started it and each attachment a file of the channel that its message links, and gives the
 * brief of a quiet channel the messages that it has not read.
 */
export class SlackHistory {
  /** The Slack channels that a reading keeps now, by company: a flush leaves them until the reading is done. */
  private readonly reading = new Set<string>();

  constructor(
    private readonly database: Database,
    private readonly api: SlackApi,
    private readonly companies: Pick<Companies, "channelsIn">,
    private readonly ports: SlackHistoryPorts
  ) {}

  /**
   * Reads what Slack has that the events may have missed: the last `SLACK_HISTORY_DAYS` days of each channel that
   * Shadow has not read yet, and of the others the messages from `since`, in ms, or the whole window without it.
   */
  async catchUp(
    companyId: string,
    token: string,
    since: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    const read = new Set(
      (
        this.database
          .query(
            "SELECT slack_channel_id AS id FROM slack_history WHERE company_id = ?"
          )
          .all(companyId) as { id: string }[]
      ).map((row) => row.id)
    );
    const window = Date.now() - SLACK_HISTORY_DAYS * 86_400_000;
    for (const channel of this.slackChannels(companyId)) {
      if (signal?.aborted) {
        return;
      }
      const from =
        read.has(channel.slackId) && since !== null
          ? Math.max(since, window)
          : window;
      await this.read(companyId, channel, token, from, signal);
    }
  }

  /**
   * The Slack channels where the person with this Slack name wrote, or where a message mentions them.
   * shortcut: the kept messages hold names, not user IDs, so two people with one name share their channels; keep the
   * user IDs of messages when that happens.
   */
  involved(companyId: string, name: string): string[] {
    return (
      this.database
        .query(
          "SELECT DISTINCT slack_channel_id AS id FROM slack_message WHERE company_id = ? AND deleted_at IS NULL AND (author = ? OR instr(text, ?) > 0)"
        )
        .all(companyId, name, `@${name}`) as { id: string }[]
    ).map((row) => row.id);
  }

  /** The Slack channels whose messages name an issue key, such as Linear's `PIP-1040`, in any case. */
  mentioning(companyId: string, key: string): string[] {
    const upper = key.toUpperCase();
    if (!/^[A-Z0-9]+-\d+$/.test(upper)) {
      return [];
    }
    // A key is whole: `PIP-104` is not in `PIP-1040`.
    const whole = new RegExp(`(^|[^A-Z0-9])${upper}($|[^0-9])`);
    const rows = this.database
      .query(
        "SELECT slack_channel_id AS id, upper(text) AS text FROM slack_message WHERE company_id = ? AND deleted_at IS NULL AND instr(upper(text), ?) > 0"
      )
      .all(companyId, upper) as { id: string; text: string }[];
    return [
      ...new Set(
        rows.filter((row) => whole.test(row.text)).map((row) => row.id)
      ),
    ];
  }

  /**
   * The messages since `since`, in ms, of these Slack channels that concern the person with this Slack name: what
   * they wrote, what mentions them, and the replies in threads where they wrote or someone mentioned them in the last
   * `SLACK_HISTORY_DAYS` days. Intake reads them for the person, as `Connector.watch` gives an account's messages.
   * shortcut: by name, as `involved` is; keep the user IDs of messages when two people share a name.
   */
  watched(
    companyId: string,
    channels: readonly { readonly slackId: string; readonly name: string }[],
    name: string,
    since: number
  ): WatchedItem[] {
    const names = new Map(
      channels.map((channel) => [channel.slackId, channel.name])
    );
    const mention = `@${name}`;
    const rows = this.database
      .query(
        `WITH personal AS (
          SELECT slack_channel_id, coalesce(thread_ts, ts) AS root FROM slack_message
          WHERE company_id = ?1 AND slack_channel_id IN (SELECT value FROM json_each(?2)) AND deleted_at IS NULL
            AND CAST(ts AS REAL) >= ?3 AND (author = ?4 OR instr(text, ?5) > 0)
        )
        SELECT m.slack_channel_id AS channel, m.ts, m.thread_ts, m.author, m.text, m.files FROM slack_message m
        WHERE m.company_id = ?1 AND m.slack_channel_id IN (SELECT value FROM json_each(?2)) AND m.deleted_at IS NULL
          AND CAST(m.ts AS REAL) >= ?6
          AND (m.author = ?4 OR instr(m.text, ?5) > 0 OR EXISTS (SELECT 1 FROM personal p
            WHERE p.slack_channel_id = m.slack_channel_id AND p.root = coalesce(m.thread_ts, m.ts)))
        ORDER BY CAST(m.ts AS REAL)`
      )
      .all(
        companyId,
        JSON.stringify([...names.keys()]),
        (Date.now() - SLACK_HISTORY_DAYS * 86_400_000) / 1000,
        name,
        mention,
        since / 1000
      ) as (StoredMessage & { channel: string })[];
    const workspaceUrl = this.workspaceUrl(companyId);
    return rows.flatMap((row) => {
      const files = (JSON.parse(row.files) as Kept[]).map((file) => file.name);
      const text = [
        row.text.replaceAll(mention, "@me"),
        ...(files.length > 0 ? [`Attachments: ${files.join(", ")}`] : []),
      ]
        .join("\n")
        .trim();
      if (!text) {
        return [];
      }
      const own = row.author === name;
      return {
        id: `${row.channel}/${row.ts}`,
        kind: "message" as const,
        chat: `${row.channel}/${row.thread_ts ?? row.ts}`,
        chatName: `#${names.get(row.channel)}`,
        group: true,
        sender: own ? "" : row.author,
        fromOwner: own,
        at: Math.floor(Number(row.ts) * 1000),
        text,
        url:
          workspaceUrl &&
          slackPermalink(workspaceUrl, row.channel, row.ts, row.thread_ts),
      };
    });
  }

  /** Keeps what one message event changed: a new message or reply, an edit, or a delete. */
  async event(
    companyId: string,
    token: string,
    event: SlackMessageEvent,
    signal?: AbortSignal
  ): Promise<void> {
    const channel = this.slackChannels(companyId).find(
      (candidate) => candidate.slackId === event.channel
    );
    if (!channel || SKIPPED.has(event.subtype ?? "")) {
      return;
    }
    if (event.subtype === "message_deleted" && event.deleted_ts) {
      this.remove(companyId, channel.slackId, event.deleted_ts);
      return;
    }
    const message =
      event.subtype === "message_changed"
        ? event.message
        : (event as unknown as SlackMessage);
    if (message?.ts && !SKIPPED.has(message.subtype ?? "")) {
      await this.keep(companyId, channel, token, message, signal);
    }
  }

  /** Keeps a kept reaction on a message of a channel that Shadow copies, or when it was taken away. */
  reaction(companyId: string, event: SlackReactionEvent): void {
    const { channel } = event.item;
    if (
      !(
        KEPT_REACTIONS.has(event.reaction) &&
        event.item.type === "message" &&
        channel &&
        event.item.ts &&
        this.slackChannels(companyId).some(
          (candidate) => candidate.slackId === channel
        )
      )
    ) {
      return;
    }
    const at = Math.floor(Number(event.event_ts) * 1000);
    this.database
      .query(
        event.type === "reaction_added"
          ? "INSERT INTO slack_reaction (company_id, slack_channel_id, ts, user_id, name, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at, removed_at = NULL"
          : "UPDATE slack_reaction SET removed_at = ?6 WHERE company_id = ?1 AND slack_channel_id = ?2 AND ts = ?3 AND user_id = ?4 AND name = ?5"
      )
      .run(companyId, channel, event.item.ts, event.user, event.reaction, at);
  }

  /** The reactions `name` of one Slack user on the kept messages of `channels`, also the ones taken away. */
  reactions(
    companyId: string,
    userId: string,
    name: string,
    channels: readonly string[]
  ): SlackReaction[] {
    const workspaceUrl = this.workspaceUrl(companyId);
    if (!workspaceUrl) {
      return [];
    }
    const rows = this.database
      .query(
        `SELECT r.slack_channel_id AS channel, r.ts, r.at, r.removed_at AS removedAt, m.thread_ts AS threadTs, m.author, m.text
        FROM slack_reaction r JOIN slack_message m ON m.company_id = r.company_id AND m.slack_channel_id = r.slack_channel_id AND m.ts = r.ts
        WHERE r.company_id = ? AND r.user_id = ? AND r.name = ? AND m.deleted_at IS NULL
          AND r.slack_channel_id IN (SELECT value FROM json_each(?))
        ORDER BY r.at`
      )
      .all(companyId, userId, name, JSON.stringify(channels)) as {
      channel: string;
      ts: string;
      at: number;
      removedAt: number | null;
      threadTs: string | null;
      author: string;
      text: string;
    }[];
    return rows.map((row) => ({
      permalink: slackPermalink(
        workspaceUrl,
        row.channel,
        row.ts,
        row.threadTs
      ),
      text: row.text,
      author: row.author,
      at: row.at,
      removed: row.removedAt !== null,
    }));
  }

  /** Writes each day that changed, then gives the briefs what they have not read, as `writeDays` and `brief` do. */
  async flush(companyId: string, now = Date.now()): Promise<void> {
    await this.writeChangedDays(companyId);
    await this.brief(companyId, now);
  }

  /** Writes each day that changed; a channel that a reading keeps now waits for it. Runs one at a time. */
  writeChangedDays(companyId: string): Promise<void> {
    return this.eachChannel(companyId, (channel) =>
      this.writeDays(companyId, channel)
    );
  }

  /**
   * Gives each channel quiet for `SLACK_BRIEF_QUIET_MS`, or every channel with `now` past them all, the messages that
   * its brief has not read. It waits for the model, so it runs beside `writeChangedDays`, one at a time.
   */
  brief(companyId: string, now = Date.now()): Promise<void> {
    return this.eachChannel(companyId, (channel) =>
      this.briefWhenQuiet(companyId, channel, now)
    );
  }

  /** Runs `step` for each channel that no reading keeps now; a channel that fails leaves the others to go on. */
  private async eachChannel(
    companyId: string,
    step: (channel: SlackChannelOf) => Promise<void>
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const channel of this.slackChannels(companyId)) {
      if (!this.reading.has(`${companyId}:${channel.slackId}`)) {
        await step(channel).catch((error: unknown) => failures.push(error));
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  private async writeDays(
    companyId: string,
    channel: SlackChannelOf
  ): Promise<void> {
    const days = this.database
      .query(
        "SELECT day FROM slack_day WHERE company_id = ? AND slack_channel_id = ? AND dirty = 1"
      )
      .all(companyId, channel.slackId) as { day: string }[];
    for (const { day } of days) {
      await this.writeDay(companyId, channel, day);
    }
  }

  /**
   * The kept messages of a Slack thread, its first message and its replies, or with a null `rootTs` the newest
   * messages of the channel that started no thread, oldest first: at most `limit`, and only after `afterTs`.
   */
  transcript(
    companyId: string,
    slackChannelId: string,
    rootTs: string | null,
    limit: number,
    afterTs = "0"
  ): { readonly ts: string; readonly author: string; readonly text: string }[] {
    const rows = (
      rootTs
        ? this.database
            .query(
              "SELECT ts, author, text FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND (ts = ? OR thread_ts = ?) AND deleted_at IS NULL AND CAST(ts AS REAL) > CAST(? AS REAL) ORDER BY CAST(ts AS REAL) DESC LIMIT ?"
            )
            .all(companyId, slackChannelId, rootTs, rootTs, afterTs, limit)
        : this.database
            .query(
              "SELECT ts, author, text FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND thread_ts IS NULL AND deleted_at IS NULL AND CAST(ts AS REAL) > CAST(? AS REAL) ORDER BY CAST(ts AS REAL) DESC LIMIT ?"
            )
            .all(companyId, slackChannelId, afterTs, limit)
    ) as { ts: string; author: string; text: string }[];
    return rows.reverse();
  }

  private slackChannels(companyId: string): SlackChannelOf[] {
    return this.companies
      .channelsIn(companyId, null)
      .filter((channel): channel is SlackChannelOf => channel.slackId !== null);
  }

  /** Keeps the messages of a channel from `from`, in ms, with their threads, and marks what Slack deleted since. */
  private async read(
    companyId: string,
    channel: SlackChannelOf,
    token: string,
    from: number,
    signal?: AbortSignal
  ): Promise<void> {
    const call = (method: string, params: Record<string, string>) =>
      this.api.call(
        token,
        method,
        { channel: channel.slackId, ...params },
        signal
      );
    const oldest = String(from / 1000);
    const key = `${companyId}:${channel.slackId}`;
    this.reading.add(key);
    try {
      await this.readFrom(companyId, channel, token, call, oldest, signal);
    } finally {
      this.reading.delete(key);
    }
    this.database
      .query(
        "INSERT INTO slack_history (company_id, slack_channel_id, synced_at) VALUES (?, ?, ?) ON CONFLICT (company_id, slack_channel_id) DO UPDATE SET synced_at = excluded.synced_at"
      )
      .run(companyId, channel.slackId, Date.now());
  }

  private async readFrom(
    companyId: string,
    channel: SlackChannelOf,
    token: string,
    call: (
      method: string,
      params: Record<string, string>
    ) => Promise<Record<string, unknown>>,
    oldest: string,
    signal?: AbortSignal
  ): Promise<void> {
    // An event can keep a message after Slack listed the channel; only an older one that Slack did not list is gone.
    const listed = Date.now() / 1000;
    const seen = new Set<string>();
    for (const message of await this.history(call, oldest)) {
      // A reply also sent to the channel comes with its thread.
      if (
        SKIPPED.has(message.subtype ?? "") ||
        (message.thread_ts && message.thread_ts !== message.ts)
      ) {
        continue;
      }
      seen.add(message.ts);
      const before = this.stored(companyId, channel.slackId, message.ts);
      await this.keep(companyId, channel, token, message, signal);
      if (
        (message.reply_count ?? 0) > 0 &&
        (!before ||
          (message.latest_reply ?? "") >
            this.latestReply(companyId, channel.slackId, message.ts))
      ) {
        await this.replies(call, companyId, channel, token, message, signal);
      }
    }
    // A message of the window that Slack no longer lists was deleted there.
    for (const gone of this.storedSince(companyId, channel.slackId, oldest)) {
      if (!seen.has(gone.ts) && Number(gone.ts) < listed) {
        this.remove(companyId, channel.slackId, gone.ts);
      }
    }
  }

  /** The messages from `oldest`, newest first, page by page; the bot joins a channel that it is not in yet. */
  private async history(
    call: (
      method: string,
      params: Record<string, string>
    ) => Promise<Record<string, unknown>>,
    oldest: string
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor = "";
    let joined = false;
    do {
      const page = await call("conversations.history", {
        oldest,
        limit: "200",
        cursor,
      }).catch(async (error: unknown) => {
        if (joined || !String(error).includes("not_in_channel")) {
          throw error;
        }
        joined = true;
        await call("conversations.join", {});
        return call("conversations.history", { oldest, limit: "200", cursor });
      });
      messages.push(...(page.messages as SlackMessage[]));
      cursor = nextCursor(page);
    } while (cursor);
    return messages;
  }

  /** Every reply of a thread; Slack's reply list is whole, so a stored reply it no longer has was deleted. */
  private async replies(
    call: (
      method: string,
      params: Record<string, string>
    ) => Promise<Record<string, unknown>>,
    companyId: string,
    channel: SlackChannelOf,
    token: string,
    parent: SlackMessage,
    signal?: AbortSignal
  ): Promise<void> {
    const listed = Date.now() / 1000;
    const seen = new Set<string>();
    let cursor = "";
    do {
      const page = await call("conversations.replies", {
        ts: parent.ts,
        limit: "200",
        cursor,
      });
      for (const reply of page.messages as SlackMessage[]) {
        if (reply.ts !== parent.ts) {
          seen.add(reply.ts);
          await this.keep(companyId, channel, token, reply, signal);
        }
      }
      cursor = nextCursor(page);
    } while (cursor);
    const stored = this.database
      .query(
        "SELECT ts FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND thread_ts = ? AND deleted_at IS NULL"
      )
      .all(companyId, channel.slackId, parent.ts) as { ts: string }[];
    for (const { ts } of stored) {
      if (!seen.has(ts) && Number(ts) < listed) {
        this.remove(companyId, channel.slackId, ts);
      }
    }
  }

  /**
   * Stores a new or changed message with its attachments, and marks its day to write again. A reply belongs to the day
   * of the message that started its thread.
   */
  private async keep(
    companyId: string,
    channel: SlackChannelOf,
    token: string,
    message: SlackMessage,
    signal?: AbortSignal
  ): Promise<void> {
    const author = await this.author(companyId, token, message, signal);
    const text = await this.plain(companyId, token, message.text ?? "", signal);
    const files: Kept[] = [];
    for (const file of message.files ?? []) {
      files.push(
        await this.attachment(companyId, channel.id, token, file, signal)
      );
    }
    const thread =
      message.thread_ts && message.thread_ts !== message.ts
        ? message.thread_ts
        : null;
    const day = slackDay(thread ?? message.ts);
    const before = this.stored(companyId, channel.slackId, message.ts);
    const filesJson = JSON.stringify(files);
    if (
      before &&
      before.author === author &&
      before.text === text &&
      before.files === filesJson
    ) {
      return;
    }
    this.database.transaction(() => {
      this.database
        .query(
          "INSERT INTO slack_message (company_id, slack_channel_id, ts, thread_ts, author, text, files, day, briefed, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL) ON CONFLICT (company_id, slack_channel_id, ts) DO UPDATE SET thread_ts = excluded.thread_ts, author = excluded.author, text = excluded.text, files = excluded.files, day = excluded.day, briefed = 0, deleted_at = NULL"
        )
        .run(
          companyId,
          channel.slackId,
          message.ts,
          thread,
          author,
          text,
          filesJson,
          day
        );
      this.markDay(companyId, channel.slackId, day);
    })();
  }

  /** Marks a message deleted, with the replies of a thread it started, and its day to write again. */
  private remove(companyId: string, slackChannelId: string, ts: string): void {
    const days = this.database
      .query(
        "UPDATE slack_message SET deleted_at = ? WHERE company_id = ? AND slack_channel_id = ? AND (ts = ? OR thread_ts = ?) AND deleted_at IS NULL RETURNING day"
      )
      .all(Date.now(), companyId, slackChannelId, ts, ts) as { day: string }[];
    for (const { day } of days) {
      this.markDay(companyId, slackChannelId, day);
    }
  }

  private markDay(
    companyId: string,
    slackChannelId: string,
    day: string
  ): void {
    this.database
      .query(
        "INSERT INTO slack_day (company_id, slack_channel_id, day, file_id, content_hash, dirty) VALUES (?, ?, ?, NULL, '', 1) ON CONFLICT (company_id, slack_channel_id, day) DO UPDATE SET dirty = 1"
      )
      .run(companyId, slackChannelId, day);
  }

  /** An attachment as a file of the channel, downloaded once; a large or hidden one stays a link to Slack. */
  private async attachment(
    companyId: string,
    channelId: string,
    token: string,
    file: SlackFile,
    signal?: AbortSignal
  ): Promise<Kept> {
    const name = file.name ?? file.title ?? file.id;
    const saved = this.database
      .query(
        "SELECT file_id AS id, name FROM slack_file WHERE company_id = ? AND slack_file_id = ?"
      )
      .get(companyId, file.id) as { id: string; name: string } | null;
    if (saved) {
      return saved;
    }
    if (!file.url_private_download || (file.size ?? 0) > LARGEST_FILE) {
      return { name, link: file.permalink ?? "" };
    }
    const bytes = await this.api.download(
      token,
      file.url_private_download,
      signal
    );
    const kept = await this.ports.writeFile(
      companyId,
      channelId,
      new File([bytes], name)
    );
    this.database
      .query(
        "INSERT INTO slack_file (company_id, slack_file_id, file_id, name) VALUES (?, ?, ?, ?)"
      )
      .run(companyId, file.id, kept.id, kept.name);
    return { id: kept.id, name: kept.name };
  }

  /** Writes the Markdown file of one day of a channel when its text changed, or deletes it when no message is left. */
  private async writeDay(
    companyId: string,
    channel: SlackChannelOf,
    day: string
  ): Promise<void> {
    // The day is taken before it is read, so an event that marks it again while the file is written is not lost.
    this.database
      .query(
        "UPDATE slack_day SET dirty = 0 WHERE company_id = ? AND slack_channel_id = ? AND day = ?"
      )
      .run(companyId, channel.slackId, day);
    try {
      await this.writeTakenDay(companyId, channel, day);
    } catch (error) {
      this.markDay(companyId, channel.slackId, day);
      throw error;
    }
  }

  private async writeTakenDay(
    companyId: string,
    channel: SlackChannelOf,
    day: string
  ): Promise<void> {
    const messages = this.database
      .query(
        "SELECT ts, thread_ts, author, text, files, day FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND day = ? AND deleted_at IS NULL ORDER BY CAST(ts AS REAL)"
      )
      .all(companyId, channel.slackId, day) as StoredMessage[];
    const before = this.database
      .query(
        "SELECT file_id AS fileId, content_hash AS hash FROM slack_day WHERE company_id = ? AND slack_channel_id = ? AND day = ?"
      )
      .get(companyId, channel.slackId, day) as {
      fileId: string | null;
      hash: string;
    } | null;
    let fileId = before?.fileId ?? null;
    let hash = before?.hash ?? "";
    if (messages.length === 0) {
      if (fileId) {
        await this.ports.deleteFile(companyId, fileId);
      }
      fileId = null;
      hash = "";
    } else {
      const text = dayText(
        channel,
        day,
        messages,
        this.workspaceUrl(companyId)
      );
      const next = createHash("sha256").update(text).digest("hex");
      if (!(fileId && hash === next)) {
        fileId = (
          await this.ports.writeFile(
            companyId,
            channel.id,
            new File([text], `slack-${day}.md`, { type: "text/markdown" }),
            fileId ?? undefined
          )
        ).id;
        hash = next;
      }
    }
    this.database
      .query(
        "UPDATE slack_day SET file_id = ?, content_hash = ? WHERE company_id = ? AND slack_channel_id = ? AND day = ?"
      )
      .run(fileId, hash, companyId, channel.slackId, day);
  }

  /** Gives the brief of a quiet channel the messages that it has not read, each with the link of its day file. */
  private async briefWhenQuiet(
    companyId: string,
    channel: SlackChannelOf,
    now: number
  ): Promise<void> {
    const rows = this.database
      .query(
        "SELECT m.ts, m.author, m.text, m.day, d.file_id AS fileId FROM slack_message m JOIN slack_day d ON d.company_id = m.company_id AND d.slack_channel_id = m.slack_channel_id AND d.day = m.day WHERE m.company_id = ? AND m.slack_channel_id = ? AND m.briefed = 0 AND m.deleted_at IS NULL AND d.file_id IS NOT NULL ORDER BY CAST(m.ts AS REAL)"
      )
      .all(companyId, channel.slackId) as {
      ts: string;
      author: string;
      text: string;
      day: string;
      fileId: string;
    }[];
    const newest = Number(rows.at(-1)?.ts ?? 0) * 1000;
    if (rows.length === 0 || now - newest < SLACK_BRIEF_QUIET_MS) {
      return;
    }
    await this.ports.brief(
      companyId,
      channel.id,
      newestWithin(rows, SLACK_BRIEF_TEXT).map((row) => ({
        file: { id: row.fileId, name: `slack-${row.day}.md` },
        author: row.author,
        text: row.text,
        time: Number(row.ts) * 1000,
      }))
    );
    // A message that an event changed while the brief was written stays unread, for the next brief.
    const read = this.database.query(
      "UPDATE slack_message SET briefed = 1 WHERE company_id = ? AND slack_channel_id = ? AND ts = ? AND text = ?"
    );
    this.database.transaction(() => {
      for (const row of rows) {
        read.run(companyId, channel.slackId, row.ts, row.text);
      }
    })();
  }

  /** The name of the person or the bot that wrote a message; Slack's users.info names a person once. */
  private async author(
    companyId: string,
    token: string,
    message: SlackMessage,
    signal?: AbortSignal
  ): Promise<string> {
    if (message.user_profile?.real_name || message.user_profile?.display_name) {
      return slackPersonName({ profile: message.user_profile }, "");
    }
    if (!message.user) {
      return message.username ?? message.bot_profile?.name ?? "Slack";
    }
    return await this.userName(companyId, token, message.user, signal);
  }

  private async userName(
    companyId: string,
    token: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<string> {
    const known = this.database
      .query("SELECT name FROM slack_user WHERE company_id = ? AND user_id = ?")
      .get(companyId, userId) as { name: string } | null;
    if (known) {
      return known.name;
    }
    const { user } = (await this.api.call(
      token,
      "users.info",
      { user: userId },
      signal
    )) as { user?: SlackUser };
    const name = slackPersonName(user, userId);
    this.database
      .query(
        "INSERT INTO slack_user (company_id, user_id, name) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name"
      )
      .run(companyId, userId, name);
    return name;
  }

  /** Slack's markup as plain Markdown: names for mentions, `#name` for channels, and links. */
  async plain(
    companyId: string,
    token: string,
    text: string,
    signal?: AbortSignal
  ): Promise<string> {
    const names = new Map<string, string>();
    for (const id of slackMentions(text)) {
      names.set(id, await this.userName(companyId, token, id, signal));
    }
    return slackMarkdown(text, names);
  }

  /** The address of the bot's Slack workspace, for the links of messages; null before the bot read it. */
  private workspaceUrl(companyId: string): string | null {
    return (
      (
        this.database
          .query(
            "SELECT team_url AS url FROM slack_bot WHERE company_id = ? AND deleted_at IS NULL"
          )
          .get(companyId) as { url: string | null } | null
      )?.url ?? null
    );
  }

  private stored(
    companyId: string,
    slackChannelId: string,
    ts: string
  ): StoredMessage | null {
    return this.database
      .query(
        "SELECT ts, thread_ts, author, text, files, day FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND ts = ? AND deleted_at IS NULL"
      )
      .get(companyId, slackChannelId, ts) as StoredMessage | null;
  }

  private latestReply(
    companyId: string,
    slackChannelId: string,
    threadTs: string
  ): string {
    const row = this.database
      .query(
        "SELECT max(ts) AS ts FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND thread_ts = ? AND deleted_at IS NULL"
      )
      .get(companyId, slackChannelId, threadTs) as { ts: string | null };
    return row.ts ?? "";
  }

  /** The messages that started a thread or stand alone, from `oldest` on. */
  private storedSince(
    companyId: string,
    slackChannelId: string,
    oldest: string
  ): { ts: string; day: string }[] {
    return this.database
      .query(
        "SELECT ts, day FROM slack_message WHERE company_id = ? AND slack_channel_id = ? AND thread_ts IS NULL AND deleted_at IS NULL AND CAST(ts AS REAL) >= CAST(? AS REAL)"
      )
      .all(companyId, slackChannelId, oldest) as { ts: string; day: string }[];
  }
}

/** The Markdown of one day of a channel: each message, with the replies of its thread under it as quotes. */
function dayText(
  channel: SlackChannelOf,
  day: string,
  messages: readonly StoredMessage[],
  workspaceUrl: string | null
): string {
  // The link gives the Slack channel's ID, as Shadow's name can differ from Slack's, such as support-slack.
  const name = workspaceUrl
    ? `[#${channel.name}](${new URL(`/archives/${channel.slackId}`, workspaceUrl).href})`
    : `#${channel.name}`;
  const lines = [`# ${name}, ${day}`, ""];
  const linesOf = (message: StoredMessage) =>
    messageLines(
      message,
      workspaceUrl &&
        slackPermalink(
          workspaceUrl,
          channel.slackId,
          message.ts,
          message.thread_ts
        )
    );
  const replies = Map.groupBy(
    messages.filter((message) => message.thread_ts),
    (message) => message.thread_ts!
  );
  for (const message of messages.filter((each) => !each.thread_ts)) {
    lines.push(...linesOf(message), "");
    for (const reply of replies.get(message.ts) ?? []) {
      lines.push(...linesOf(reply).map((line) => `> ${line}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A message under its author's name and its time, which links to the message in Slack. */
function messageLines(message: StoredMessage, link: string | null): string[] {
  const files = (JSON.parse(message.files) as Kept[]).map((file) =>
    "id" in file
      ? `[${file.name}](file:${file.id})`
      : `${file.name} (${file.link})`
  );
  return [
    `**${message.author}**, ${link ? `[${slackClock(message.ts)}](${link})` : slackClock(message.ts)}`,
    ...(message.text ? message.text.split("\n") : []),
    ...(files.length > 0 ? [`Attachments: ${files.join(", ")}`] : []),
  ];
}

/** The newest messages whose text fits in `size`, oldest first; at least the newest one. */
export function newestWithin<T extends { readonly text: string }>(
  messages: readonly T[],
  size: number
): T[] {
  let used = 0;
  let first = messages.length;
  while (first > 0) {
    used += messages[first - 1]!.text.length;
    if (used > size && first < messages.length) {
      break;
    }
    first -= 1;
  }
  return messages.slice(first);
}

function nextCursor(page: Record<string, unknown>): string {
  return (
    (page.response_metadata as { next_cursor?: string } | undefined)
      ?.next_cursor ?? ""
  );
}
