import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Agenda } from "../agenda/agenda.ts";
import type { Artifacts } from "../artifacts/artifacts.ts";
import type { Channel, Companies } from "../companies/companies.ts";
import type { FeedbackReports } from "../feedback/feedback.ts";
import type {
  SlackBot,
  SlackClient,
  SlackSurfacePort,
} from "../integrations/integrations.ts";
import type { Llm } from "../llm/llm.ts";
import type {
  Notification,
  Notifications,
} from "../notifications/notifications.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Routines } from "../routines/routines.ts";
import type { Approval, Message, Threads } from "../threads/threads.ts";
import { type ChannelGoal, checkMessage } from "./check.ts";
import {
  answerParts,
  buttons,
  contextBlock,
  markdownMessage,
  slackMarkdown,
  stepWords,
} from "./format.ts";

/** How long Shadow follows a thread after its last reply there: replies to it go through the check. */
export const FOLLOW_MS = 7 * 24 * 60 * 60_000;
/** The most replies that Shadow posts unasked in one channel within an hour. */
export const AMBIENT_PER_HOUR = 4;
/** How often the status of a working answer changes in Slack at most. */
const STATUS_MS = 2000;
/** The largest file of a Slack message that Shadow takes into a thread. */
const LARGEST_FILE = 20 * 1024 * 1024;
const DENIED =
  "I cannot answer this Slack account: its email is not allowed in Shadow. Ask an admin of Shadow.";
const ONLY_PUBLIC =
  "I answer in public channels and in DMs for now; ask me there.";

/** A channel that copies a Slack channel, with its goal for ambient listening, as admins see it in Company settings. */
export interface SlackGoal {
  readonly channelId: string;
  readonly channelName: string;
  /** Null for a channel without a goal, where Shadow answers only mentions. */
  readonly wakeWhen: string | null;
  readonly engagement: string | null;
}

/** What ambient listening decided about one message, without its text. */
export interface SlackDecision {
  readonly channelName: string;
  readonly slackChannelId: string;
  readonly ts: string;
  readonly reason: string;
  readonly probability: number | null;
  /** `skipped`, `quiet`, `replied`, `capped`, `muted`, or `failed`. */
  readonly outcome: string;
  readonly at: number;
}

interface Conversation {
  readonly thread_id: string;
  readonly followed_until: number | null;
  readonly muted: number;
  readonly last_reply_ts: string | null;
}

interface ReplyRow {
  readonly id: string;
  readonly company_id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly slack_channel_id: string;
  readonly root_ts: string | null;
  readonly message_ts: string;
  readonly after_message_id: number;
}

/** A Slack message event or app_mention, as Socket Mode gives it. */
interface SlackEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly channel: string;
  readonly channel_type?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly files?: readonly {
    readonly name?: string;
    readonly size?: number;
    readonly url_private_download?: string;
  }[];
}

type SurfaceCompanies = Pick<
  Companies,
  | "agentMember"
  | "allThreadsIn"
  | "channelsIn"
  | "isAdmin"
  | "memberByEmail"
  | "members"
  | "requireAdmin"
  | "requireMember"
  | "threadOf"
>;

/**
 * Shadow in Slack: the company's Slack bot is a second app of Shadow, next to the web app. A mention in a public
 * channel or a DM is a person's request: the Slack thread is a Shadow thread of that channel, and a DM goes to the
 * person's own thread. The answer shows its work as it happens and then replaces it, with a link to Shadow.
 *
 * Shadow also listens, as eve's ambient pattern does, but only where an admin gave a channel a goal, and in threads it
 * answered in during the last `FOLLOW_MS`: a cheap check skips what is clearly not for it, and the agent answers only
 * when a reply helps; else it stays quiet, or tells one person privately (`notices_tell`). It never acts unasked.
 *
 * Approvals, notifications, and routines that post in Slack reach people there too.
 */
