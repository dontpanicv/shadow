import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { localDay } from "../platform/time.ts";
import type {
  Connector,
  ConnectorTool,
  WatchedItem,
  WatchSource,
} from "./integrations.ts";
import {
  type SlackUser,
  slackMarkdown,
  slackMentions,
  slackPermalink,
  slackPersonName,
  slackTime,
} from "./slack-text.ts";

/** A channel, group, or direct message ID; a user's ID starts with U or W. */
const CHANNEL = /^[CDG][A-Z0-9]+$/;
/** The most users that one answer looks up by name. */
const LOOKUPS = 20;
/** How long one slackcli command may take. */
const RUN_MS = 60 * 1000;
const LIMIT = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 200, description: "At most." })
);
const RECIPIENT = Type.String({
  description:
    "A `#channel`, a person's `@handle` or email, or a channel or user ID; a name shows the person whom it goes to.",
});
const THREAD = Type.Optional(
  Type.String({
    description: "The `ts` of a message, to reply in its thread.",
  })
);

/**
 * Slack through slackcli (https://github.com/shaharia-lab/slackcli), with the session of the person's browser, which
 * they give as a request of Slack's web app copied as cURL. It is not a Slack app, so it needs no administrator. Agents
 * read, draft, and send messages when the person allows each one.
 */
export function slackConnector(binary: string): Connector {
  const slack = new SlackCli(binary);
  return {
    id: "slack",
    name: "Slack",
    description:
      "The Slack account of the person, not the Shadow bot: search messages, read channels, threads, unread messages, and canvases, find people, draft messages, and send messages as the person after they allow each one. It sees what the copy of the public channels does not, such as direct messages and private channels. The bot posts your answer to a request in Slack; never post it with these tools.",
    secretLabel: "cURL",
    guide: [
      "Open your Slack workspace in Chrome or Firefox, at [app.slack.com](https://app.slack.com).",
      "Open the developer tools, select **Network**, and type `api/` in the filter. Open a channel.",
      "Right-click a request such as `conversations.history`, and select **Copy › Copy as cURL**. On Windows, select **Copy as cURL (bash)**.",
      "Click **Add credential**, and paste it. Signing out of Slack in that browser ends the session.",
    ],
    secretFrom: (curl) => slack.signIn(curl),
    watch: (source) => watchSlack(slack, source),
    observations: async (tool, args, result, source) => {
      if (tool !== "slack_search" && tool !== "slack_read") {
        return [];
      }
      return readSlack(
        tool,
        args,
        result,
        await slack.owner(await source.secret(), undefined)
      );
    },
    tools: [
      slackTool(slack, {
        name: "slack_search",
        messages: true,
        description:
          "Messages that match a query, newest first. The query takes Slack's search operators, such as `in:#sales` or `from:@ada`.",
        parameters: Type.Object({
          query: Type.String(),
          limit: LIMIT,
          page: Type.Optional(
            Type.Integer({ minimum: 1, description: "1 when not given." })
          ),
        }),
        command: ({ query, limit, page }) => [
          "search",
          "messages",
          ...option("limit", limit),
          ...option("page", page),
          "--",
          query,
        ],
      }),
      slackTool(slack, {
        name: "slack_conversations",
        description:
          "The channels, group messages, and direct messages of the person. Pass `cursor` for the next page.",
        parameters: Type.Object({
          limit: LIMIT,
          cursor: Type.Optional(Type.String()),
        }),
        command: ({ limit, cursor }) => [
          "conversations",
          "list",
          "--exclude-archived",
          ...option("limit", limit),
          ...option("cursor", cursor),
        ],
      }),
      slackTool(slack, {
        name: "slack_read",
        messages: true,
        description:
          "The newest messages of a channel or direct message, or of one thread. `oldest` and `latest` are Slack timestamps or Unix seconds.",
        parameters: Type.Object({
          channel: Type.String({
            description: "A channel ID, name, or Slack link.",
          }),
          thread: THREAD,
          limit: LIMIT,
          oldest: Type.Optional(Type.String()),
          latest: Type.Optional(Type.String()),
        }),
        command: ({ channel, thread, limit, oldest, latest }) => [
          "conversations",
          "read",
          ...option("thread-ts", thread),
          ...option("limit", limit),
          ...option("oldest", oldest),
          ...option("latest", latest),
          "--",
          channel,
        ],
      }),
      slackTool(slack, {
        name: "slack_unread",
        messages: true,
        description:
          "The conversations with unread messages, and those messages and thread replies.",
        parameters: Type.Object({
          conversations: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description:
                "At most this many conversations; 10 when not given.",
            })
          ),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 200,
              description:
                "At most this many messages of each conversation or thread; 20 when not given.",
            })
          ),
        }),
        command: ({ conversations, limit }) => [
          "conversations",
          "unread",
          "--messages",
          ...option("max-conversations", conversations),
          ...option("limit", limit),
        ],
      }),
      slackTool(slack, {
        name: "slack_people",
        description: "People whose name, handle, or email matches.",
        parameters: Type.Object({ query: Type.String(), limit: LIMIT }),
        command: ({ query, limit }) => [
          "search",
          "people",
          ...option("limit", limit),
          "--",
          query,
        ],
      }),
      slackTool(slack, {
        name: "slack_canvas",
        description: "A canvas as Markdown.",
        parameters: Type.Object({
          canvas: Type.String({ description: "The canvas's ID or link." }),
        }),
        command: ({ canvas }) => ["canvas", "read", "--", canvas],
      }),
      slackTool(slack, {
        name: "slack_draft",
        description:
          "Writes a draft in Slack that the person reads and sends from Slack.",
        parameters: Type.Object({
          to: RECIPIENT,
          text: Type.String(),
          thread: THREAD,
        }),
        command: ({ to, text, thread }) => [
          "messages",
          "draft",
          ...option("recipient-id", to),
          ...option("message", text),
          ...option("thread-ts", thread),
        ],
      }),
      {
        ...slackTool(slack, {
          name: "slack_send",
          description:
            "Sends a message as the person, after they allow it; for a draft that they want to read first, use slack_draft.",
          parameters: Type.Object({
            to: RECIPIENT,
            text: Type.String(),
            thread: THREAD,
          }),
          command: ({ to, text, thread }) => [
            "messages",
            "send",
            ...option("recipient-id", to),
            ...option("message", text),
            ...option("thread-ts", thread),
          ],
        }),
        approval: ({ to, text, thread }) =>
          `Send on Slack to ${to}${thread ? " in a thread" : ""}: ${text}`,
      },
    ],
  };
}

