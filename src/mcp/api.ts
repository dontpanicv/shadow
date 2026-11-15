import { createHash, randomUUID } from "node:crypto";
import {
  type Static,
  type ToolCall,
  type TSchema,
  Type,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { json, type Route, type RouteInput } from "../app/http.ts";
import type { Artifact } from "../artifacts/artifacts.ts";
import type { Channel, Company, ThreadRef } from "../companies/companies.ts";
import { MCP_SCOPES, mcpUrl, oauthUser, type User } from "../platform/auth.ts";
import { localTime } from "../platform/time.ts";
import type { ThreadMessages } from "../threads/threads.ts";

/** How long `ask` waits for the agent's answer; then it says where the answer will come. */
const ASK_WAIT = 10 * 60_000;
/** The most text that `read_thread` gives, from the newest message back. */
const MAX_THREAD_TEXT = 100_000;
/** The largest file that `read_file` gives. */
const MAX_FILE = 20 * 1024 ** 2;
/** The longest a command on the work computer runs. */
const MAX_COMMAND = 14 * 60_000;

const INSTRUCTIONS = `Shadow is your company's AI agent and second brain. It reads the company's Slack and your mail, keeps channels with threads, files, and artifacts, and has your own orchestrator, which knows your work and does everything Shadow's agents can do: research, connectors such as mail and calendar, routines, reminders, the browser, and your work computer. Use ask to give Shadow work or a question; use the other tools to read and change what Shadow keeps. Everything happens as you, and you see only what you see in Shadow.`;

/**
 * Shadow's MCP server, for the agents that people run themselves, such as Claude Code or Codex. They sign in as the
 * person with OAuth (better-auth's OAuth provider, see `platform/auth.ts`), and every tool works as that person does
 * in the web app.
 */
export const mcpApiRoutes: readonly Route[] = [
  ["GET", "/.well-known/oauth-protected-resource", resourceMetadata],
  ["GET", "/.well-known/oauth-protected-resource/mcp", resourceMetadata],
  ["*", "/mcp", serve],
];

/** RFC 9728: where an MCP client signs in for `/mcp`. */
async function resourceMetadata({ app }: RouteInput): Promise<Response> {
  const { baseUrl } = app.config;
  return json({
    resource: mcpUrl(baseUrl),
    authorization_servers: [`${baseUrl}/api/auth`],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Shadow",
  });
}

/** One stateless MCP exchange: each request gets its own server for the person of its token. */
async function serve({ app, request }: RouteInput): Promise<Response> {
  const user = await oauthUser(app.auth, request, app.config.allowedEmails);
  if (!user) {
    return new Response(JSON.stringify({ error: "Sign in first" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${app.config.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      },
    });
  }
  const [company] = app.companies.list(user);
  if (!company) {
    return json({ error: "An admin must add you to the company first" }, 403);
  }
  const server = mcpServer(app, user, company);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(request);
}

type App = RouteInput["app"];

interface McpTool<Parameters extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters;
  readonly readOnly?: boolean;
  readonly run: (args: Static<Parameters>) => Promise<CallToolResult>;
}

/** Infers a tool's arguments from its parameters. */
function tool<Parameters extends TSchema>(
  definition: McpTool<Parameters>
): McpTool {
  return definition as unknown as McpTool;
}

function mcpServer(app: App, user: User, company: Company): Server {
  const tools = mcpTools(app, user, company);
  const server = new Server(
    { name: "shadow", title: "Shadow", version: "1" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters as { type: "object" },
      annotations: { readOnlyHint: definition.readOnly === true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const definition = tools.find(
      (candidate) => candidate.name === params.name
    );
    if (!definition) {
      return failure(`There is no tool ${params.name}.`);
    }
    try {
      const args = validateToolArguments(definition, {
        type: "toolCall",
        id: randomUUID(),
        name: definition.name,
        arguments: (params.arguments ?? {}) as ToolCall["arguments"],
      });
      return await definition.run(args);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  });
  return server;
}

const channelParameter = Type.String({
  description: "A channel's name, with or without #, as list_channels gives it",
});
const visibility = Type.Optional(
  Type.Union([Type.Literal("members"), Type.Literal("public")], {
    description:
      "members: only members of the company, signed in (default). public: anyone with the link.",
  })
);

/** The tools of one person; each one checks what the person sees, as the web app's routes do. */
function mcpTools(app: App, user: User, company: Company): McpTool[] {
  const channelNamed = (name: string): Channel => {
    const bare = name.trim().replace(/^#/, "");
    const channel = app.companies
      .channels(company.id, user)
      .find((candidate) => candidate.name === bare);
    if (!channel) {
      throw new Error(
        `There is no channel #${bare}. list_channels shows the channels.`
      );
    }
    return channel;
  };
  // Without a channel, the person's own channel, where their orchestrator keeps its files and artifacts.
  const placeOf = (channel: string | undefined) =>
    channel === undefined
      ? app.companies.personalChannelOf(company.id, user).id
      : channelNamed(channel).id;
  return [
    tool({
      name: "ask",
      description:
        "Give Shadow work or a question and wait for its answer, up to 10 minutes. By default it goes to your own orchestrator, which knows your work and does everything Shadow's agents can do; with thread_id it goes to that thread's agent; with channel it starts a new thread there. When the agent needs your approval to act as you, the answer lists the approval for the approve tool.",
      parameters: Type.Object({
        text: Type.String({ description: "Your message to Shadow" }),
        thread_id: Type.Optional(
          Type.String({ description: "A thread to send the message to" })
        ),
        channel: Type.Optional(channelParameter),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "Wait for the answer (default true); false sends the message and returns at once",
          })
        ),
      }),
      run: async ({ text, thread_id, channel, wait }) => {
        if (thread_id && channel) {
          throw new Error("Give thread_id or channel, not both.");
        }
        let thread: ThreadRef;
        let before = 0;
        if (channel) {
          const started = await app.threads.create(
            company.id,
            user,
            channelNamed(channel).id,
            text
          );
          thread = app.companies.thread(started.id, user);
        } else {
          thread = thread_id
            ? app.companies.thread(thread_id, user)
            : await app.threads.orchestrator(company.id, user);
          before = (await app.threads.messages(thread)).messages.length;
          await app.threads.send(thread.id, user, text);
        }
        if (wait === false) {
          return success(
            `Sent. Thread ${thread.id}; read_thread shows the answer.`
          );
        }
        const { state, done } = await answerOf(app, thread, before);
        return success(answerText(thread.id, state, before, done));
      },
    }),
    tool({
      name: "approve",
      description:
        "Allow or deny an action that a Shadow agent waits for you to allow, such as sending a message as you. ask and read_thread list the approvals.",
      parameters: Type.Object({
        thread_id: Type.String(),
        approval_id: Type.String(),
        allow: Type.Boolean(),
      }),
      run: async ({ thread_id, approval_id, allow }) => {
        app.threads.answerApproval(thread_id, approval_id, user, allow);
        return success(allow ? "Allowed." : "Denied.");
      },
    }),
    tool({
      name: "list_channels",
      description:
        "List the channels you see in Shadow: those of the company's Slack, and your private ones.",
      parameters: Type.Object({}),
      readOnly: true,
      run: async () =>
        success(
          app.companies
            .channels(company.id, user)
            .map(
              (channel) =>
                `#${channel.name}${channel.ownerId ? " (private)" : ""}`
            )
            .join("\n")
        ),
    }),
    tool({
      name: "list_threads",
      description:
        "List the threads of the channels you see, newest activity first by default.",
      parameters: Type.Object({
        channel: Type.Optional(channelParameter),
        since: Type.Optional(
          Type.String({
            description:
              "Last activity at or after this date, as YYYY-MM-DD, or a time with its offset",
          })
        ),
        before: Type.Optional(
          Type.String({ description: "Last activity before this date or time" })
        ),
        order: Type.Optional(
          Type.Union([Type.Literal("newest"), Type.Literal("oldest")])
        ),
        limit: Type.Optional(
          Type.Number({ description: "At most this many; default 50" })
        ),
      }),
      readOnly: true,
      run: async ({ limit, ...options }) => {
        const threads = app.threads
          .list(company.id, user, options)
          .slice(0, Math.max(1, limit ?? 50));
        return success(
          threads
            .map(
              (thread) =>
                `- ${thread.title} (thread ${thread.id}) in #${thread.channel}, ${localTime(thread.updatedAt)}, ${thread.settledAt === null ? "open" : "settled"}`
            )
            .join("\n") || "No threads match."
        );
      },
    }),
    tool({
      name: "read_thread",
      description:
        "Read a thread's messages, and what its agent waits for you to allow. Without thread_id, your own orchestrator's.",
      parameters: Type.Object({
        thread_id: Type.Optional(Type.String()),
      }),
      readOnly: true,
      run: async ({ thread_id }) => {
        const thread = thread_id
          ? app.companies.thread(thread_id, user)
          : await app.threads.orchestrator(company.id, user);
        const state = await app.threads.messages(thread);
        return success(
          threadText(thread.id, state, 0, state.running ? "working" : "idle")
        );
      },
    }),
    tool({
      name: "search",
      description:
        "Search what Shadow keeps that you see: threads, files, notes, artifacts, and Slack. Each result names its thread or file.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(
          Type.Number({ description: "1 to 50; default 20" })
        ),
      }),
      readOnly: true,
      run: async ({ query, limit }) => {
        const { results } = await app.indexer.search(
          company.id,
          query,
          Math.min(Math.max(limit ?? 20, 1), 50),
          user.id
        );
        return success(
          results
            .map(
              (result) =>
                `## ${result.title}\n${result.kind} ${result.uri}${result.threadId ? `, thread ${result.threadId}` : ""}, ${localTime(result.updatedAt)}\n${result.snippet}`
            )
            .join("\n\n") || "Nothing matches."
        );
      },
    }),
    tool({
      name: "list_files",
      description:
        "List the files of a channel, or without channel, those of your own channel, where your orchestrator keeps its files.",
      parameters: Type.Object({ channel: Type.Optional(channelParameter) }),
      readOnly: true,
      run: async ({ channel }) => {
        const files = await app.threads.files(
          app.threads.place(company.id, placeOf(channel), user)
        );
        return success(
          files
            .map(
              (file) =>
                `- ${file.name} (file ${file.id}, ${file.size} bytes, ${localTime(file.time)})`
            )
            .join("\n") || "No files."
        );
      },
    }),
    tool({
      name: "read_file",
      description:
        "Read a file you see in Shadow by its id: text as text, a picture as a picture, other files as their bytes.",
      parameters: Type.Object({ file_id: Type.String() }),
      readOnly: true,
      run: async ({ file_id }) => {
        const { path, name } = await app.threads.file(
          company.id,
          user,
          file_id
        );
        const file = Bun.file(path);
        if (file.size > MAX_FILE) {
          throw new Error(
            `${name} has ${file.size} bytes, more than ${MAX_FILE}.`
          );
        }
        const type = file.type.split(";")[0]!;
        if (/^text\/|\/json$|\/xml$|\/javascript$/.test(type)) {
          return success(await file.text());
        }
        const data = (await file.bytes()).toBase64();
        return {
          content: [
            type.startsWith("image/")
              ? { type: "image", data, mimeType: type }
              : {
                  type: "resource",
                  resource: {
                    uri: `${app.config.baseUrl}/api/v1/companies/${company.id}/files/${file_id}`,
                    mimeType: type,
                    blob: data,
                  },
                },
          ],
        };
      },
    }),
    tool({
      name: "save_file",
      description:
        "Save a file to a channel, or without channel, to your own channel. Give text, or the bytes as base64.",
      parameters: Type.Object({
        name: Type.String({ description: "The file name, such as notes.md" }),
        text: Type.Optional(Type.String()),
        base64: Type.Optional(Type.String()),
        channel: Type.Optional(channelParameter),
      }),
      run: async ({ name, text, base64, channel }) => {
        if ((text === undefined) === (base64 === undefined)) {
          throw new Error("Give text or base64.");
        }
        const files = await app.threads.upload(
          company.id,
          placeOf(channel),
          user,
          [new File([text ?? Uint8Array.fromBase64(base64!)], name)]
        );
        const saved = files.findLast((file) => file.name === name);
        return success(`Saved ${name} as file ${saved?.id}.`);
      },
    }),
    tool({
      name: "list_artifacts",
      description:
        "List the artifacts you see, newest first: the pages and small apps that Shadow made. With channel, only that channel's.",
      parameters: Type.Object({ channel: Type.Optional(channelParameter) }),
      readOnly: true,
      run: async ({ channel }) => {
        const artifacts =
          channel === undefined
            ? app.artifacts.inCompany(company.id, user.id)
            : app.artifacts.inPlace(company.id, placeOf(channel), user);
        return success(
          artifacts.map(artifactLine).join("\n") || "No artifacts."
        );
      },
    }),
    tool({
      name: "read_artifact",
      description: "Read an artifact's HTML and the data its visitors keep.",
      parameters: Type.Object({ artifact_id: Type.String() }),
      readOnly: true,
      run: async ({ artifact_id }) => {
        const artifact = app.artifacts.get(artifact_id, user);
        const records = app.artifacts.dataFor(artifact.id, user);
        return success(
          `${artifactLine(artifact)}\n\n## HTML\n${app.artifacts.html(artifact.id)}\n\n## Data\n${JSON.stringify(records, null, 1)}`
        );
      },
    }),
    tool({
      name: "create_artifact",
      description: `Make an artifact in a channel, or without channel, in your own channel, and get its link. ${app.artifacts.runtime}`,
      parameters: Type.Object({
        title: Type.String({
          description: "A short title; link previews show it",
        }),
        html: Type.String({ description: "The whole HTML document" }),
        visibility,
        channel: Type.Optional(channelParameter),
      }),
      run: async ({ channel, ...input }) => {
        const artifact = app.artifacts.create(
          await app.threads.orchestrator(company.id, user),
          placeOf(channel),
          { ...input, requestKey: randomUUID() }
        );
        return success(`Made the artifact.\n${artifactLine(artifact)}`);
      },
    }),
    tool({
      name: "update_artifact",
      description:
        "Replace an artifact's HTML, title, or visibility. Its data stays, so read it first when you change how the page stores it.",
      parameters: Type.Object({
        artifact_id: Type.String(),
        title: Type.Optional(Type.String()),
        html: Type.Optional(Type.String()),
        visibility,
      }),
      run: async ({ artifact_id, ...changes }) => {
        const artifact = app.artifacts.get(artifact_id, user);
        return success(
          `Changed the artifact.\n${artifactLine(app.artifacts.update(company.id, artifact.id, changes))}`
        );
      },
    }),
    tool({
      name: "computer_run",
      description:
        "Run a zsh command on Shadow's one macOS work computer, a VM with Homebrew, Python, Node.js, LibreOffice, pandoc, ffmpeg, and more. Every Shadow agent and MCP client shares it and can read its files, and sudo needs no password, so put nothing secret there. The command runs in your own work folder, which keeps its files between calls; files copies Shadow files into it first. The computer starts on the first call, which can take a minute. Save a result with save_file, such as from the output of base64.",
      parameters: Type.Object({
        command: Type.String({
          description: "A zsh command, run in your work folder",
        }),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Ids of Shadow files to copy into the work folder first",
          })
        ),
        timeout_ms: Type.Optional(
          Type.Number({
            description: `The longest the command runs; 300000 by default, ${MAX_COMMAND} at most`,
          })
        ),
      }),
      run: async ({ command, files, timeout_ms }) => {
        const copied = await Promise.all(
          (files ?? []).map((fileId) =>
            app.threads.file(company.id, user, fileId)
          )
        );
        return success(
          await app.computer.shell(
            workFolder(company.id, user.id),
            command,
            copied,
            Math.min(timeout_ms ?? 5 * 60_000, MAX_COMMAND)
          )
        );
      },
    }),
  ];
}