export class SlackSurface implements SlackSurfacePort {
  /** The answers that Shadow is showing now, by reply id, with what stops watching them. */
  private readonly following = new Map<string, Promise<() => Promise<void>>>();
  /** The approvals that Shadow asked in Slack already. */
  private readonly asked = new Set<string>();
  /** The events seen once, by `<channel> <ts>`. */
  private readonly seen = new Set<string>();
  /** The public channel each person looks at in Slack, by `<company> <slack user>`. */
  private readonly views = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly database: Database,
    private readonly bot: Pick<SlackBot, "client" | "attach">,
    private readonly companies: SurfaceCompanies,
    private readonly threads: Pick<
      Threads,
      | "answerApproval"
      | "brief"
      | "create"
      | "instruct"
      | "messages"
      | "orchestrator"
      | "send"
      | "startAgentThread"
      | "stop"
      | "watch"
    >,
    private readonly llm: Pick<Llm, "complete" | "fastModel">,
    notifications: Pick<Notifications, "onDelivery">,
    private readonly agenda: Pick<Agenda, "upcoming" | "answer">,
    private readonly routines: Pick<Routines, "update">,
    private readonly artifacts: Pick<Artifacts, "get">,
    private readonly feedback: Pick<FeedbackReports, "report">,
    private readonly baseUrl: string
  ) {
    bot.attach(this);
    notifications.onDelivery((notification, userId) =>
      this.detach(() => this.deliver(notification, userId))
    );
  }

  /** Finishes the answers that a restart cut off: their agent goes on, and Shadow shows its answer when it comes. */
  start(): void {
    const open = this.database
      .query("SELECT * FROM slack_reply WHERE done_at IS NULL")
      .all() as ReplyRow[];
    for (const row of open) {
      this.detach(() => this.follow(row));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const stops = await Promise.all(this.following.values());
    await Promise.all(stops.map((stop) => stop()));
    this.following.clear();
  }

  // Events

  event(companyId: string, event: Record<string, unknown>): Promise<void> {
    const slack = event as unknown as SlackEvent;
    if (slack.type === "app_mention") {
      this.detach(() => this.mention(companyId, slack));
    } else if (slack.type === "message" && slack.channel_type === "im") {
      this.detach(() => this.direct(companyId, slack));
    } else if (slack.type === "message" && slack.channel_type === "mpim") {
      // A group DM wakes Shadow only with a mention; app_mention may bring the same message, which `once` drops.
      this.detach(() => this.group(companyId, slack));
    } else if (slack.type === "message") {
      this.detach(() => this.listen(companyId, slack));
    } else if (slack.type === "agent_session_stopped") {
      this.detach(() => this.stopSession(companyId, event));
    } else if (slack.type === "app_context_changed") {
      this.viewing(companyId, event);
    } else if (slack.type === "app_home_opened" && event.tab !== "messages") {
      this.detach(() => this.home(companyId, String(event.user)));
    } else if (slack.type === "link_shared") {
      this.detach(() => this.unfurl(companyId, event));
    }
    return Promise.resolve();
  }

  interaction(companyId: string, payload: Record<string, unknown>): void {
    this.detach(() => this.click(companyId, payload));
  }

  /** A mention in a channel: a request of its person, answered in the Slack thread. */
  private async mention(companyId: string, event: SlackEvent): Promise<void> {
    const client = this.bot.client(companyId);
    if (!(client && event.user) || event.user === client.botUserId) {
      return;
    }
    const root = event.thread_ts ?? event.ts;
    const channel = this.channelOf(companyId, event.channel);
    if (!channel) {
      const { channel: info } = (await client.call("conversations.info", {
        channel: event.channel,
      })) as { channel?: { is_mpim?: boolean } };
      if (info?.is_mpim) {
        await this.group(companyId, event);
      } else {
        await this.say(client, event.channel, root, ONLY_PUBLIC);
      }
      return;
    }
    const user = await this.person(companyId, client, event.user);
    if (!user) {
      await this.say(client, event.channel, root, DENIED);
      return;
    }
    // The answer goes to a Slack channel that people outside Shadow may read, such as guests.
    const text = `${await client.plain(
      stripMention(event.text ?? "", client.botUserId)
    )}\n\n(Asked in Slack #${channel.name}: the answer is posted there, where people outside Shadow may read it, so leave out what only ${user.name} may see. A routine asked for here posts in Slack with post_in_slack.)`;
    const files = await this.files(client, event.files);
    const known = this.conversation(companyId, event.channel, root);
    let threadId: string;
    let after = 0;
    if (known) {
      threadId = known.thread_id;
      after = await this.lastMessageId(companyId, threadId);
      await this.threads.send(threadId, user, text, files);
    } else {
      // A new Shadow thread starts with what the Slack thread said before Shadow was asked.
      const earlier = client
        .transcript(event.channel, root, 30)
        .filter((message) => message.ts !== event.ts);
      const context = earlier.length
        ? `Earlier in this Slack thread:\n${earlier.map((message) => `- ${message.author}: ${message.text}`).join("\n")}\n\n`
        : "";
      const thread = await this.threads.create(
        companyId,
        user,
        channel.id,
        `${context}${text}`,
        files
      );
      threadId = thread.id;
      this.saveConversation(companyId, event.channel, root, threadId);
    }
    this.followFor(companyId, event.channel, root);
    await this.reply(companyId, threadId, user, event.channel, root, after);
  }

  /** A DM: the person's own thread, which hands work on to the channels as on the web. */
  private async direct(companyId: string, event: SlackEvent): Promise<void> {
    const client = this.bot.client(companyId);
    if (
      !(client && event.user) ||
      event.bot_id ||
      event.user === client.botUserId ||
      (event.subtype && event.subtype !== "file_share")
    ) {
      return;
    }
    const user = await this.person(companyId, client, event.user);
    if (!user) {
      await this.say(client, event.channel, event.thread_ts ?? null, DENIED);
      return;
    }
    const own = await this.threads.orchestrator(companyId, user);
    const after = await this.lastMessageId(companyId, own.id);
    const text = await client.plain(event.text ?? "");
    const viewing = this.views.get(`${companyId} ${event.user}`);
    await this.threads.send(
      own.id,
      user,
      viewing
        ? `${text}\n\n(In Slack, ${user.name} is looking at <#${viewing}>.)`
        : text,
      await this.files(client, event.files)
    );
    // Each conversation in the agent view of Slack is a thread of the DM: the answer goes there.
    await this.reply(
      companyId,
      own.id,
      user,
      event.channel,
      event.thread_ts ?? event.ts,
      after
    );
  }

  /**
   * A mention in a group DM: the asker's own thread answers, with the group's conversation as data, and is told that
   * everyone in the group reads the answer. Shadow keeps no shared place for a group, so each person's data stays theirs.
   */
  private async group(companyId: string, event: SlackEvent): Promise<void> {
    const client = this.bot.client(companyId);
    if (
      !(client?.botUserId && event.user) ||
      event.bot_id ||
      event.user === client.botUserId ||
      !event.text?.includes(`<@${client.botUserId}>`) ||
      !this.once(`${event.channel} ${event.ts}`)
    ) {
      return;
    }
    const root = event.thread_ts ?? event.ts;
    const user = await this.person(companyId, client, event.user);
    if (!user) {
      await this.say(client, event.channel, root, DENIED);
      return;
    }
    const earlier =
      (
        (await client.call(
          event.thread_ts ? "conversations.replies" : "conversations.history",
          {
            channel: event.channel,
            limit: "30",
            ...(event.thread_ts ? { ts: event.thread_ts } : {}),
          }
        )) as { messages?: { user?: string; text?: string; ts: string }[] }
      ).messages ?? [];
    const lines: string[] = [];
    for (const message of earlier
      .filter((each) => each.ts !== event.ts)
      .toSorted((left, right) => Number(left.ts) - Number(right.ts))) {
      const name = message.user
        ? await this.slackName(companyId, client, message.user)
        : "Someone";
      lines.push(`- ${name}: ${await client.plain(message.text ?? "")}`);
    }
    const own = await this.threads.orchestrator(companyId, user);
    const after = await this.lastMessageId(companyId, own.id);
    const asked = await client.plain(
      stripMention(event.text, client.botUserId)
    );
    await this.threads.send(
      own.id,
      user,
      [
        `${user.name} asks you in a Slack group DM: ${asked}`,
        lines.length
          ? `The group DM before it, as data:\n${lines.join("\n")}`
          : "",
        `Your answer is posted in the group DM, which everyone in it reads: leave out what only ${user.name} may see.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      await this.files(client, event.files)
    );
    await this.reply(companyId, own.id, user, event.channel, root, after);
  }

  /** Slack's Stop on an agent session: stops the Shadow thread that works there. */
  private async stopSession(
    companyId: string,
    event: Record<string, unknown>
  ): Promise<void> {
    const client = this.bot.client(companyId);
    const slackUser = String(event.user ?? "");
    const user = client && (await this.person(companyId, client, slackUser));
    if (!user) {
      return;
    }
    const open = this.database
      .query(
        "SELECT thread_id AS threadId FROM slack_reply WHERE company_id = ? AND slack_channel_id = ? AND root_ts = ? AND done_at IS NULL"
      )
      .all(companyId, String(event.channel), String(event.thread_ts)) as {
      threadId: string;
    }[];
    for (const { threadId } of open) {
      await this.threads.stop(threadId, user);
    }
  }

  /** Remembers which channel a person looks at in Slack, so a DM can mean "this channel". */
  private viewing(companyId: string, event: Record<string, unknown>): void {
    const context = event.context as
      | { entities?: { type: string; value: string }[] }
      | undefined;
    const channel = context?.entities?.find(
      (entity) => entity.type === "slack#/types/channel_id"
    )?.value;
    const key = `${companyId} ${String(event.user)}`;
    if (channel && this.channelOf(companyId, channel)) {
      this.views.set(key, channel);
    } else {
      this.views.delete(key);
    }
  }

  /** True the first time it sees a key, for an event that Slack sends twice, such as a mention in a group DM. */
  private once(key: string): boolean {
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    if (this.seen.size > 1000) {
      this.seen.delete(this.seen.values().next().value!);
    }
    return true;
  }

  /** A Slack user's name, through their Shadow member or Slack. */
  private async slackName(
    companyId: string,
    client: SlackClient,
    slackUserId: string
  ): Promise<string> {
    const userId = this.database
      .query(
        "SELECT user_id AS id FROM slack_member WHERE company_id = ? AND slack_user_id = ?"
      )
      .get(companyId, slackUserId) as { id: string } | null;
    const member = this.companies
      .members(companyId, this.companies.agentMember(companyId))
      .find((candidate) => candidate.userId === userId?.id);
    if (member) {
      return member.name;
    }
    const { user } = (await client.call("users.info", {
      user: slackUserId,
    })) as { user?: { real_name?: string; name?: string } };
    return user?.real_name || user?.name || "Someone";
  }

  /** Posts a working status in Slack, then follows the Shadow thread until its answer replaces the status. */
  private async reply(
    companyId: string,
    threadId: string,
    user: User,
    slackChannelId: string,
    rootTs: string | null,
    after: number
  ): Promise<void> {
    const client = this.bot.client(companyId)!;
    await sessionStatus(client, slackChannelId, rootTs, "processing");
    const posted = await client.post("chat.postMessage", {
      channel: slackChannelId,
      ...(rootTs ? { thread_ts: rootTs } : {}),
      ...statusMessage("Working", threadId),
    });
    const row: ReplyRow = {
      id: randomUUID(),
      company_id: companyId,
      thread_id: threadId,
      user_id: user.id,
      slack_channel_id: slackChannelId,
      root_ts: rootTs,
      message_ts: String(posted.ts),
      after_message_id: after,
    };
    this.database
      .query(
        "INSERT INTO slack_reply (id, company_id, thread_id, user_id, slack_channel_id, root_ts, message_ts, after_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        row.id,
        companyId,
        threadId,
        user.id,
        slackChannelId,
        rootTs,
        row.message_ts,
        after,
        Date.now()
      );
    await this.follow(row);
  }

  /** Watches the thread: its work steps change the status, its approvals go to their person, and its answer ends it. */
  private follow(row: ReplyRow): Promise<void> {
    const thread = this.companies
      .allThreadsIn(row.company_id)
      .find((candidate) => candidate.id === row.thread_id);
    const client = this.bot.client(row.company_id);
    if (!(thread && client) || this.closed) {
      return Promise.resolve();
    }
    let shown = "";
    let shownAt = 0;
    let done = false;
    const stopping = this.threads.watch(thread, (state) => {
      if (done) {
        return;
      }
      for (const approval of state.approvals) {
        this.detach(() =>
          this.askApproval(row.company_id, row.thread_id, approval)
        );
      }
      const answer = state.messages.findLast(
        (message) => message.agent && Number(message.id) > row.after_message_id
      );
      if (!state.running && answer && !answer.streaming) {
        done = true;
        this.detach(async () => {
          await this.finish(client, row, answer);
          const stop = await this.following.get(row.id);
          this.following.delete(row.id);
          await stop?.();
        });
        return;
      }
      const status = statusOf(state.messages.at(-1));
      if (status !== shown && Date.now() - shownAt >= STATUS_MS) {
        shown = status;
        shownAt = Date.now();
        this.detach(() =>
          client.post("chat.update", {
            channel: row.slack_channel_id,
            ts: row.message_ts,
            ...statusMessage(status, row.thread_id),
          })
        );
      }
    });
    this.following.set(row.id, stopping);
    return stopping.then(() => undefined);
  }

  /** Puts the answer in place of the status, in parts that fit Slack, with a link to Shadow and feedback buttons. */
  private async finish(
    client: SlackClient,
    row: ReplyRow,
    answer: Message
  ): Promise<void> {
    let { text } = answer;
    if (answer.failed) {
      text =
        "I hit an error while working on this. The thread in Shadow shows what happened.";
    } else if (answer.work?.stopped && !text.trim()) {
      text = "Stopped. What was already done stays done.";
    }
    const parts = answerParts(
      slackMarkdown(text, { baseUrl: this.baseUrl, companyId: row.company_id })
    );
    const footer = [
      contextBlock(
        `<${this.threadLink(row.company_id, row.thread_id)}|Open in Shadow>`
      ),
      feedbackButtons(row.thread_id),
    ];
    for (const [index, part] of parts.entries()) {
      const message = markdownMessage(
        part,
        index === parts.length - 1 ? footer : []
      );
      if (index === 0) {
        await client.post("chat.update", {
          channel: row.slack_channel_id,
          ts: row.message_ts,
          ...message,
        });
      } else {
        await client.post("chat.postMessage", {
          channel: row.slack_channel_id,
          ...(row.root_ts ? { thread_ts: row.root_ts } : {}),
          ...message,
        });
      }
    }
    await sessionStatus(client, row.slack_channel_id, row.root_ts, "active");
    this.database
      .query("UPDATE slack_reply SET done_at = ? WHERE id = ?")
      .run(Date.now(), row.id);
  }

  // Ambient listening

  /**
   * A message that nobody addressed to Shadow, as eve routes it: in a thread that Shadow follows, or at the top of a
   * channel with a goal, it goes through the cheap check, and then maybe an agent turn; anything else costs nothing.
   */
  private async listen(companyId: string, event: SlackEvent): Promise<void> {
    const client = this.bot.client(companyId);
    if (!(client && isAmbient(event, client.botUserId))) {
      return;
    }
    const channel = this.channelOf(companyId, event.channel);
    if (!channel) {
      return;
    }
    const root = event.thread_ts ?? event.ts;
    const known = this.conversation(companyId, event.channel, root);
    const followed =
      Boolean(event.thread_ts) &&
      known !== null &&
      (known.followed_until ?? 0) > Date.now();
    const goal = this.goalOf(companyId, channel.id);
    if (followed || (goal && !event.thread_ts)) {
      await this.screen(companyId, client, event, channel, {
        root,
        known,
        goal: followed ? null : goal,
      });
    }
  }

  /** The cheap check, after the mute and the hourly cap; a message that passes goes to an agent turn. */
  private async screen(
    companyId: string,
    client: SlackClient,
    event: SlackEvent,
    channel: Channel,
    place: {
      readonly root: string;
      readonly known: Conversation | null;
      readonly goal: ChannelGoal | null;
    }
  ): Promise<void> {
    const log = this.logger(companyId, channel.id, event);
    if (place.known?.muted) {
      log("muted", null, "muted");
      return;
    }
    if (this.repliesThisHour(companyId, channel.id) >= AMBIENT_PER_HOUR) {
      log("cap", null, "capped");
      return;
    }
    const messages = client.transcript(
      event.channel,
      event.thread_ts ? place.root : null,
      10
    );
    const member = this.companies.agentMember(companyId);
    const brief = await this.threads.brief(companyId, channel.id, member);
    const check = await checkMessage(
      (system, text, signal) =>
        this.llm.complete(
          system,
          text,
          signal,
          this.llm.fastModel(),
          { companyId, userId: null, source: "slack", threadId: null },
          "low"
        ),
      place.goal,
      brief?.text ?? null,
      // The check reads only a conversation that already holds the new message.
      messages.at(-1)?.ts === event.ts ? messages : []
    );
    if (check.skip) {
      log(check.reason, check.probability, "skipped");
      return;
    }
    try {
      const replied = await this.takePart(
        companyId,
        client,
        event,
        channel,
        place,
        messages.at(-1)?.text ?? "Slack"
      );
      log(check.reason, check.probability, replied ? "replied" : "quiet");
    } catch (error) {
      log(check.reason, check.probability, "failed");
      throw error;
    }
  }

  /**
   * An ambient turn in the Shadow thread of the Slack thread, in the shared realm, so it never sees one person's
   * private data. It posts the answer with a Mute button, and follows the thread; a QUIET answer posts nothing.
   */
  private async takePart(
    companyId: string,
    client: SlackClient,
    event: SlackEvent,
    channel: Channel,
    place: {
      readonly root: string;
      readonly known: Conversation | null;
      readonly goal: ChannelGoal | null;
    },
    title: string
  ): Promise<boolean> {
    const { root, known } = place;
    const thread = known
      ? this.companies
          .allThreadsIn(companyId)
          .find((candidate) => candidate.id === known.thread_id)
      : await this.threads.startAgentThread(
          companyId,
          channel.id,
          titleOf(title)
        );
    if (!thread) {
      return false;
    }
    if (!known) {
      this.saveConversation(companyId, event.channel, root, thread.id);
    }
    const since = client.transcript(
      event.channel,
      event.thread_ts ? root : null,
      30,
      known?.last_reply_ts ?? "0"
    );
    const answer = await this.threads.instruct(
      thread,
      ambientTask(channel.name, place.goal, since),
      `slack:${event.channel}:${event.ts}`,
      [],
      null,
      "slack"
    );
    if (answer === null) {
      return false;
    }
    const parts = answerParts(
      slackMarkdown(answer, { baseUrl: this.baseUrl, companyId })
    );
    let lastTs = "";
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      const posted = await client.post("chat.postMessage", {
        channel: event.channel,
        thread_ts: root,
        ...markdownMessage(
          part,
          last
            ? [
                contextBlock(
                  `<${this.threadLink(companyId, thread.id)}|Open in Shadow>`
                ),
                buttons([
                  {
                    id: "shadow_mute",
                    text: "Mute here",
                    value: JSON.stringify({ channel: event.channel, root }),
                  },
                ]),
              ]
            : []
        ),
      });
      lastTs = String(posted.ts);
    }
    this.database
      .query(
        "UPDATE slack_conversation SET followed_until = ?, last_reply_ts = ? WHERE company_id = ? AND slack_channel_id = ? AND root_ts = ?"
      )
      .run(Date.now() + FOLLOW_MS, lastTs, companyId, event.channel, root);
    return true;
  }

  /** Logs what ambient listening decided about a message: its reason, probability, and outcome, never its text. */
  private logger(companyId: string, channelId: string, event: SlackEvent) {
    return (reason: string, probability: number | null, outcome: string) =>
      this.database
        .query(
          "INSERT INTO slack_decision (company_id, channel_id, slack_channel_id, ts, reason, probability, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          companyId,
          channelId,
          event.channel,
          event.ts,
          reason,
          probability,
          outcome,
          Date.now()
        );
  }

  private repliesThisHour(companyId: string, channelId: string): number {
    return (
      this.database
        .query(
          "SELECT count(*) AS count FROM slack_decision WHERE company_id = ? AND channel_id = ? AND outcome = 'replied' AND at > ?"
        )
        .get(companyId, channelId, Date.now() - 60 * 60_000) as {
        count: number;
      }
    ).count;
  }

  // Clicks

  private async click(
    companyId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const client = this.bot.client(companyId);
    const action = (
      payload.actions as { action_id: string; value: string }[] | undefined
    )?.[0];
    const slackUser = (payload.user as { id?: string } | undefined)?.id;
    if (!(client && action && slackUser)) {
      return;
    }
    const user = await this.person(companyId, client, slackUser);
    if (!user) {
      return;
    }
    const where = {
      channel: (payload.channel as { id: string } | undefined)?.id,
      ts: (payload.message as { ts: string } | undefined)?.ts,
    };
    switch (action.action_id) {
      case "shadow_stop":
        await this.threads.stop(action.value, user);
        return;
      case "shadow_allow":
      case "shadow_deny": {
        const { threadId, approvalId } = JSON.parse(action.value) as {
          threadId: string;
          approvalId: string;
        };
        const allow = action.action_id === "shadow_allow";
        this.threads.answerApproval(threadId, approvalId, user, allow);
        if (where.channel && where.ts) {
          await client.post("chat.update", {
            channel: where.channel,
            ts: where.ts,
            text: allow ? "Allowed." : "Denied.",
            blocks: [contextBlock(allow ? "Allowed." : "Denied.")],
          });
        }
        return;
      }
      case "shadow_mute": {
        const { channel, root } = JSON.parse(action.value) as {
          channel: string;
          root: string;
        };
        this.database
          .query(
            "UPDATE slack_conversation SET muted = 1 WHERE company_id = ? AND slack_channel_id = ? AND root_ts = ?"
          )
          .run(companyId, channel, root);
        await client.post("chat.postEphemeral", {
          channel,
          thread_ts: root,
          user: slackUser,
          text: "Muted: I answer in this thread only when someone mentions me.",
        });
        return;
      }
      case "shadow_accept":
      case "shadow_decline": {
        await this.answerOffer(
          companyId,
          client,
          user,
          slackUser,
          JSON.parse(action.value) as { id: string; kind: string },
          action.action_id === "shadow_accept",
          where
        );
        return;
      }
      case "shadow_good":
      case "shadow_bad": {
        const good = action.action_id === "shadow_good";
        if (!good) {
          this.feedback.report(companyId, {
            id: `slack:${where.channel}:${where.ts}:${user.id}`,
            threadId: action.value,
            personId: user.id,
            kind: "better",
            summary: "A Slack answer was not good",
            detail: `${user.name} marked an answer in Slack as not good.`,
          });
        }
        if (where.channel) {
          await client.post("chat.postEphemeral", {
            channel: where.channel,
            user: slackUser,
            text: good
              ? "Thanks."
              : "Thanks. Tell me in this thread what was wrong or missing, and I will correct it.",
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Offers a person a routine or a reminder in the Slack thread of a Shadow thread, with buttons that only they answer;
   * a thread that is no Slack thread leaves the offer in their Upcoming.
   */
  async offerInSlack(
    companyId: string,
    threadId: string,
    offer: {
      readonly id: string;
      readonly kind: string;
      readonly name: string;
      readonly schedule: string | null;
    },
    personId: string
  ): Promise<void> {
    const client = this.bot.client(companyId);
    const place = this.database
      .query(
        "SELECT slack_channel_id AS channel, root_ts AS root FROM slack_conversation WHERE company_id = ? AND thread_id = ?"
      )
      .get(companyId, threadId) as { channel: string; root: string } | null;
    const slackUser = this.slackUserOf(companyId, personId);
    if (!(client && place)) {
      return;
    }
    const who = slackUser ? `<@${slackUser}>` : "You";
    const what =
      offer.kind === "routine"
        ? `the routine **${offer.name}** (\`${offer.schedule}\`), which posts here`
        : `a reminder: **${offer.name}**`;
    const value = JSON.stringify({ id: offer.id, kind: offer.kind });
    await client.post("chat.postMessage", {
      channel: place.channel,
      thread_ts: place.root,
      ...markdownMessage(
        `${who}, I can set up ${what}. It is yours, and starts only when you say so.`,
        [
          buttons([
            { id: "shadow_accept", text: "Set it up", value, style: "primary" },
            { id: "shadow_decline", text: "No, thanks", value },
          ]),
        ]
      ),
    });
  }

  /** Answers an offer for its person: an accepted routine is theirs and posts in its Slack channel; others are told no. */
  private async answerOffer(
    companyId: string,
    client: SlackClient,
    user: User,
    slackUser: string,
    offer: { readonly id: string; readonly kind: string },
    accept: boolean,
    where: { readonly channel?: string; readonly ts?: string }
  ): Promise<void> {
    let made: string | null;
    try {
      made = await this.agenda.answer(companyId, user, offer.id, accept);
    } catch {
      if (where.channel) {
        await client.post("chat.postEphemeral", {
          channel: where.channel,
          user: slackUser,
          text: "Only the person it is for answers this offer, once.",
        });
      }
      return;
    }
    if (made && offer.kind === "routine") {
      this.routines.update(
        companyId,
        user.id,
        made,
        { postInSlack: true },
        user.id
      );
    }
    if (where.channel && where.ts) {
      const text = accept
        ? `${user.name} set it up.`
        : `${user.name} said no, thanks.`;
      await client.post("chat.update", {
        channel: where.channel,
        ts: where.ts,
        text,
        blocks: [contextBlock(text)],
      });
    }
  }

  /** Asks an approval's person in a Slack DM, with Allow and Deny buttons; any member's approval goes to nobody. */
  private async askApproval(
    companyId: string,
    threadId: string,
    approval: Approval
  ): Promise<void> {
    if (this.asked.has(approval.id) || !approval.approverId) {
      return;
    }
    this.asked.add(approval.id);
    const client = this.bot.client(companyId);
    const slackUser = this.slackUserOf(companyId, approval.approverId);
    if (!(client && slackUser)) {
      return;
    }
    const channel = await this.dmChannel(client, slackUser);
    await client.post("chat.postMessage", {
      channel,
      ...markdownMessage(`**Allow?** ${approval.text}`, [
        buttons([
          {
            id: "shadow_allow",
            text: "Allow",
            value: JSON.stringify({ threadId, approvalId: approval.id }),
            style: "primary",
          },
          {
            id: "shadow_deny",
            text: "Deny",
            value: JSON.stringify({ threadId, approvalId: approval.id }),
            style: "danger",
          },
        ]),
        contextBlock(
          `<${this.threadLink(companyId, threadId)}|Open the thread in Shadow>`
        ),
      ]),
    });
  }

  // Notices, routines, Home, and links

  /** A notification that its person has not seen, also as a Slack DM. */
  private async deliver(
    notification: Notification,
    userId: string
  ): Promise<void> {
    const client = this.bot.client(notification.companyId);
    const slackUser = this.slackUserOf(notification.companyId, userId);
    if (!(client && slackUser)) {
      return;
    }
    const link = notification.threadId
      ? this.threadLink(notification.companyId, notification.threadId)
      : `${this.baseUrl}/c/${notification.companyId}/inbox`;
    await client.post("chat.postMessage", {
      channel: await this.dmChannel(client, slackUser),
      ...markdownMessage(`**${notification.title}**\n\n${notification.text}`, [
        contextBlock(`<${link}|Open in Shadow>`),
      ]),
    });
  }

  /** An answer of a routine that posts in Slack, at the top of the Slack channel that its channel copies. */
  async postRoutine(
    routine: {
      readonly companyId: string;
      readonly channelId: string;
      readonly name: string;
    },
    answer: string
  ): Promise<void> {
    const client = this.bot.client(routine.companyId);
    const channel = this.companies
      .channelsIn(routine.companyId, null)
      .find((candidate) => candidate.id === routine.channelId);
    if (!(client && channel?.slackId)) {
      return;
    }
    const parts = answerParts(
      slackMarkdown(`**${routine.name}**\n\n${answer}`, {
        baseUrl: this.baseUrl,
        companyId: routine.companyId,
      })
    );
    for (const part of parts) {
      await client.post("chat.postMessage", {
        channel: channel.slackId,
        ...markdownMessage(part),
      });
    }
  }

  /** The Home tab: what waits for the person, and their routines and reminders. */
  private async home(companyId: string, slackUserId: string): Promise<void> {
    const client = this.bot.client(companyId);
    const user = client && (await this.person(companyId, client, slackUserId));
    if (!(client && user)) {
      return;
    }
    const upcoming = this.agenda.upcoming(companyId, user);
    const lines = (items: readonly string[], none: string) =>
      items.length ? items.map((item) => `• ${item}`).join("\n") : none;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const when = (at: number | null) =>
      at
        ? new Date(at).toLocaleString("en-GB", {
            timeZone: zone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "paused";
    const text = [
      `**Waiting for you**\n${lines(
        upcoming.approvals.map(({ approval }) => approval.text),
        "Nothing."
      )}`,
      `**Routines**\n${lines(
        upcoming.routines.map(
          (routine) => `${routine.name}: ${when(routine.nextRunAt)}`
        ),
        'None. Ask me for one, such as "every Monday at 9, sum up #sales".'
      )}`,
      `**Reminders**\n${lines(
        upcoming.reminders.map(
          (reminder) => `${reminder.text}: ${when(reminder.dueAt)}`
        ),
        "None."
      )}`,
    ].join("\n\n");
    await client.post("views.publish", {
      user_id: slackUserId,
      view: {
        type: "home",
        blocks: [
          { type: "markdown", text },
          contextBlock(`<${this.baseUrl}|Open Shadow>`),
        ],
      },
    });
  }

  /** Shows the title of an artifact of Shadow where someone shares its link in Slack. */
  private async unfurl(
    companyId: string,
    event: Record<string, unknown>
  ): Promise<void> {
    const client = this.bot.client(companyId);
    const links = (event.links ?? []) as { url: string }[];
    if (!client || links.length === 0) {
      return;
    }
    const member = this.companies.agentMember(companyId);
    const unfurls: Record<string, unknown> = {};
    for (const { url } of links) {
      const id = /\/a\/([a-z]+(?:-[a-z]+){1,3})(?:\/|$)/.exec(url)?.[1];
      if (!id) {
        continue;
      }
      try {
        const artifact = this.artifacts.get(id, member);
        unfurls[url] = {
          blocks: [
            { type: "markdown", text: `**${artifact.title}**` },
            contextBlock("An artifact of Shadow"),
          ],
        };
      } catch {
        // A link to an artifact that is gone, or of a private channel, shows nothing.
      }
    }
    if (Object.keys(unfurls).length > 0) {
      await client.post("chat.unfurl", {
        channel: event.channel,
        ts: event.message_ts,
        unfurls,
      });
    }
  }

  // Goals and decisions, for admins

  /** The channels that copy a Slack channel, with their goal for ambient listening; null for one without. */
  goals(companyId: string, user: User): SlackGoal[] {
    this.companies.requireAdmin(companyId, user);
    return this.companies
      .channelsIn(companyId, null)
      .filter((channel) => channel.slackId)
      .map((channel) => {
        const goal = this.goalOf(companyId, channel.id);
        return {
          channelId: channel.id,
          channelName: channel.name,
          wakeWhen: goal?.wakeWhen ?? null,
          engagement: goal?.engagement ?? null,
        };
      });
  }

  /** Gives a channel a goal, which is the consent for Shadow to listen and take part there. */
  setGoal(
    companyId: string,
    user: User,
    channelId: string,
    goal: { readonly wakeWhen: unknown; readonly engagement: unknown }
  ): SlackGoal {
    this.companies.requireAdmin(companyId, user);
    const channel = this.slackChannel(companyId, channelId);
    const wakeWhen = required(goal.wakeWhen, "Wake when");
    const engagement = required(goal.engagement, "Take part by");
    this.database
      .query(
        "INSERT INTO slack_goal (company_id, channel_id, wake_when, engagement, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (company_id, channel_id) DO UPDATE SET wake_when = excluded.wake_when, engagement = excluded.engagement, changed_by = excluded.changed_by, changed_at = excluded.changed_at, deleted_at = NULL"
      )
      .run(companyId, channelId, wakeWhen, engagement, user.id, Date.now());
    return { channelId, channelName: channel.name, wakeWhen, engagement };
  }

  /** Stops Shadow listening in a channel; it still answers mentions there. */
  removeGoal(companyId: string, user: User, channelId: string): void {
    this.companies.requireAdmin(companyId, user);
    this.database
      .query(
        "UPDATE slack_goal SET deleted_at = ? WHERE company_id = ? AND channel_id = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), companyId, channelId);
  }

  /** A goal that the fast model suggests from the channel's brief, which the admin changes or accepts. */
  async suggestGoal(
    companyId: string,
    user: User,
    channelId: string
  ): Promise<ChannelGoal> {
    this.companies.requireAdmin(companyId, user);
    const channel = this.slackChannel(companyId, channelId);
    const brief = await this.threads.brief(companyId, channelId, user);
    const answer = await this.llm.complete(
      `You suggest when Shadow, a company's assistant, takes part in a Slack channel without being asked, and how. Shadow helps where it knows the answer or can find it in the company's sources; it does not chat. Answer with JSON only: {"wakeWhen": "<the kinds of messages, in one sentence>", "engagement": "<how Shadow answers them, in one sentence>"}.`,
      `Channel #${channel.name}\nSummary: ${channel.summary ?? "none"}\n\nBrief:\n${brief?.text ?? "none yet"}`,
      undefined,
      this.llm.fastModel(),
      { companyId, userId: user.id, source: "background", threadId: null }
    );
    const goal = JSON.parse(/\{[\s\S]*\}/.exec(answer)?.[0] ?? "{}") as {
      wakeWhen?: unknown;
      engagement?: unknown;
    };
    if (
      typeof goal.wakeWhen !== "string" ||
      typeof goal.engagement !== "string"
    ) {
      throw new HttpError(502, "The model gave no goal; write one");
    }
    return { wakeWhen: goal.wakeWhen, engagement: goal.engagement };
  }

  /** The newest decisions of ambient listening, for admins to tune the goals; never the text of messages. */
  decisions(companyId: string, user: User): SlackDecision[] {
    this.companies.requireAdmin(companyId, user);
    const names = new Map(
      this.companies
        .channelsIn(companyId, null)
        .map((channel) => [channel.id, channel.name])
    );
    return (
      this.database
        .query(
          "SELECT channel_id AS channelId, slack_channel_id AS slackChannelId, ts, reason, probability, outcome, at FROM slack_decision WHERE company_id = ? ORDER BY at DESC LIMIT 100"
        )
        .all(companyId) as (Omit<SlackDecision, "channelName"> & {
        channelId: string;
      })[]
    ).map(({ channelId, ...decision }) => ({
      ...decision,
      channelName: names.get(channelId) ?? "",
    }));
  }

  // Helpers

  private goalOf(companyId: string, channelId: string): ChannelGoal | null {
    const row = this.database
      .query(
        "SELECT wake_when AS wakeWhen, engagement FROM slack_goal WHERE company_id = ? AND channel_id = ? AND deleted_at IS NULL"
      )
      .get(companyId, channelId) as ChannelGoal | null;
    return row;
  }

  private slackChannel(companyId: string, channelId: string): Channel {
    const channel = this.companies
      .channelsIn(companyId, null)
      .find((candidate) => candidate.id === channelId && candidate.slackId);
    if (!channel) {
      throw notFound();
    }
    return channel;
  }

  /** The channel that copies a public Slack channel; null for a DM, a group, or a private channel. */
  private channelOf(companyId: string, slackChannelId: string): Channel | null {
    return (
      this.companies
        .channelsIn(companyId, null)
        .find((channel) => channel.slackId === slackChannelId) ?? null
    );
  }

  /** The Shadow member of a Slack user: one with an allowed email joins at their first message. */
  private async person(
    companyId: string,
    client: SlackClient,
    slackUserId: string
  ): Promise<User | null> {
    const known = this.database
      .query(
        "SELECT user_id AS id FROM slack_member WHERE company_id = ? AND slack_user_id = ?"
      )
      .get(companyId, slackUserId) as { id: string } | null;
    const members = this.companies.members(
      companyId,
      this.companies.agentMember(companyId)
    );
    const member = members.find((candidate) => candidate.userId === known?.id);
    if (member) {
      return { id: member.userId, name: member.name, email: member.email };
    }
    const { user } = (await client.call("users.info", {
      user: slackUserId,
    })) as {
      user?: {
        is_bot?: boolean;
        real_name?: string;
        profile?: { email?: string; real_name?: string };
      };
    };
    const email = user?.profile?.email;
    if (!email || user?.is_bot) {
      return null;
    }
    const person = await this.companies.memberByEmail(
      companyId,
      email,
      user?.real_name || user?.profile?.real_name || email
    );
    if (person) {
      this.database
        .query(
          "INSERT INTO slack_member (company_id, slack_user_id, user_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET user_id = excluded.user_id"
        )
        .run(companyId, slackUserId, person.id);
    }
    return person;
  }

  private slackUserOf(companyId: string, userId: string): string | null {
    return (
      (
        this.database
          .query(
            "SELECT slack_user_id AS id FROM slack_member WHERE company_id = ? AND user_id = ?"
          )
          .get(companyId, userId) as { id: string } | null
      )?.id ?? null
    );
  }

  private async dmChannel(
    client: SlackClient,
    slackUserId: string
  ): Promise<string> {
    const opened = (await client.post("conversations.open", {
      users: slackUserId,
    })) as { channel?: { id?: string } };
    return String(opened.channel?.id);
  }

  private conversation(
    companyId: string,
    slackChannelId: string,
    rootTs: string
  ): Conversation | null {
    return this.database
      .query(
        "SELECT thread_id, followed_until, muted, last_reply_ts FROM slack_conversation WHERE company_id = ? AND slack_channel_id = ? AND root_ts = ?"
      )
      .get(companyId, slackChannelId, rootTs) as Conversation | null;
  }

  private saveConversation(
    companyId: string,
    slackChannelId: string,
    rootTs: string,
    threadId: string
  ): void {
    this.database
      .query(
        "INSERT INTO slack_conversation (company_id, slack_channel_id, root_ts, thread_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"
      )
      .run(companyId, slackChannelId, rootTs, threadId);
  }

  /** Follows a thread where a person asked Shadow, as after its own reply. */
  private followFor(
    companyId: string,
    slackChannelId: string,
    rootTs: string
  ): void {
    this.database
      .query(
        "UPDATE slack_conversation SET followed_until = ? WHERE company_id = ? AND slack_channel_id = ? AND root_ts = ?"
      )
      .run(Date.now() + FOLLOW_MS, companyId, slackChannelId, rootTs);
  }

  private async lastMessageId(
    companyId: string,
    threadId: string
  ): Promise<number> {
    const thread = this.companies
      .allThreadsIn(companyId)
      .find((candidate) => candidate.id === threadId);
    if (!thread) {
      return 0;
    }
    const { messages } = await this.threads.messages(thread);
    return Number(messages.at(-1)?.id ?? 0);
  }

  /** The files of a Slack message, for the Shadow thread; a large one stays out. */
  private async files(
    client: SlackClient,
    files: SlackEvent["files"]
  ): Promise<File[]> {
    const kept: File[] = [];
    for (const file of files ?? []) {
      if (file.url_private_download && (file.size ?? 0) <= LARGEST_FILE) {
        kept.push(
          new File(
            [await client.download(file.url_private_download)],
            file.name ?? "file"
          )
        );
      }
    }
    return kept;
  }

  private async say(
    client: SlackClient,
    channel: string,
    rootTs: string | null,
    text: string
  ): Promise<void> {
    await client.post("chat.postMessage", {
      channel,
      ...(rootTs ? { thread_ts: rootTs } : {}),
      text,
    });
  }

  private threadLink(companyId: string, threadId: string): string {
    return `${this.baseUrl}/c/${companyId}/thread/${threadId}`;
  }

  /** Runs work after an event without holding up the next event; a failure goes to the log. */
  private detach(work: () => Promise<unknown>): void {
    if (this.closed) {
      return;
    }
    work().catch((error: unknown) => {
      if (!this.closed) {
        console.error("Slack work failed", error);
      }
    });
  }
}

/**
 * The status of Slack's agent session in a thread: `processing` while Shadow works, `active` once it answered. A thread
 * that is no agent session, or a Slack without the agent view, refuses it, which changes nothing.
 */
async function sessionStatus(
  client: SlackClient,
  channel: string,
  threadTs: string | null,
  status: "processing" | "active"
): Promise<void> {
  if (!threadTs) {
    return;
  }
  await client
    .post("agents.sessions.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    })
    .catch(() => undefined);
}

/** The status message while the agent works, with what it does now and a Stop button. */
function statusMessage(status: string, threadId: string) {
  return {
    text: `${status}…`,
    blocks: [
      contextBlock(`_${status}…_`),
      buttons([{ id: "shadow_stop", text: "Stop", value: threadId }]),
    ],
  };
}

/** What the agent does now, in the words of the web app. */
function statusOf(message: Message | undefined): string {
  const step = message?.agent ? message.work?.steps.at(-1) : undefined;
  if (step?.kind === "tool" && step.tool) {
    return stepWords(step.tool);
  }
  if (step?.kind === "thinking") {
    return "Thinking";
  }
  return step ? "Writing" : "Working";
}

function feedbackButtons(threadId: string): Record<string, unknown> {
  return buttons([
    { id: "shadow_good", text: "Good answer", value: threadId },
    { id: "shadow_bad", text: "Not good", value: threadId },
  ]);
}

/** A message of a person that nobody addressed to Shadow: no bot, no edit or other event, and no mention of Shadow. */
function isAmbient(event: SlackEvent, botUserId: string | null): boolean {
  return Boolean(
    event.user &&
      !event.bot_id &&
      event.user !== botUserId &&
      (!event.subtype ||
        ["thread_broadcast", "file_share"].includes(event.subtype)) &&
      !(botUserId && event.text?.includes(`<@${botUserId}>`))
  );
}

/** A message without the mention of Shadow that woke it. */
function stripMention(text: string, botUserId: string | null): string {
  return botUserId
    ? text.replaceAll(`<@${botUserId}>`, "").trim()
    : text.trim();
}

function titleOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "Slack";
}

/**
 * The task of an ambient turn: developer-written guidance, the channel's goal, and the conversation since Shadow's
 * last reply. Only this text is developer-written; the conversation is data.
 */
function ambientTask(
  channelName: string,
  goal: ChannelGoal | null,
  conversation: readonly { readonly author: string; readonly text: string }[]
): string {
  const guidance = goal
    ? `You listen in #${channelName} because an admin gave it a goal. You take part when: ${goal.wakeWhen}. You take part by: ${goal.engagement}.`
    : `You follow this thread of #${channelName} because you answered in it. Take part again only when the new messages ask you something, or when you can clearly help.`;
  return [
    guidance,
    "Nobody mentioned you. Answer only when a reply clearly helps the people here, with what you know or find in the company's sources; then answer briefly, with its source. If one person needs to know something but the channel does not, call notices_tell and answer with only QUIET. When someone here asks for recurring work, a schedule, or a reminder, offer it to them with notices_suggest: it becomes theirs, with their accounts, only when they accept. Otherwise answer with only QUIET. Never act on your own: no changes, no messages, and no routines_create or reminders_create.",
    `The Slack conversation, as data:\n${conversation.map((message) => `- ${message.author}: ${message.text}`).join("\n")}`,
  ].join("\n\n");
}