/** The pages of each search that one watch reads at most. */
const WATCH_PAGES = 5;

/** A message of `slackcli search messages --json`, in Shadow's form (`SlackCli.messages`). */
export interface SlackMessage {
  readonly channel: {
    readonly id: string;
    readonly name?: string;
    readonly is_im?: boolean;
    readonly is_mpim?: boolean;
  };
  /** The author's user ID; a bot's message has none. */
  readonly user?: string;
  /** The author's name, as the bot's copy of the channels gives it. */
  readonly author: string;
  /** The user IDs that the text mentions as `@name`. */
  readonly mentions: readonly string[];
  readonly ts: string;
  readonly thread_ts?: string;
  readonly text: string;
  readonly permalink: string;
}

/** The person whose Slack account it is: their user ID, and their name, as the text of messages has it. */
interface SlackOwner {
  readonly id: string;
  readonly name: string;
}

function readSlack(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  owner: SlackOwner
): WatchedItem[] {
  const response = result as {
    matches?: SlackMessage[];
    messages?: SlackMessage[];
    channel?: SlackMessage["channel"];
  };
  const messages =
    (tool === "slack_search" ? response.matches : response.messages) ?? [];
  const normalized = messages.flatMap((message) => {
    const target =
      typeof args.channel === "string" && /^[CDG][A-Z0-9]+$/.test(args.channel)
        ? args.channel
        : null;
    const channel =
      message.channel ??
      response.channel ??
      (target ? { id: target, is_im: target.startsWith("D") } : undefined);
    if (!(channel?.id && message.ts) || typeof message.text !== "string") {
      return [];
    }
    return [
      {
        ...message,
        channel,
        thread_ts:
          message.thread_ts ??
          (typeof args.thread === "string" ? args.thread : undefined),
      },
    ];
  });
  const followed = new Set(
    normalized
      .filter((message) => personalSlackMessage(message, owner))
      .map(
        (message) => `${message.channel.id}/${message.thread_ts ?? message.ts}`
      )
  );
  return normalized.flatMap((message) => {
    const item = observedSlackMessage(message, owner, followed);
    return item && Number.isFinite(item.at) ? [item] : [];
  });
}