/**
 * Waits until the agent answers what came after the first `before` messages, needs an approval, or `ASK_WAIT` ends.
 */
async function answerOf(
  app: App,
  thread: ThreadRef,
  before: number
): Promise<{ state: ThreadMessages; done: Done }> {
  let finish: (done: Done) => void = () => undefined;
  let latest: ThreadMessages | undefined;
  const result = new Promise<{ state: ThreadMessages; done: Done }>(
    (resolve) => {
      finish = (done) => {
        if (latest) {
          resolve({ state: latest, done });
        }
      };
    }
  );
  const timer = setTimeout(() => finish("working"), ASK_WAIT);
  const stop = await app.threads.watch(thread, (state) => {
    latest = state;
    if (state.approvals.length > 0) {
      finish("waiting");
    } else if (
      !state.running &&
      state.messages
        .slice(before)
        .some((message) => message.agent && !message.streaming)
    ) {
      finish("answered");
    }
  });
  try {
    return await result;
  } finally {
    clearTimeout(timer);
    await stop();
  }
}

type Done = "answered" | "waiting" | "working";

function answerText(
  threadId: string,
  state: ThreadMessages,
  before: number,
  done: Done
): string {
  const answer = state.messages
    .slice(before)
    .filter((message) => message.agent)
    .map((message) => message.text)
    .join("\n\n");
  return threadText(threadId, { ...state, messages: [] }, 0, done).replace(
    /^/,
    answer ? `${answer}\n\n` : ""
  );
}