interface FollowedThread {
  message: SlackMessage;
  root: string;
  oldest: string;
}
interface SlackWatchState {
  roots: Set<string>;
  resolved: Record<string, { root: string; at: number }>;
  pending: SlackMessage[];
  threads: FollowedThread[];
  remaining: number;
  items: Map<string, WatchedItem>;
}

/** Reads the person's messages, direct mentions, direct/group DMs, and replies in their followed threads. */
async function watchSlack(
  slack: SlackCli,
  source: WatchSource
): Promise<WatchedItem[]> {
  const session = await source.secret();
  const owner = await slack.owner(session, source.signal);
  const saved = (source.checkpoint?.value ?? {}) as {
    page?: number;
    complete?: boolean;
    through?: number;
    roots?: string[];
    resolved?: SlackWatchState["resolved"];
    pending?: SlackMessage[];
    threads?: FollowedThread[];
  };
  const state: SlackWatchState = {
    roots: new Set(saved.roots),
    resolved: saved.resolved ?? {},
    pending: [],
    threads: saved.threads ?? [],
    remaining: 25,
    items: new Map(),
  };
  const through = saved.through ?? Date.now();
  const query = `after:${localDay(source.since - 24 * 60 * 60 * 1000)}`;
  let page = saved.page ?? 1,
    complete = saved.complete ?? false;
  await readSlackMessages(
    slack,
    session,
    source,
    owner,
    saved.pending ?? [],
    state
  );
  for (
    let scanned = 0;
    scanned < WATCH_PAGES &&
    !complete &&
    state.remaining > 0 &&
    !state.pending.length;
    scanned += 1
  ) {
    const response = (await slack.messages(
      session,
      [
        "search",
        "messages",
        "--limit=100",
        `--page=${page}`,
        "--sort=timestamp",
        "--sort-dir=asc",
        "--",
        query,
      ],
      source.signal
    )) as { matches?: SlackMessage[]; pages?: number };
    // A search gives every channel's messages; only the selected ones, which intake records, belong in the audit.
    source.record?.("raw", {
      query,
      page,
      matches: response.matches?.length ?? 0,
      pages: response.pages ?? 1,
    });
    await readSlackMessages(
      slack,
      session,
      source,
      owner,
      response.matches ?? [],
      state
    );
    if (page >= (response.pages ?? 1)) {
      complete = true;
      break;
    }
    page += 1;
  }
  await readSlackThreads(slack, session, source, owner, state);
  const resolved = Object.fromEntries(
    Object.entries(state.resolved).filter(
      ([, value]) => value.at >= source.since - 24 * 60 * 60 * 1000
    )
  );
  const covered = complete && !state.pending.length && !state.threads.length;
  source.checkpoint?.save({
    page: covered ? undefined : page,
    complete: covered ? undefined : complete,
    through: covered ? undefined : through,
    roots: [...state.roots],
    resolved,
    pending: state.pending,
    threads: state.threads,
  });
  source.record?.("coverage", {
    complete: covered,
    ...(covered
      ? { through }
      : { reason: "Slack page or thread lookup budget" }),
  });
  source.record?.("filter", {
    kept: state.items.size,
    followedThreads: state.roots.size,
    pending: state.pending.length,
    threadReads: state.threads.length,
  });
  return [...state.items.values()];
}

/** The workspace that slackcli uses with a session: its default, or its only one. */
function workspaceOf(session: string): SlackWorkspace | undefined {
  const credentials = JSON.parse(session) as SlackWorkspaces;
  const choices = Object.values(credentials.workspaces);
  if (credentials.default_workspace) {
    return credentials.workspaces[credentials.default_workspace];
  }
  return choices.length === 1 ? choices[0] : undefined;
}

async function readSlackMessages(
  slack: SlackCli,
  session: string,
  source: WatchSource,
  owner: SlackOwner,
  messages: SlackMessage[],
  state: SlackWatchState
): Promise<void> {
  // Discover participation first, so an earlier untagged reply in this page is included too.
  const ordered = messages.toSorted(
    (a, b) =>
      Number(personalSlackMessage(b, owner)) -
      Number(personalSlackMessage(a, owner))
  );
  for (const message of ordered) {
    if (!message.text.trim() || Number(message.ts) * 1000 < source.since) {
      continue;
    }
    const direct = message.channel.is_im || message.channel.is_mpim;
    const personal = personalSlackMessage(message, owner);
    const followedChannel = [...state.roots].some((root) =>
      root.startsWith(`${message.channel.id}/`)
    );
    if (!(direct || personal || followedChannel)) {
      continue;
    }
    const resolved = direct
      ? message
      : await resolveSlackMessage(
          slack,
          session,
          source,
          owner,
          message,
          state
        );
    if (!resolved) {
      continue;
    }
    const item = observedSlackMessage(resolved, owner, state.roots);
    if (item) {
      state.items.set(item.id, item);
    }
  }
}

async function resolveSlackMessage(
  slack: SlackCli,
  session: string,
  source: WatchSource,
  owner: SlackOwner,
  message: SlackMessage,
  state: SlackWatchState
): Promise<SlackMessage | undefined> {
  const key = `${message.channel.id}/${message.ts}`;
  let root =
    message.thread_ts ??
    new URL(message.permalink).searchParams.get("thread_ts") ??
    state.resolved[key]?.root;
  if (!root) {
    if (!state.remaining) {
      state.pending.push(message);
      return undefined;
    }
    state.remaining -= 1;
    try {
      const response = (await slack.run(
        session,
        [
          "conversations",
          "get",
          "--fields=ts,thread_ts",
          `--permalink=${message.permalink}`,
        ],
        source.signal
      )) as { message: { ts: string; thread_ts?: string } };
      source.record?.("raw", { tool: "get", id: key, response });
      root = response.message.thread_ts ?? response.message.ts;
      state.resolved[key] = { root, at: Number(message.ts) * 1000 };
    } catch (error) {
      source.record?.("lookup.error", { id: key, error: String(error) });
      state.pending.push(message);
      return undefined;
    }
    await Bun.sleep(1500);
  }
  const threadKey = `${message.channel.id}/${root}`;
  if (personalSlackMessage(message, owner) && !state.roots.has(threadKey)) {
    state.roots.add(threadKey);
    state.threads.push({
      message,
      root,
      oldest: String(source.since / 1000 - 0.000_001),
    });
  }
  return { ...message, thread_ts: root };
}

async function readSlackThreads(
  slack: SlackCli,
  session: string,
  source: WatchSource,
  owner: SlackOwner,
  state: SlackWatchState
): Promise<void> {
  const pending: FollowedThread[] = [];
  for (const thread of state.threads) {
    if (!state.remaining) {
      pending.push(thread);
      continue;
    }
    state.remaining -= 1;
    try {
      const response = (await slack.messages(
        session,
        [
          "conversations",
          "read",
          `--thread-ts=${thread.root}`,
          `--oldest=${thread.oldest}`,
          "--limit=100",
          "--",
          thread.message.channel.id,
        ],
        source.signal
      )) as {
        messages?: (Omit<SlackMessage, "channel" | "permalink"> & {
          permalink?: string;
        })[];
        has_more?: boolean;
        next_oldest?: string;
      };
      source.record?.("raw", { tool: "thread", root: thread.root, response });
      for (const message of response.messages ?? []) {
        if (Number(message.ts) * 1000 < source.since) {
          continue;
        }
        const permalink = replyLink(message, thread.message.permalink);
        state.resolved[`${thread.message.channel.id}/${message.ts}`] = {
          root: thread.root,
          at: Number(message.ts) * 1000,
        };
        const item = observedSlackMessage(
          {
            ...message,
            channel: thread.message.channel,
            permalink,
            thread_ts: thread.root,
          },
          owner,
          state.roots
        );
        if (item) {
          state.items.set(item.id, item);
        }
      }
      if (response.has_more) {
        const oldest = response.next_oldest;
        if (!oldest || Number(oldest) <= Number(thread.oldest)) {
          throw new Error("Slack thread pagination did not advance");
        }
        pending.push({ ...thread, oldest });
      }
    } catch (error) {
      source.record?.("lookup.error", {
        root: thread.root,
        error: String(error),
      });
      pending.push(thread);
    }
    await Bun.sleep(1500);
  }
  state.threads = pending;
}