/** A thread as text: its newest messages within `MAX_THREAD_TEXT`, its state, and its approvals. */
function threadText(
  threadId: string,
  state: ThreadMessages,
  from: number,
  done: Done | "idle"
): string {
  const lines: string[] = [];
  let size = 0;
  for (const message of state.messages.slice(from).toReversed()) {
    const line = `**${message.author}** (${localTime(message.time)}${message.failed ? ", failed" : ""}):\n${message.text}${message.files.map((file) => `\n[file ${file.id}: ${file.name}]`).join("")}`;
    size += line.length;
    if (size > MAX_THREAD_TEXT) {
      lines.push("(Older messages are left out.)");
      break;
    }
    lines.push(line);
  }
  const status = {
    answered: "",
    idle: "",
    working: "The agent still works; read_thread shows its answer later.",
    waiting: "The agent waits for you to allow an action.",
  }[done];
  return [
    ...lines.toReversed(),
    `Thread ${threadId}.${status ? ` ${status}` : ""}`,
    ...state.approvals.map(
      (approval) =>
        `Approval ${approval.id}: ${approval.text} (approve with thread_id ${threadId})`
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The person's own folder on the shared work computer: `mcp-` and a hash, which a shell command takes as it is. */
function workFolder(companyId: string, userId: string): string {
  return `mcp-${createHash("sha256").update(`${companyId}-${userId}`).digest("hex").slice(0, 16)}`;
}

function artifactLine(artifact: Artifact): string {
  return `- ${artifact.title} (artifact ${artifact.id}, ${artifact.visibility}): ${artifact.url}`;
}

function success(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