/** The link of a reply; without the workspace's address in the session, from the link of its thread. */
function replyLink(
  reply: { readonly ts: string; readonly permalink?: string },
  rootLink: string
): string {
  return (
    reply.permalink ??
    rootLink.replace(/\/p\d+/, `/p${reply.ts.replace(".", "")}`)
  );
}

function personalSlackMessage(
  message: SlackMessage,
  owner: SlackOwner
): boolean {
  return message.user === owner.id || message.mentions.includes(owner.id);
}

/** The source selection rule, also used when replaying captured Slack records. */
export function observedSlackMessage(
  message: SlackMessage,
  owner: SlackOwner,
  followed: ReadonlySet<string>
): WatchedItem | null {
  const direct = message.channel.is_im === true;
  const groupDirect = message.channel.is_mpim === true;
  const root = message.thread_ts ?? message.ts;
  if (
    !(
      message.text.trim() &&
      (direct ||
        groupDirect ||
        personalSlackMessage(message, owner) ||
        followed.has(`${message.channel.id}/${root}`))
    )
  ) {
    return null;
  }
  let chatName = `#${message.channel.name ?? message.channel.id}`;
  if (direct) {
    chatName = "Direct message";
  }
  if (groupDirect) {
    chatName = "Group direct message";
  }
  return {
    id: `${message.channel.id}/${message.ts}`,
    kind: "message",
    chat:
      direct || groupDirect
        ? message.channel.id
        : `${message.channel.id}/${root}`,
    chatName,
    group: !direct,
    sender: message.user === owner.id ? "" : message.author,
    fromOwner: message.user === owner.id,
    at: Math.floor(Number(message.ts) * 1000),
    text: message.text.replaceAll(`@${owner.name}`, "@me"),
    url: message.permalink ?? null,
  };
}

/**
 * Runs slackcli with a person's session, in a home of its own for each command, so it never uses the sessions of this
 * machine's user. The session is slackcli's `workspaces.json`, which Shadow keeps encrypted.
 */
class SlackCli {
  /**
   * The names of users by workspace and user ID, as the bot's copy keeps them in `slack_user`.
   * shortcut: a name that changes in Slack shows only after a restart, as in the copy; read it again when that matters.
   */
  private readonly names = new Map<string, string>();

  constructor(private readonly binary: string) {}

  /**
   * Runs a command that answers with messages, and gives them in Shadow's form, as the bot's copy has them: each
   * message adds `author`, the name of its user or bot, `mentions`, the user IDs that its text mentions, `time`, and a
   * `permalink`, and its text has names in place of Slack's markup. `blocks` go, as they repeat the text in markup.
   */
  async messages(
    session: string,
    command: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const answer = await this.run(session, command, signal);
    const { found, listed } = messagesIn(answer);
    const ids = found.flatMap(({ message }) => [
      ...(typeof message.user === "string" ? [message.user] : []),
      ...slackMentions(message.text as string),
    ]);
    const names = await this.namesOf(
      session,
      [...new Set(ids)],
      listed,
      signal
    );
    const workspaceUrl = workspaceOf(session)?.workspace_url;
    for (const { message, channel } of found) {
      inShadowForm(message, channel, names, workspaceUrl);
    }
    return answer;
  }

  /** The person whose session it is. */
  async owner(
    session: string,
    signal: AbortSignal | undefined
  ): Promise<SlackOwner> {
    const id = workspaceOf(session)?.user_id;
    if (!id) {
      throw new Error("The Slack session has no user identity");
    }
    const names = await this.namesOf(session, [id], new Map(), signal);
    return { id, name: names.get(id)! };
  }

  /**
   * The names of users: known ones, then those that an answer lists, then users.info, as the bot's copy asks it, for
   * at most `LOOKUPS` users; a user whose lookup fails or waits keeps their ID.
   */
  private async namesOf(
    session: string,
    ids: readonly string[],
    listed: ReadonlyMap<string, string>,
    signal: AbortSignal | undefined
  ): Promise<Map<string, string>> {
    const workspace = workspaceOf(session)?.workspace_id ?? "";
    const names = new Map<string, string>();
    const unknown: string[] = [];
    for (const id of ids) {
      const name = this.names.get(`${workspace}/${id}`) ?? listed.get(id);
      if (name) {
        names.set(id, name);
        this.names.set(`${workspace}/${id}`, name);
      } else {
        unknown.push(id);
      }
    }
    await Promise.all(
      unknown.map(async (id, index) => {
        let name = id;
        if (index < LOOKUPS) {
          try {
            const user = (await this.run(
              session,
              ["users", "info", "--", id],
              signal
            )) as SlackUser;
            name = slackPersonName(user, id);
            this.names.set(`${workspace}/${id}`, name);
          } catch {
            // The ID stays; another answer looks the user up again.
          }
        }
        names.set(id, name);
      })
    );
    return names;
  }

  /** Signs in with the cURL command of a request of Slack's web app; gives the session and the workspace's name. */
  signIn(curl: string): Promise<{ secret: string; label: string }> {
    return this.inHome(async (home) => {
      await this.spawn(
        ["auth", "parse-curl", "--login", "--secret-backend", "file"],
        home,
        undefined,
        curl
      );
      const secret = readFileSync(workspacesOf(home), "utf8");
      const [workspace] = Object.values(
        (JSON.parse(secret) as SlackWorkspaces).workspaces
      );
      return { secret, label: workspace?.workspace_name ?? "Slack" };
    });
  }

  /** Runs a command with `--json` and the session, and returns its JSON answer. */
  run(
    session: string,
    command: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    return this.inHome(async (home) => {
      writeFileSync(workspacesOf(home), session, { mode: 0o600 });
      const end = command.indexOf("--");
      const flags = end === -1 ? command : command.slice(0, end);
      const output = await this.spawn(
        [...flags, "--json", ...(end === -1 ? [] : command.slice(end))],
        home,
        signal
      );
      return output.trim() ? JSON.parse(output) : { done: true };
    });
  }

  private async spawn(
    command: readonly string[],
    home: string,
    signal: AbortSignal | undefined,
    input?: string
  ): Promise<string> {
    const {
      SLACKCLI_WORKSPACE: _workspace,
      SLACKCLI_TOKEN: _token,
      SLACK_BOT_TOKEN: _bot,
      ...env
    } = Bun.env;
    const process = Bun.spawn([this.binary, ...command], {
      env: {
        ...env,
        HOME: home,
        SLACKCLI_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: RUN_MS,
      ...(signal ? { signal } : {}),
    });
    const [output, errors, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        failure(errors) ?? `Slack failed (slackcli exited with ${code})`
      );
    }
    return output;
  }

  /** Runs `use` with a new home, only for this machine's user, and removes the home after. */
  private async inHome<Result>(
    use: (home: string) => Promise<Result>
  ): Promise<Result> {
    const home = mkdtempSync(join(tmpdir(), "shadow-slack-"));
    try {
      mkdirSync(join(workspacesOf(home), ".."), {
        recursive: true,
        mode: 0o700,
      });
      return await use(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

interface FoundMessage {
  readonly message: Record<string, unknown>;
  readonly channel: string | undefined;
}

/** The messages of a slackcli answer, each with its channel, and the names of the users that the answer lists. */
function messagesIn(answer: unknown): {
  found: FoundMessage[];
  listed: Map<string, string>;
} {
  const found: FoundMessage[] = [];
  const listed = new Map<string, string>();
  const walk = (value: unknown, channel: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const each of value) {
        walk(each, channel);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const object = value as Record<string, unknown>;
    const here = channelOf(object) ?? channel;
    if (
      object.type === "message" &&
      typeof object.ts === "string" &&
      typeof object.text === "string"
    ) {
      found.push({ message: object, channel: here });
    }
    if (Array.isArray(object.users)) {
      listNames(object.users as SlackUser[], listed);
    }
    for (const child of Object.values(object)) {
      walk(child, here);
    }
  };
  walk(answer, undefined);
  return { found, listed };
}

/** The names of the users that an answer lists; it is the name that users.info gives only with a real name. */
function listNames(
  users: readonly SlackUser[],
  listed: Map<string, string>
): void {
  for (const user of users) {
    if (user.id && user.real_name) {
      listed.set(user.id, slackPersonName(user, user.id));
    }
  }
}

/** The channel of a message, a conversation, or a thread of an answer. */
function channelOf(object: Record<string, unknown>): string | undefined {
  return [
    (object.channel as { id?: unknown } | undefined)?.id,
    object.channel_id,
    object.id,
  ].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && CHANNEL.test(candidate)
  );
}

/** Puts a message of an answer in Shadow's form; see `SlackCli.messages`. */
function inShadowForm(
  message: Record<string, unknown>,
  channel: string | undefined,
  names: ReadonlyMap<string, string>,
  workspaceUrl: string | undefined
): void {
  const ts = message.ts as string;
  const text = message.text as string;
  const bot = message.bot_profile as { name?: string } | undefined;
  // A bot's message has no user, as in the copy.
  message.author =
    typeof message.user === "string"
      ? names.get(message.user)
      : String(message.username ?? bot?.name ?? "Slack");
  message.mentions = slackMentions(text);
  message.text = slackMarkdown(text, names);
  message.time = slackTime(ts);
  if (typeof message.permalink !== "string" && workspaceUrl && channel) {
    message.permalink = slackPermalink(
      workspaceUrl,
      channel,
      ts,
      message.thread_ts as string | undefined
    );
  }
  Reflect.deleteProperty(message, "blocks");
}

/** Where slackcli keeps its sessions in a home. */
function workspacesOf(home: string): string {
  return join(home, ".config", "slackcli", "workspaces.json");
}

interface SlackWorkspaces {
  readonly default_workspace?: string;
  readonly workspaces: Record<string, SlackWorkspace>;
}
interface SlackWorkspace {
  readonly workspace_id?: string;
  readonly workspace_name?: string;
  /** Such as https://acme.slack.com, for a session of the browser. */
  readonly workspace_url?: string;
  readonly user_id?: string;
}

/**
 * The error that slackcli wrote: the `message` of the JSON line of a `--json` command, else the lines from `Error:` to
 * the first empty one.
 */
export function failure(errors: string): string | undefined {
  const lines = errors.split("\n");
  for (const line of lines.toReversed()) {
    try {
      const message = (JSON.parse(line) as { error?: { message?: string } })
        .error?.message;
      if (message) {
        return message;
      }
    } catch {
      // Not the JSON line.
    }
  }
  const start = lines.findIndex((line) => line.includes("Error:"));
  if (start === -1) {
    return undefined;
  }
  const end = lines.indexOf("", start);
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .join(" ")
    .replace(/^.*?Error:\s*/, "");
}

/** A tool that runs one slackcli command with the session of the call's account. */
function slackTool<Parameters extends TSchema>(
  slack: SlackCli,
  tool: {
    name: string;
    description: string;
    parameters: Parameters;
    command: (args: Static<Parameters>) => string[];
    /** Whether it answers with messages, which it gives in Shadow's form. */
    messages?: boolean;
  }
): ConnectorTool<Parameters> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args, session, signal) =>
      tool.messages
        ? slack.messages(session, tool.command(args), signal)
        : slack.run(session, tool.command(args), signal),
  };
}

/** A flag with its value in one argument, so a value that starts with `-` stays a value. */
function option(flag: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`--${flag}=${value}`];
}
