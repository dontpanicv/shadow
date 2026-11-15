import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Context,
  Message,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  defineTool,
} from "@earendil-works/pi-durable";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import { Browser } from "../browser/browser.ts";
import type { ThreadRef } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { Egress } from "../platform/egress.ts";
import { Memory } from "./memory.ts";
import {
  emojiOf,
  scriptWithDeadline,
  type ThreadBrowser,
  type ThreadHooks,
  type ThreadIntegrations,
  type ThreadMessages,
  type ThreadSources,
  Threads,
  threadMessages,
} from "./threads.ts";

let shadow: TestApp;
let alice: User;
let bob: User;
/** What each tool returned to the agent, in order. */
const toolResults: string[] = [];
/** The memory views that the orchestrator's compactions gave the agent. */
const memoryViews: string[] = [];
/** The system prompts of the agents' requests. */
const systemPrompts: string[] = [];
/** The names of the tools offered to the model, for each request of an agent. */
const offeredTools: string[][] = [];
/** The user messages as the model receives them. */
const agentInputs: string[] = [];
/** A turn that waits in a tool call until `release`, then records whose turn it is. */
const held = {
  release: undefined as (() => void) | undefined,
  companyId: "",
  conversationId: undefined as ConversationId | undefined,
  requesters: [] as (string | undefined)[],
};

beforeAll(async () => {
  shadow = await startTestApp();
  alice = await person("Alice", "alice@example.com");
  bob = await person("Bob", "bob@example.com");
  // Threads run at the same time, so the model answers from what its conversation shows, not from a fixed order.
  // The memory and the channel briefs ask the model in the background too.
  shadow.faux.setResponses(Array.from({ length: 300 }, () => agent));
});
afterAll(() => shadow.close());

async function person(name: string, email: string): Promise<User> {
  await shadow.signIn(name, email);
  const { internalAdapter } = await shadow.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(email))!;
  return { id: user.id, name: user.name, email: user.email };
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

/** The tools a request offers the model: its system messages add and remove them in order. */
function offeredIn(context: Context): string[] {
  const offered = new Set<string>();
  for (const message of context.messages as {
    toolsAdded?: { name: string }[];
    toolsRemoved?: { name: string }[];
  }[]) {
    for (const tool of message.toolsAdded ?? []) {
      offered.add(tool.name);
    }
    for (const tool of message.toolsRemoved ?? []) {
      offered.delete(tool.name);
    }
  }
  return [...offered];
}

/** A scripted agent: one tool call for each request it knows, then a short answer after the tool result. */
function agent(context: Context, options?: SimpleStreamOptions) {
  const system = [
    context.systemPrompt ?? "",
    ...context.messages
      .filter((message) => (message.role as string) === "system")
      .flatMap((message) => [
        textOf(message),
        ...Object.values(
          (message as { sections?: Record<string, string | null> }).sections ??
            {}
        ).map((section) => section ?? ""),
      ]),
  ].join("\n");
  if (system.includes("You keep the brief")) {
    return fauxAssistantMessage(
      `<summary>What the company eats.</summary><brief>## Now\n- Pasta tonight ${/\[[^\]]*\]\(thread:[\w-]+\)/.exec(textOf(context.messages.at(-1)!))![0]}</brief>`
    );
  }
  if (system.includes("You are the learning loop")) {
    return fauxAssistantMessage(
      textOf(context.messages.at(-1)!).includes("I am vegetarian")
        ? JSON.stringify({
            about: [{ person: "Alice", text: "Alice is vegetarian" }],
            howto: ["Groceries come from the corner shop"],
            suggest: [
              {
                kind: "routine",
                person: "Alice",
                name: "Morning menu",
                schedule: "0 7 * * *",
                instructions: "Suggest a vegetarian lunch, or stay quiet",
                channel: "food",
              },
              {
                kind: "routine",
                person: "Bob",
                name: "Not for Bob",
                schedule: "0 7 * * *",
                instructions: "Bob wrote nothing here",
              },
            ],
          })
        : "{}"
    );
  }
  systemPrompts.push(system);
  offeredTools.push(offeredIn(context));
  const last = context.messages.findLast(
    (message) => (message.role as string) !== "system"
  )!;
  const text = textOf(last);
  if (last.role === "user") {
    agentInputs.push(text);
  }
  const asked = context.messages.find((message) => message.role === "user");
  if (asked && textOf(asked).endsWith("Delegate and wait")) {
    if (last.role === "user") {
      return Promise.resolve(
        fauxAssistantMessage(
          [
            fauxToolCall("start_thread", {
              channel: "general",
              message: "Take your time",
            }),
          ],
          { stopReason: "toolUse" }
        )
      );
    }
    return new Promise<never>((_, reject) =>
      options?.signal?.addEventListener("abort", () =>
        reject(new Error("Stopped"))
      )
    );
  }
  if (asked && textOf(asked).endsWith("Hold for a voice")) {
    if (last.role === "user" && text.endsWith("Hold for a voice")) {
      return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
        held.release = () =>
          resolve(
            fauxAssistantMessage([fauxToolCall("list_channels", {})], {
              stopReason: "toolUse",
            })
          );
      });
    }
    if (last.role === "toolResult") {
      return shadow.app.threads
        .requester(held.companyId, held.conversationId!)
        .then((requester) => {
          held.requesters.push(requester?.id);
          return fauxAssistantMessage("Done.");
        });
    }
  }
  if (text.endsWith("Take your time")) {
    // Works until someone stops it.
    return new Promise<never>((_, reject) =>
      options?.signal?.addEventListener("abort", () =>
        reject(new Error("Stopped"))
      )
    );
  }
  memoryViews.push(
    ...context.messages
      .map(textOf)
      .filter(
        (message) =>
          message.startsWith(
            "The conversation history before this point was compacted"
          ) || message.startsWith("This is your memory:")
      )
  );
  if (last.role === "toolResult") {
    toolResults.push(text);
    return fauxAssistantMessage("Done.");
  }
  const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const relay = /\]\(thread:([\w-]+)\): (.*)$/s.exec(text);
  if (text.endsWith("Delegate and answer")) {
    return call("start_thread", {
      channel: "general",
      message: "Take your time",
    });
  }
  if (text.endsWith("Ask #food what's for dinner")) {
    return call("start_thread", {
      channel: "food",
      message: "What's for dinner?",
    });
  }
  if (relay?.[2] === "Quiet worker result") {
    return fauxAssistantMessage("QUIET");
  }
  if (relay?.[2] === "What's for dinner?") {
    return call("send_to_thread", { thread: relay[1]!, message: "Pasta" });
  }
  if (relay?.[2] === "Pasta") {
    return call("send_to_thread", {
      thread: relay[1]!,
      message: "With cheese?",
    });
  }
  if (relay?.[2] === "With cheese?") {
    return call("send_to_thread", { thread: relay[1]!, message: "Yes" });
  }
  if (relay?.[2] === "Yes") {
    // A fifth pass would let two agents talk forever.
    return call("send_to_thread", { thread: relay[1]!, message: "Thanks" });
  }
  if (relay?.[2] === "What's for lunch?") {
    return call("send_to_thread", { thread: relay[1]!, message: "Soup" });
  }
  if (relay?.[2] === "Soup") {
    return fauxAssistantMessage("Done.");
  }
  const file =
    /^\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Alice: Read the file\nAttached: .* \(file ([\w-]+)\)$/.exec(
      text
    );
  if (file) {
    return call("read_file", { file: file[1]! });
  }
  const named = /Read file ([\w-]+)$/.exec(text);
  if (named) {
    return call("read_file", { file: named[1]! });
  }
  const channelCommand = /(Create|Search|Merge) channels? (.+)$/.exec(text);
  if (channelCommand) {
    const [, verb, rest] = channelCommand;
    if (verb === "Create") {
      const [name, summary] = rest!.split(": ");
      return call("create_channel", { name: name!, summary: summary! });
    }
    if (verb === "Merge") {
      const [channel, into] = rest!.split(" into ");
      return call("merge_channel", { channel: channel!, into: into! });
    }
    return call("search_channels", { query: rest! });
  }
  if (text.endsWith("Zoom 0")) {
    return fauxAssistantMessage([fauxToolCall("zoom", { id: 0, n: 1 })], {
      stopReason: "toolUse",
    });
  }
  if (text.endsWith("List the channels")) {
    return call("list_channels", {});
  }
  const script = /Run code: (.+)$/s.exec(text);
  if (script) {
    return call("codemode", { code: script[1]! });
  }
  const notify = /Notify (\w+): (.+)$/.exec(text);
  if (notify) {
    return fauxAssistantMessage(
      [fauxToolCall("notify", { text: notify[2]!, to: [notify[1]!] })],
      { stopReason: "toolUse" }
    );
  }
  const move = /Move to #([\w-]+)$/.exec(text);
  if (move) {
    return call("move_thread", { channel: move[1]! });
  }
  const dinner = /Ask thread ([\w-]+) for dinner$/.exec(text);
  if (dinner) {
    return call("send_to_thread", {
      thread: dinner[1]!,
      message: "What's for lunch?",
    });
  }
  const other = /Tell thread ([\w-]+) hi$/.exec(text);
  if (other) {
    return call("send_to_thread", { thread: other[1]!, message: "Hi" });
  }
  const save = /(Save|Delete) (\{.*\})$/.exec(text);
  if (save) {
    return fauxAssistantMessage(
      [
        fauxToolCall(
          save[1] === "Save" ? "save_file" : "delete_file",
          JSON.parse(save[2]!)
        ),
      ],
      { stopReason: "toolUse" }
    );
  }
  return fauxAssistantMessage("Ok.");
}

async function idle(companyId: string, threadId: string) {
  const thread = shadow.app.companies
    .allThreadsIn(companyId)
    .find((candidate) => candidate.id === threadId)!;
  return until(
    () => shadow.app.threads.messages(thread),
    (state) => !state.running && state.messages.at(-1)?.text === "Done."
  );
}

test("an agent starts a thread in another channel, gets the answer back, and cannot keep the exchange going", async () => {
  const inputCount = agentInputs.length;
  const company = await shadow.app.companies.create(alice, "Company");
  const food = shadow.app.companies.addChannel(
    company.id,
    "food",
    alice.id,
    null
  );
  const general = shadow.app.companies
    .channels(company.id, alice)
    .find((channel) => channel.name === "general")!;
  const asked = await shadow.app.threads.create(
    company.id,
    alice,
    general.id,
    "Ask #food what's for dinner"
  );

  const started = await until(
    async () => shadow.app.companies.channels(company.id, alice),
    (channels) =>
      channels.find((channel) => channel.id === food.id)!.threads.length === 1
  );
  const dinner = started.find((channel) => channel.id === food.id)!.threads[0]!;
  expect(dinner.title).toBe("What's for dinner?");

  // What one agent sends another is the first step of the answer's work, not a message of its own.
  const fromThread = (state: ThreadMessages) =>
    state.messages.flatMap((message) =>
      (message.work?.steps ?? [])
        .filter((step) => step.tool === "from_thread")
        .map((step) => [step.text, step.output])
    );
  // The question, then a correction to the answer: the fourth pass still arrives.
  const answered = await until(
    () => idle(company.id, dinner.id),
    (state) => state.messages.length === 2
  );
  expect(answered.messages.map((message) => message.text)).toEqual([
    "Done.",
    "Done.",
  ]);
  expect(answered.messages[0]!.work!.steps[0]!.tool).toBe("from_thread");
  expect(fromThread(answered)).toEqual([
    [`[Ask #food what's for dinner](thread:${asked.id})`, "What's for dinner?"],
    [`[Ask #food what's for dinner](thread:${asked.id})`, "With cheese?"],
  ]);
  await until(
    () => idle(company.id, asked.id),
    (state) =>
      fromThread(state).some(
        ([link, text]) =>
          link === `[What's for dinner?](thread:${dinner.id})` &&
          text === "Pasta"
      )
  );
  await until(
    async () => toolResults,
    (results) => results.some((result) => result.includes("already passed"))
  );
  expect(toolResults).toContainEqual(
    `Started [What's for dinner?](thread:${dinner.id}) in #food.`
  );
  expect(toolResults).toContainEqual(
    `Sent to [Ask #food what's for dinner](thread:${asked.id}).`
  );
  expect(agentInputs.slice(inputCount)).toContainEqual(
    expect.stringMatching(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Alice: Ask #food what's for dinner$/
    )
  );
  expect(agentInputs.slice(inputCount)).toContainEqual(
    expect.stringMatching(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Shadow from \[Ask #food what's for dinner\]\(thread:[\w-]+\): What's for dinner\?$/
    )
  );
  // Alice hears back once in her thread, with the answer to the report: the first answer waited while #food worked.
  const report = (await idle(company.id, asked.id)).messages.at(-1)!;
  await until(
    async () => shadow.app.notifications.inbox(company.id, alice),
    (inbox) =>
      inbox.notifications.some(
        (notification) => notification.createdAt >= report.time
      )
  );
  await Bun.sleep(100);
  expect(
    shadow.app.notifications.inbox(company.id, alice).notifications
  ).toEqual([expect.objectContaining({ threadId: asked.id, text: "Done." })]);
});

test("a thread that reports back leaves the notice to the asker, also for a person who writes in both", async () => {
  const company = await shadow.app.companies.create(alice, "Reporting");
  const food = shadow.app.companies.addChannel(
    company.id,
    "food",
    alice.id,
    null
  );
  const [general] = shadow.app.companies.channels(company.id, alice);
  const list = await shadow.app.threads.create(
    company.id,
    alice,
    food.id,
    "Hello"
  );
  const listed = () =>
    shadow.app.threads.messages(shadow.app.companies.thread(list.id, alice));
  await until(listed, (state) => !state.running && state.messages.length === 2);
  const before = shadow.app.notifications.inbox(
    company.id,
    alice
  ).notifications;
  const asking = await shadow.app.threads.create(
    company.id,
    alice,
    general!.id,
    `Ask thread ${list.id} for dinner`
  );
  await until(listed, (state) => !state.running && state.messages.length === 3);
  // The answer to Alice, then the answer to the report.
  await until(
    () => idle(company.id, asking.id),
    (state) => state.messages.length === 3
  );
  await until(
    async () => shadow.app.notifications.inbox(company.id, alice),
    (inbox) => inbox.notifications.length > before.length
  );
  await Bun.sleep(100);
  const { notifications } = shadow.app.notifications.inbox(company.id, alice);
  expect(notifications.slice(0, -before.length || undefined)).toEqual([
    expect.objectContaining({ threadId: asking.id, text: "Done." }),
  ]);
});

test("an answer waits while the thread it asked works, and notifies when that thread stops without a report", async () => {
  const company = await shadow.app.companies.create(alice, "Waiting");
  const [general] = shadow.app.companies.channels(company.id, alice);
  const asking = await shadow.app.threads.create(
    company.id,
    alice,
    general!.id,
    "Delegate and answer"
  );
  const working = await until(
    async () => shadow.app.companies.channels(company.id, alice)[0]!.threads,
    (threads) => threads.some((thread) => thread.title === "Take your time")
  );
  const asked = working.find((thread) => thread.title === "Take your time")!;
  await until(
    () =>
      shadow.app.threads.messages(
        shadow.app.companies.thread(asking.id, alice)
      ),
    (state) => !state.running && state.messages.length === 2
  );
  await Bun.sleep(100);
  expect(
    shadow.app.notifications.inbox(company.id, alice).notifications
  ).toEqual([]);

  await shadow.app.threads.stop(asked.id, alice);
  const { notifications } = await until(
    async () => shadow.app.notifications.inbox(company.id, alice),
    (inbox) => inbox.notifications.length > 0
  );
  expect(notifications).toEqual([
    expect.objectContaining({ threadId: asking.id, text: "Done." }),
  ]);
});

test("an answer notifies the person who asked unless a screen of theirs shows the thread, and agents and background work notify too", async () => {
  const home = await shadow.app.companies.create(alice, "Notified");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const [general] = shadow.app.companies.channels(home.id, alice);
  const inboxOf = (member: User) =>
    shadow.app.notifications.inbox(home.id, member);
  const asked = await shadow.app.threads.create(
    home.id,
    alice,
    general!.id,
    "Hello"
  );
  const [answered] = (
    await until(
      async () => inboxOf(alice),
      (state) => state.notifications.length === 1
    )
  ).notifications;
  expect(answered).toMatchObject({
    threadId: asked.id,
    channelId: general!.id,
    title: "Hello",
    text: "Ok.",
    readAt: null,
  });

  const unwatch = shadow.app.notifications.watch(alice, asked.id);
  expect(inboxOf(alice).unread).toBe(0);
  await shadow.app.threads.send(
    asked.id,
    alice,
    "Notify Bob: The groceries came"
  );
  const seen = await until(
    async () => inboxOf(alice),
    (state) => state.notifications.length === 2
  );
  unwatch();
  expect(seen.notifications[0]).toMatchObject({ text: "Done." });
  expect(seen.unread).toBe(0);
  expect(inboxOf(bob).notifications).toEqual([
    expect.objectContaining({
      threadId: asked.id,
      text: "The groceries came",
      readAt: null,
    }),
  ]);

  const thread = shadow.app.companies
    .allThreadsIn(home.id)
    .find((candidate) => candidate.id === asked.id)!;
  await shadow.app.threads.instruct(
    thread,
    "Check the mail",
    "mail",
    [bob.id],
    bob.id,
    "routine"
  );
  expect(inboxOf(bob).unread).toBe(2);
  expect(inboxOf(alice).notifications).toHaveLength(2);
  // The task's turn is Bob's, so it uses his own integrations.
  expect(
    await shadow.app.threads.requester(
      home.id,
      thread.conversationId as ConversationId
    )
  ).toMatchObject({ id: bob.id, name: "Bob" });
});

test("an agent lists the channels of its company and cannot reach a thread of another company", async () => {
  const home = await shadow.app.companies.create(alice, "Home");
  const work = await shadow.app.companies.create(bob, "Work");
  const payroll = await shadow.app.threads.create(
    work.id,
    bob,
    shadow.app.companies.channels(work.id, bob)[0]!.id,
    "Payroll"
  );
  const general = shadow.app.companies.channels(home.id, alice)[0]!;

  const listing = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    "List the channels"
  );
  await idle(home.id, listing.id);
  expect(toolResults).toContainEqual(
    expect.stringContaining(
      `#general\n- [List the channels](thread:${listing.id}) (`
    )
  );

  const tell = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    `Tell thread ${payroll.id} hi`
  );
  await idle(home.id, tell.id);
  expect(toolResults).toContainEqual(
    expect.stringContaining(`There is no thread ${payroll.id} in this company.`)
  );
  const untouched = shadow.app.companies.thread(payroll.id, bob);
  expect(
    (await shadow.app.threads.messages(untouched)).messages.map(
      (message) => message.text
    )
  ).toEqual(["Payroll", "Ok."]);
});

/** Posts a multipart form with a bearer token or a session cookie. */
function postForm(
  path: string,
  form: FormData,
  headers: Record<string, string>
) {
  return shadow.handler(
    new Request(`http://shadow.test${path}`, {
      method: "POST",
      headers,
      body: form,
    })
  );
}

test("an agent runs a script that calls its tools, and only the script's output reaches it", async () => {
  const garden = await shadow.app.companies.create(alice, "Garden");
  shadow.app.companies.addChannel(garden.id, "seeds", alice.id, null);
  const general = shadow.app.companies.channels(garden.id, alice)[0]!;

  const run = await shadow.app.threads.create(
    garden.id,
    alice,
    general.id,
    'Run code: const list = await tools.list_channels({}); text(list.split("\\n").filter((line) => line.startsWith("#")).join(", "));'
  );
  await idle(garden.id, run.id);
  expect(toolResults).toContainEqual(
    expect.stringMatching(
      /^Script completed\n.*\nOutput:\n#general, #alice \(private, the person's own\), #seeds$/s
    )
  );
});

test("files attach to a new thread, a message, and the channel; every thread of the channel sees them; others cannot reach them", async () => {
  const token = await shadow.signIn("Alice", "alice@example.com");
  const outsider = await shadow.signIn("Bob", "bob@example.com");
  const home = await shadow.app.companies.create(alice, "Files");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;

  const start = new FormData();
  start.set("channelId", general.id);
  start.set("text", "Read the file");
  start.append("files", new File(["Milk, eggs, bread"], "../shopping.txt"));
  const created = await postForm(
    `/api/v1/companies/${home.id}/threads`,
    start,
    {
      authorization: `Bearer ${token}`,
    }
  );
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  await idle(home.id, id);
  expect(toolResults).toContain("Milk, eggs, bread");

  const filesPath = `/api/v1/companies/${home.id}/channels/${general.id}/files`;
  const filePath = (fileId: string) =>
    `/api/v1/companies/${home.id}/files/${fileId}`;
  const page = new FormData();
  page.append("files", new File(["<script>alert(1)</script>"], "page.html"));
  const uploaded = await postForm(filesPath, page, {
    authorization: `Bearer ${token}`,
  });
  const message = new FormData();
  message.set("text", "");
  message.append("files", new File(["a photo"], "beach.png"));
  // The web app sends a message with its session cookie, from Shadow's own origin.
  const sent = await postForm(`/api/v1/threads/${id}/messages`, message, {
    cookie: await shadow.sessionCookie(token),
    origin: "http://shadow.test",
  });
  expect(sent.status).toBe(204);

  const { files } = (await uploaded.json()) as {
    files: { id: string; name: string }[];
  };
  expect(files.map((file) => file.name)).toEqual(["shopping.txt", "page.html"]);
  const listed = await shadow.call(filesPath, { token });
  expect(
    ((await listed.json()) as { files: { name: string }[] }).files.map(
      (file) => file.name
    )
  ).toEqual(["shopping.txt", "page.html", "beach.png"]);
  const thread = shadow.app.companies.thread(id, alice);
  const { messages } = await shadow.app.threads.messages(thread);
  // The agent may answer the last message meanwhile.
  expect(
    messages.slice(0, 3).map((m) => [m.text, m.files.map((f) => f.name)])
  ).toEqual([
    ["Read the file", ["shopping.txt"]],
    ["Done.", []],
    ["", ["beach.png"]],
  ]);

  const shopping = await shadow.call(filePath(files[0]!.id), {
    token,
  });
  expect(await shopping.text()).toBe("Milk, eggs, bread");
  expect(shopping.headers.get("content-disposition")).toBe(
    "inline; filename*=UTF-8''shopping.txt"
  );
  const html = await shadow.call(filePath(files[1]!.id), { token });
  expect(html.headers.get("content-type")).toBe("application/octet-stream");
  expect(html.headers.get("content-disposition")).toStartWith("attachment");

  // Only a picture has a JPEG for its thumbnail.
  expect(
    (await shadow.call(`${filePath(files[0]!.id)}/picture`, { token })).status
  ).toBe(404);

  for (const path of [
    filesPath,
    filePath(files[0]!.id),
    `${filePath(files[0]!.id)}/picture`,
  ]) {
    expect((await shadow.call(path, { token: outsider })).status).toBe(404);
  }

  const pagePath = filePath(files[1]!.id);
  const refused = await shadow.call(pagePath, {
    token: outsider,
    method: "DELETE",
  });
  expect(refused.status).toBe(404);
  const deleted = await shadow.call(pagePath, { token, method: "DELETE" });
  expect(
    ((await deleted.json()) as { files: { name: string }[] }).files.map(
      (file) => file.name
    )
  ).toEqual(["shopping.txt", "beach.png"]);
  expect((await shadow.call(pagePath, { token })).status).toBe(404);
  // The file moved next to `files/`, where no listing or search looks.
  expect(
    await Array.fromAsync(
      new Bun.Glob(`${files[1]!.id}-*`).scan(
        `${shadow.app.config.dataDirectory}/companies/${thread.companyId}/channels/${general.id}/deleted`
      )
    )
  ).toHaveLength(1);

  // A settled thread leaves its files to the channel, where a new thread reads them.
  shadow.app.companies.setThreadSettled(home.id, id, alice, true);
  await shadow.app.threads.create(home.id, alice, general.id, "Use the list");
  expect(
    (
      await shadow.app.threads.files(
        shadow.app.threads.place(home.id, general.id, alice)
      )
    ).map((file) => file.name)
  ).toEqual(["shopping.txt", "beach.png"]);
});

test("the orchestrator keeps its files in the company, and an agent of any channel reads a file by its id", async () => {
  const home = await shadow.app.companies.create(alice, "Budget");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const orchestrator = await shadow.app.threads.orchestrator(home.id, alice);
  await shadow.app.threads.send(orchestrator.id, alice, "Keep this", [
    new File(["Rent 900"], "budget.txt"),
  ]);
  const [budget] = await shadow.app.threads.files(
    shadow.app.threads.place(home.id, null, alice)
  );
  expect(budget!.name).toBe("budget.txt");
  expect(
    await shadow.app.threads.files(
      shadow.app.threads.place(home.id, general.id, alice)
    )
  ).toEqual([]);
  expect(
    await Bun.file(
      `${shadow.app.config.dataDirectory}/companies/${home.id}/files/${budget!.id}-budget.txt`
    ).text()
  ).toBe("Rent 900");

  const reader = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    `Read file ${budget!.id}`
  );
  await idle(home.id, reader.id);
  expect(toolResults).toContain("Rent 900");
  await until(
    () =>
      shadow.app.threads.messages(
        shadow.app.companies.thread(orchestrator.id, alice)
      ),
    (state) => !state.running
  );
});

test("a composer with no file chosen starts a thread and sends a message", async () => {
  const token = await shadow.signIn("Alice", "alice@example.com");
  const home = await shadow.app.companies.create(alice, "No files");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const cookie = await shadow.sessionCookie(token);
  // What a browser posts for the composer: its empty file field is a part with `filename=""`.
  const post = (path: string, text: string, channelId?: string) =>
    shadow.handler(
      new Request(`http://shadow.test${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: "http://shadow.test",
          "content-type": "multipart/form-data; boundary=X",
        },
        body: `${channelId ? `--X\r\nContent-Disposition: form-data; name="channelId"\r\n\r\n${channelId}\r\n` : ""}--X\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n--X\r\nContent-Disposition: form-data; name="files"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--X--\r\n`,
      })
    );

  const created = await post(
    `/api/v1/companies/${home.id}/threads`,
    "Hello",
    general.id
  );
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  await until(
    () => shadow.app.threads.messages(shadow.app.companies.thread(id, alice)),
    (state) => !state.running && state.messages.length === 2
  );
  const sent = await post(`/api/v1/threads/${id}/messages`, "Thanks");
  expect(sent.status).toBe(204);

  const { messages } = await shadow.app.threads.messages(
    shadow.app.companies.thread(id, alice)
  );
  expect(messages.slice(0, 3).map((m) => [m.text, m.files.length])).toEqual([
    ["Hello", 0],
    ["Ok.", 0],
    ["Thanks", 0],
  ]);
});

test("each run counts its usage once for its person, and the owner alone sees everyone's", async () => {
  const home = await shadow.app.companies.create(alice, "Usage");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const thread = await shadow.app.threads.create(
    home.id,
    bob,
    general.id,
    "Hello"
  );
  const usageOf = (user: User) => shadow.app.llm.usage(home.id, user, 30);
  const counted = await until(
    () => Promise.resolve(usageOf(bob)),
    (report) => report.threads.some((row) => row.threadId === thread.id)
  );
  expect(counted.people).toBeNull();
  expect(counted.sources.map((row) => row.source)).toContain("thread");
  expect(counted.total.input + counted.total.cacheRead).toBeGreaterThan(0);
  expect(counted.days).toHaveLength(1);

  // Counting again without a new run adds nothing.
  const before = usageOf(bob).total;
  await shadow.app.threads.send(thread.id, bob, "Again");
  await until(
    () => Promise.resolve(usageOf(bob).total),
    (total) => total.output > before.output
  );
  const after = usageOf(bob).total;
  (
    shadow.app.threads as unknown as {
      countUsage: (companyId: string, threadId: string) => Promise<void>;
    }
  ).countUsage(home.id, thread.id);
  await Bun.sleep(50);
  expect(usageOf(bob).total).toEqual(after);

  const owner = usageOf(alice);
  expect(owner.people!.map((row) => row.userId)).toContain(bob.id);
  expect(usageOf(alice).threads.length).toBeGreaterThan(0);

  const response = await shadow.call(
    `/api/v1/companies/${home.id}/usage?days=7`,
    {
      token: await shadow.signIn("Bob", "bob@example.com"),
    }
  );
  const body = (await response.json()) as {
    threads: { threadId: string; title: string }[];
    people: unknown;
  };
  expect(body.threads.find((row) => row.threadId === thread.id)?.title).toBe(
    thread.title
  );
  expect(body.people).toBeNull();
});

test("a text message steers its author's running turn", async () => {
  const home = await shadow.app.companies.create(alice, "Steer");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const thread = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    "Hold for a voice"
  );
  held.release = undefined;
  held.companyId = home.id;
  held.conversationId = shadow.app.companies.thread(thread.id, alice)
    .conversationId as ConversationId;
  await until(async () => held.release, Boolean);
  await shadow.app.threads.send(thread.id, alice, "Only the kitchen");
  held.release!();
  const answered = await until(
    () =>
      shadow.app.threads.messages(
        shadow.app.companies.thread(thread.id, alice)
      ),
    (state) => !state.running && state.messages.length >= 4
  );
  held.release = undefined;
  // The message joins the turn after its tool call, so the turn gives one answer, not two.
  expect(answered.messages.map((message) => message.text)).toEqual([
    "Hold for a voice",
    "",
    "Only the kitchen",
    "Ok.",
  ]);
});

test("a message steers only its author's running turn; another member's waits for the answer", async () => {
  const home = await shadow.app.companies.create(alice, "Shared voice");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const thread = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    "Hold for a voice"
  );
  held.companyId = home.id;
  held.conversationId = shadow.app.companies.thread(thread.id, alice)
    .conversationId as ConversationId;
  await until(async () => held.release, Boolean);
  await shadow.app.threads.send(thread.id, bob, "Read my mail");
  held.release!();
  await until(
    () =>
      shadow.app.threads.messages(
        shadow.app.companies.thread(thread.id, alice)
      ),
    (state) => !state.running && state.messages.length === 4
  );
  // Alice's turn stays hers to its end, and Bob's message gets its own turn.
  expect(held.requesters).toEqual([alice.id]);
  expect(
    (
      await shadow.app.threads.messages(
        shadow.app.companies.thread(thread.id, alice)
      )
    ).messages.map((message) => message.text)
  ).toEqual(["Hold for a voice", "Done.", "Read my mail", "Ok."]);
});

test("an answer carries the work before it: open while the agent works, folded once it answers", () => {
  const entries = [
    {
      id: 1,
      kind: "shadow.message",
      data: { author: "Alice", authorId: "a", text: "Weather?", files: [] },
      model: [{ role: "user", content: "Weather?", timestamp: 1000 }],
    },
    {
      id: 2,
      kind: "pi.generation",
      model: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check the forecast." },
            { type: "text", text: "I'll look." },
            {
              type: "toolCall",
              id: "c1",
              name: "web_search",
              arguments: { query: "Prague weather" },
            },
          ],
          timestamp: 2000,
        },
      ],
    },
  ];
  const view = (live: object, more: object[] = []) =>
    ({ entries: [...entries, ...more], docs: { "pi.live": live } }) as never;

  const working = threadMessages(view({ run: {}, tools: [{}] }));
  expect(working.running).toBe(true);
  expect(working.messages[1]).toMatchObject({
    text: "",
    streaming: true,
    work: {
      startedAt: 1000,
      endedAt: null,
      steps: [
        { kind: "thinking", text: "Check the forecast." },
        { kind: "text", text: "I'll look." },
        {
          kind: "tool",
          tool: "web_search",
          text: "Prague weather",
          running: true,
        },
      ],
    },
  });

  const done = threadMessages(
    view({}, [
      {
        id: 3,
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: "c1",
            content: [{ type: "text", text: "Sunny, 21 °C" }],
            isError: false,
            timestamp: 3000,
          },
        ],
      },
      {
        id: 4,
        kind: "pi.generation",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Sunny." }],
            timestamp: 4000,
            durationMs: 5000,
          },
        ],
      },
    ])
  );
  expect(done.messages.map((message) => message.text)).toEqual([
    "Weather?",
    "Sunny.",
  ]);
  expect(done.messages[1]!.work).toMatchObject({ endedAt: 9000 });
  expect(done.messages[1]!.work!.steps.map((step) => step.running)).toEqual([
    false,
    false,
    false,
  ]);
  expect(done.messages[1]!.work!.steps[2]).toMatchObject({
    input: '{\n  "query": "Prague weather"\n}',
    output: "Sunny, 21 °C",
  });
});

test("a stopped turn says so, calls of one tool in a row fold into one row, and thread links show their work", () => {
  const call = (id: string, args: object) => ({
    type: "toolCall",
    id,
    name: "start_thread",
    arguments: args,
  });
  const result = (id: string, text: string) => ({
    id,
    kind: "pi.tool",
    model: [
      {
        role: "toolResult",
        toolCallId: id,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 3000,
      },
    ],
  });
  const view = {
    entries: [
      {
        id: 1,
        kind: "shadow.message",
        data: { author: "Alice", authorId: "a", text: "Plan it", files: [] },
        model: [{ role: "user", content: "Plan it", timestamp: 1000 }],
      },
      {
        id: 2,
        kind: "pi.generation",
        model: [
          {
            role: "assistant",
            content: [
              call("a", { channel: "food" }),
              call("b", { channel: "trips" }),
            ],
            stopReason: "toolUse",
            timestamp: 2000,
          },
        ],
      },
      result("a", "Started [Dinner](thread:d-1) in #food."),
      result("b", "Started [Trip](thread:t-2) in #trips."),
      {
        id: 5,
        kind: "pi.generation",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Half" }],
            stopReason: "aborted",
            errorMessage: "Request was aborted",
            timestamp: 4000,
          },
        ],
      },
    ],
    docs: {},
  } as never;

  const answer = threadMessages(view).messages[1]!;
  expect(answer).toMatchObject({ failed: false, work: { stopped: true } });
  expect(answer.work!.steps.map((step) => step.text)).toEqual([
    "[Dinner](thread:d-1)",
    "[Trip](thread:t-2)",
  ]);
  expect(answer.work!.endedAt! - answer.work!.startedAt).toBe(3000);
});

test("the company's working stream shows a thread while its agent works, and people stop it", async () => {
  const token = await shadow.signIn("Alice", "alice@example.com");
  const company = await shadow.app.companies.create(alice, "Busy");
  const [general] = shadow.app.companies.channels(company.id, alice);
  const stream = await shadow.call(`/api/v1/companies/${company.id}/working`, {
    token,
  });

  const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
  const working = async () => {
    let event = "";
    while (!event.includes("\n\n")) {
      event += (await reader.read()).value ?? "";
    }
    return JSON.parse(/^data: (.*)$/m.exec(event)![1]!).threadIds;
  };
  expect(await working()).toEqual([]);

  const thread = await shadow.app.threads.create(
    company.id,
    alice,
    general!.id,
    "Take your time"
  );
  expect(await working()).toEqual([thread.id]);
  const stopped = await shadow.call(`/api/v1/threads/${thread.id}/stop`, {
    token,
    method: "POST",
  });
  expect(stopped.status).toBe(204);
  expect(await working()).toEqual([]);
  await reader.cancel();
  expect(
    await shadow.app.threads.messages(
      shadow.app.companies.thread(thread.id, alice)
    )
  ).toMatchObject({
    running: false,
    messages: [
      { text: "Take your time" },
      { agent: true, text: "", work: { stopped: true, steps: [] } },
    ],
  });

  const outsider = await shadow.signIn("Eve", "eve@example.com");
  expect(
    (
      await shadow.call(`/api/v1/companies/${company.id}/working`, {
        token: outsider,
      })
    ).status
  ).toBe(404);
  expect(
    (
      await shadow.call(`/api/v1/threads/${thread.id}/stop`, {
        token: outsider,
        method: "POST",
      })
    ).status
  ).toBe(404);
});

test("stopping a thread also stops the threads it asked, which still work on its message", async () => {
  const company = await shadow.app.companies.create(alice, "Delegating");
  const [general] = shadow.app.companies.channels(company.id, alice);
  const seen: (readonly string[])[] = [];
  const stopWatching = await shadow.app.threads.watchWorking(
    company.id,
    alice,
    (threadIds) => seen.push(threadIds)
  );
  const asking = await shadow.app.threads.create(
    company.id,
    alice,
    general!.id,
    "Delegate and wait"
  );
  await until(
    async () => seen.at(-1) ?? [],
    (threadIds) => threadIds.length === 2
  );
  const asked = seen.at(-1)!.find((id) => id !== asking.id)!;

  await shadow.app.threads.stop(asking.id, alice);
  await until(
    async () => seen.at(-1) ?? [],
    (threadIds) => threadIds.length === 0
  );
  await stopWatching();
  const answer = (
    await shadow.app.threads.messages(shadow.app.companies.thread(asked, alice))
  ).messages.at(-1);
  expect(answer).toMatchObject({ agent: true, work: { stopped: true } });
});

test("each member has an own orchestrator thread, which stays open, out of the channel lists, and private", async () => {
  const company = await shadow.app.companies.create(alice, "Orchestrated");
  const [first, again] = await Promise.all([
    shadow.app.threads.orchestrator(company.id, alice),
    shadow.app.threads.orchestrator(company.id, alice),
  ]);
  expect(again.id).toBe(first.id);
  expect((await shadow.app.threads.orchestrator(company.id, alice)).id).toBe(
    first.id
  );
  expect(
    shadow.app.companies.channels(company.id, alice).flatMap((c) => c.threads)
  ).toEqual([]);

  const token = await shadow.signIn("Alice", "alice@example.com");
  const base = `/api/v1/companies/${company.id}`;
  expect(
    await (await shadow.call(`${base}/orchestrator`, { token })).json()
  ).toEqual({
    id: first.id,
    channelId: first.channelId,
    title: "Shadow",
    updatedAt: first.updatedAt,
    settledAt: null,
  });
  const settle = await shadow.call(`${base}/threads/${first.id}/settled`, {
    token,
    body: { settled: true },
  });
  expect(settle.status).toBe(400);
  expect(await settle.json()).toEqual({ error: "This thread stays open" });
  const outsider = await shadow.signIn("Bob", "bob@example.com");
  expect(
    (await shadow.call(`${base}/orchestrator`, { token: outsider })).status
  ).toBe(404);
  await shadow.app.companies.addMember(company.id, alice, bob.email);
  const bobs = await shadow.app.threads.orchestrator(company.id, bob);
  expect(bobs.id).not.toBe(first.id);
  expect(() => shadow.app.companies.thread(first.id, bob)).toThrow();
  await expect(
    shadow.app.threads.send(first.id, bob, "Read Alice's thread")
  ).rejects.toThrow();
  expect(
    (await shadow.call(`/api/v1/threads/${first.id}`, { token: outsider }))
      .status
  ).toBe(404);
});

test("a person's memory has only their own conversation, and search shows nobody else's own thread", async () => {
  const home = await shadow.app.companies.create(alice, "Private");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const [general] = shadow.app.companies.channels(home.id, alice);
  const alices = await shadow.app.threads.orchestrator(home.id, alice);
  const bobs = await shadow.app.threads.orchestrator(home.id, bob);
  await shadow.app.threads.send(alices.id, alice, "My diary code is 4711");
  await shadow.app.threads.send(bobs.id, bob, "My diary code is 8123");
  const shared = await shadow.app.threads.create(
    home.id,
    alice,
    general!.id,
    "Dinner at seven"
  );
  for (const thread of [
    alices,
    shadow.app.companies.thread(shared.id, alice),
  ]) {
    await until(
      () => shadow.app.threads.messages(thread),
      (state) => !state.running && state.messages.length === 2
    );
  }
  const { memories } = shadow.app.threads as unknown as {
    memories: Map<
      string,
      { view: (end: number) => string; count: () => number }
    >;
  };
  const viewOf = (orchestrator: { id: string }) =>
    until(
      async () => memories.get(orchestrator.id),
      (memory) => (memory?.count() ?? 0) >= 2
    ).then((memory) => memory!.view(memory!.count()));
  expect(await viewOf(bobs)).not.toContain("Dinner at seven");
  expect(await viewOf(bobs)).not.toContain("4711");
  expect(await viewOf(bobs)).toContain("My diary code is 8123");
  expect(await viewOf(alices)).toContain("My diary code is 4711");
  expect(await viewOf(alices)).not.toContain("Dinner at seven");
  expect(await viewOf(alices)).not.toContain("8123");

  await shadow.app.indexer.scan(home.id);
  const found = (searcher: User) =>
    shadow.app.indexer
      .search(home.id, "diary", 20, searcher.id)
      .then(({ results }) => results.map((result) => result.uri));
  expect(await found(alice)).toContain(`thread:${alices.id}`);
  expect(await found(bob)).not.toContain(`thread:${alices.id}`);
});

test("memory keeps full worker results across rebuilds without copying worker work or old channel memory", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "shadow-conversation-memory-")
  );
  const home = await shadow.app.companies.create(alice, "Reports");
  const [general] = shadow.app.companies.channels(home.id, alice);
  const first = savingThreads(directory, async () => null);
  let reopened: Threads | undefined;
  try {
    const orchestrator = await first.orchestrator(home.id, alice);
    const oldDirectory = join(directory, "companies", home.id, "memories");
    await mkdir(oldDirectory, { recursive: true });
    const oldPath = join(oldDirectory, `${orchestrator.id}.sqlite`);
    const oldMemory = new Memory(
      oldPath,
      async () => undefined,
      async () => "unused"
    );
    oldMemory.add([
      { threadId: "worker", messageId: 1, text: "Unrelated channel history" },
    ]);
    oldMemory.close();

    await first.send(orchestrator.id, alice, "Keep the result");
    await until(
      () => first.messages(orchestrator),
      (state) => !state.running && state.messages.length === 2
    );
    const result = `Complete result: ${"verified detail ".repeat(80)} final reference https://example.com/result`;
    const worker = await first.startAgentThread(
      home.id,
      general!.id,
      "Worker report"
    );
    await first.send(
      worker.id,
      alice,
      `Run code: await tools.send_to_thread(${JSON.stringify({ thread: orchestrator.id, message: result })})`
    );

    await answeredIn(first, home.id, worker.id);
    await until(
      () => first.messages(orchestrator),
      (state) => !state.running && state.messages.length === 3
    );
    const opened = first as unknown as { memories: Map<string, Memory> };
    const memory = await until(
      async () => opened.memories.get(orchestrator.id),
      (value) => value?.count() === 3
    );
    const original = await memory!.zoom(2, 1);
    expect(original).toContain(result);
    expect(original).toContain(`thread:${worker.id}`);
    expect(original).toContain("Shadow: Ok.");
    expect(original).not.toContain("Run code:");
    expect(memory!.view(3)).not.toContain("Unrelated channel history");
    expect(await memory!.zoom(0, 1)).toContain("Alice: Keep the result");

    await first.send(
      worker.id,
      alice,
      `Run code: await tools.send_to_thread(${JSON.stringify({ thread: orchestrator.id, message: "Quiet worker result" })})`
    );
    await until(
      () => first.messages(orchestrator, true),
      (state) => !state.running && state.messages.length === 4
    );
    await until(
      async () => memory!.count(),
      (count) => count === 4
    );
    expect(await memory!.zoom(3, 1)).toContain("Quiet worker result");
    expect((await first.messages(orchestrator)).messages).toHaveLength(3);

    await first.closeAll();
    const memoryPath = join(
      directory,
      "companies",
      home.id,
      "threads",
      orchestrator.id,
      "memory.sqlite"
    );
    await rename(memoryPath, `${memoryPath}.saved`);
    reopened = savingThreads(directory, async () => null);
    const access = reopened as unknown as {
      memories: Map<string, Memory>;
      conversation: (thread: ThreadRef) => Promise<Conversation>;
    };
    const conversation = await access.conversation(orchestrator);
    await conversation.reset(
      "Unrelated channel summary in old context",
      BACKGROUND_CONTEXT
    );
    const rebuilt = await until(
      async () => access.memories.get(orchestrator.id),
      (value) => value?.count() === 4
    );
    expect(await rebuilt!.zoom(2, 1)).toBe(original);
    expect(await rebuilt!.zoom(0, 1)).toContain("Alice: Keep the result");
    expect(await rebuilt!.zoom(3, 1)).toContain("Quiet worker result");
    const context = await until(
      async () =>
        (await conversation.context(BACKGROUND_CONTEXT)).messages
          .map(textOf)
          .join("\n"),
      (text) => text.startsWith("This is your memory:")
    );
    expect(context).not.toContain("Unrelated channel summary");
    expect(context).not.toContain("Unrelated channel history");
    expect(context).not.toContain("Run code:");
    expect((await reopened.messages(orchestrator)).messages).toHaveLength(3);
    const archived = new Database(oldPath, { readonly: true });
    try {
      expect(
        archived.query("SELECT text FROM line WHERE level = 0").get()
      ).toEqual({ text: "Unrelated channel history" });
    } finally {
      archived.close();
    }
  } finally {
    await reopened?.closeAll();
    await first.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("a thread moves with its artifacts, its own files, and a note; into a private channel only by its starter, and the others lose it at once", async () => {
  const token = await shadow.signIn("Alice", "alice@example.com");
  const bobToken = await shadow.signIn("Bob", "bob@example.com");
  const home = await shadow.app.companies.create(alice, "Moves");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const [general] = shadow.app.companies.channels(home.id, alice);
  const work = shadow.app.companies.addChannel(home.id, "work", alice.id, null);
  const mine = shadow.app.companies.createChannel(home.id, alice, "mine");
  const bobs = await shadow.app.threads.orchestrator(home.id, bob);
  const shared = (
    await shadow.app.threads.upload(home.id, general!.id, alice, [
      new File(["Shared list"], "shared.txt"),
    ])
  )[0]!;
  const trip = await shadow.app.threads.create(
    home.id,
    alice,
    general!.id,
    `Plan the Rome trip with file ${shared.id}`,
    [new File(["Flights at nine"], "flights.txt")]
  );
  const other = await shadow.app.threads.create(
    home.id,
    bob,
    general!.id,
    `Also file ${shared.id}`
  );
  for (const id of [trip.id, other.id]) {
    await until(
      () => shadow.app.threads.messages(shadow.app.companies.thread(id, alice)),
      (state) => !state.running && state.messages.length === 2
    );
  }
  shadow.app.artifacts.create(
    shadow.app.companies.thread(trip.id, alice),
    general!.id,
    { title: "Rome", html: "<p>Rome</p>", requestKey: `rome:${trip.id}` }
  );
  const move = (threadId: string, channelId: string, as = token) =>
    shadow.call(`/api/v1/companies/${home.id}/threads/${threadId}/channel`, {
      token: as,
      method: "POST",
      body: { channelId },
    });
  const names = async (channelId: string) =>
    (
      await shadow.app.threads.files(
        shadow.app.threads.place(home.id, channelId, alice)
      )
    ).map((file) => file.name);

  const moved = await move(trip.id, work.id);
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as { channelId: string }).channelId).toBe(
    work.id
  );
  // The shared file stays for the other thread that mentions it.
  expect(await names(general!.id)).toEqual(["shared.txt"]);
  expect(await names(work.id)).toEqual(["flights.txt"]);
  expect(
    shadow.app.artifacts
      .inPlace(home.id, work.id, alice)
      .map((artifact) => artifact.title)
  ).toEqual(["Rome"]);
  const { messages } = await shadow.app.threads.messages(
    shadow.app.companies.thread(trip.id, alice)
  );
  expect([messages.at(-1)?.author, messages.at(-1)?.text]).toEqual([
    "Alice",
    "_Moved this thread from #general to #work._",
  ]);

  expect((await move(other.id, mine.id, bobToken)).status).toBe(404);
  expect((await move(other.id, mine.id)).status).toBe(403);
  expect((await move(bobs.id, general!.id, bobToken)).status).toBe(400);
  expect((await move(trip.id, "nowhere")).status).toBe(404);
  expect((await move(trip.id, general!.id, bobToken)).status).toBe(200);

  await shadow.app.indexer.scan(home.id);
  const found = (searcher: User) =>
    shadow.app.indexer
      .search(home.id, "Rome", 20, searcher.id)
      .then(({ results }) => results.map((result) => result.uri));
  expect(await found(bob)).toContain(`thread:${trip.id}`);

  expect((await move(trip.id, mine.id)).status).toBe(200);
  // Without a scan, search and the thread leave out what Bob no longer sees.
  expect(await found(bob)).not.toContain(`thread:${trip.id}`);
  expect(await found(alice)).toContain(`thread:${trip.id}`);
  expect(
    (await shadow.call(`/api/v1/threads/${trip.id}`, { token: bobToken }))
      .status
  ).toBe(404);

  const busy = await shadow.app.threads.create(
    home.id,
    alice,
    general!.id,
    "Take your time"
  );
  await until(
    () =>
      shadow.app.threads.messages(shadow.app.companies.thread(busy.id, alice)),
    (state) => state.running
  );
  expect((await move(busy.id, work.id)).status).toBe(409);
  await shadow.call(`/api/v1/threads/${busy.id}/stop`, {
    token,
    method: "POST",
  });

  // A person asks the agent to move its own thread.
  const asked = await shadow.app.threads.create(
    home.id,
    alice,
    general!.id,
    "Move to #work"
  );
  const answered = await until(
    () =>
      shadow.app.threads.messages(shadow.app.companies.thread(asked.id, alice)),
    (state) => !state.running && state.messages.length === 3
  );
  // The note comes before the answer of the turn that moved the thread.
  expect(answered.messages.map((message) => message.text)).toEqual([
    "Move to #work",
    "_Moved this thread from #general to #work._",
    "Done.",
  ]);
  expect(shadow.app.companies.thread(asked.id, alice).channelId).toBe(work.id);
  expect(
    answered.messages[2]?.work?.steps.map((step) => [step.tool, step.output])
  ).toEqual([["move_thread", expect.stringContaining("to #work.")]]);
});

test("the orchestrator gets its own instructions, also after they change, and a channel thread gets none of them", async () => {
  const home = await shadow.app.companies.create(alice, "Delegating");
  const orchestrator = await shadow.app.threads.orchestrator(home.id, alice);
  // An older version of Shadow stored other orchestrator instructions.
  const threads = shadow.app.threads as unknown as {
    conversation: (thread: ThreadRef) => Promise<Conversation>;
  };
  await (await threads.conversation(orchestrator)).configure(
    { instructions: "Outdated orchestrator" },
    BACKGROUND_CONTEXT
  );
  const promptOf = async (thread: ThreadRef, text: string) => {
    const before = systemPrompts.length;
    const { messages } = await shadow.app.threads.messages(thread);
    await shadow.app.threads.send(thread.id, alice, text);
    await until(
      () => shadow.app.threads.messages(thread),
      (state) => !state.running && state.messages.length === messages.length + 2
    );
    return systemPrompts.slice(before).join("\n");
  };
  expect(await promptOf(orchestrator, "Plan our trip")).toContain(
    "This thread is an orchestrator: the own thread of one person"
  );

  const [channel] = shadow.app.companies.channels(home.id, alice);
  const created = await shadow.app.threads.create(
    home.id,
    alice,
    channel!.id,
    "Hi"
  );
  const channelThread = shadow.app.companies
    .allThreadsIn(home.id)
    .find((candidate) => candidate.id === created.id)!;
  await until(
    () => shadow.app.threads.messages(channelThread),
    (state) => !state.running && state.messages.length === 2
  );
  expect(await promptOf(channelThread, "Plan our trip")).not.toContain(
    "This thread is an orchestrator"
  );
});

test("the soul comes first in an agent's instructions, and the instructions hold only the work", async () => {
  const home = await shadow.app.companies.create(alice, "Souled");
  const [channel] = shadow.app.companies.channels(home.id, alice);
  const before = systemPrompts.length;
  const created = await shadow.app.threads.create(
    home.id,
    alice,
    channel!.id,
    "Hi"
  );
  const thread = shadow.app.companies
    .allThreadsIn(home.id)
    .find((candidate) => candidate.id === created.id)!;
  await until(
    () => shadow.app.threads.messages(thread),
    (state) => !state.running && state.messages.length === 2
  );
  const prompt = systemPrompts.slice(before).join("\n");
  const soul = prompt.indexOf("<soul>\n# Shadow");
  expect(soul).toBeGreaterThan(-1);
  expect(soul).toBeLessThan(prompt.indexOf("This thread is in #"));
  expect(soul).toBeLessThan(
    prompt.indexOf("You are Shadow, a company assistant.")
  );
  expect(prompt).not.toContain("Answer concisely");
});

test("the orchestrator compacts into a view of its memory, and its agent zooms into a message", async () => {
  shadow.faux.appendResponses(Array.from({ length: 40 }, () => agent));
  const home = await shadow.app.companies.create(alice, "Remembering");
  const orchestrator = await shadow.app.threads.orchestrator(home.id, alice);
  const said = async (text: string, messages: number) => {
    await shadow.app.threads.send(orchestrator.id, alice, text);
    return until(
      () => shadow.app.threads.messages(orchestrator),
      (state) => !state.running && state.messages.length === messages
    );
  };
  await said("The wifi password is on the fridge", 2);
  await said("Bring the tent", 4);
  await said("Call grandma on Sunday", 6);
  // About 62k tokens: the thread compacts after this turn, and the next request reads the memory.
  await said(`Here is the manual: ${"word ".repeat(50_000)}`, 8);
  const zoomed = await said("Zoom 0", 10);
  const view = memoryViews.findLast((memory) => memory.includes("5+1|"));
  expect(view).toMatch(
    /0\+1\|\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Alice: The wifi password is on the fridge\n1\+1\|\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Shadow: Ok.\n2\+1\|\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Alice: Bring the tent/
  );
  expect(view).toMatch(
    /5\+1\|\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Shadow: Ok\./
  );
  expect(view).not.toContain("Here is the manual");
  // The transcript keeps the messages that the compaction took out of the model's context.
  expect(zoomed.messages[0]!.text).toBe("The wifi password is on the fridge");
  expect(zoomed.messages.at(-1)!.text).toBe("Done.");
  expect(toolResults).toContainEqual(
    expect.stringMatching(
      /^Message 0, \d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d:\n\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d Alice: The wifi password is on the fridge$/
    )
  );
});

test("the orchestrator compacts after its turn without notifying about the same answer again", async () => {
  shadow.faux.appendResponses(Array.from({ length: 20 }, () => agent));
  const home = await shadow.app.companies.create(alice, "Compacting");
  const orchestrator = await shadow.app.threads.orchestrator(home.id, alice);
  const views = memoryViews.length;
  for (const [index, text] of [
    "Buy milk",
    "Buy bread",
    "Buy eggs",
    // Long enough for the compaction after the turn, too short for one during it.
    `Here is the list: ${"word ".repeat(42_000)}`,
  ].entries()) {
    await shadow.app.threads.send(orchestrator.id, alice, text);
    await until(
      () => shadow.app.threads.messages(orchestrator),
      (state) => !state.running && state.messages.length === (index + 1) * 2
    );
  }
  // The compaction waits for the memory to catch up, then runs; the next request reads its view.
  await Bun.sleep(3000);
  await shadow.app.threads.send(orchestrator.id, alice, "Buy butter");
  await until(
    () => shadow.app.threads.messages(orchestrator),
    (state) => !state.running && state.messages.length === 10
  );
  expect(memoryViews.length).toBeGreaterThan(views);
  await Bun.sleep(100);
  expect(
    shadow.app.notifications.inbox(home.id, alice).notifications
  ).toHaveLength(5);
}, 15_000);

test("a quiet orchestrator teaches Shadow what stays private to its person", async () => {
  shadow.faux.appendResponses(Array.from({ length: 4 }, () => agent));
  const home = await shadow.app.companies.create(alice, "Orchestrator memory");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  // Only admins manage what Shadow learned; each sees only what their own turns may read.
  shadow.app.companies.setRole(home.id, alice, bob.id, "admin");
  const orchestrator = await shadow.app.threads.orchestrator(home.id, alice);
  await shadow.app.threads.send(
    orchestrator.id,
    alice,
    "I am vegetarian, what is for lunch?"
  );
  await until(
    () => shadow.app.threads.messages(orchestrator),
    (state) => !state.running && state.messages.length === 2
  );
  // An orchestrator never settles, so only its quiet time starts a review.
  const realNow = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(
    () => realNow() + 11 * 60_000
  );
  try {
    await shadow.app.threads.orchestrator(home.id, bob);
    const started = realNow();
    let learned = shadow.app.threads.learnedFor(home.id, alice);
    while (learned.length < 2 && realNow() - started < 10_000) {
      await Bun.sleep(50);
      learned = shadow.app.threads.learnedFor(home.id, alice);
    }
    expect(
      learned.map((item) => [item.kind, item.text, item.realm, item.channelId])
    ).toEqual([
      ["about", "Alice is vegetarian", alice.id, null],
      ["howto", "Groceries come from the corner shop", alice.id, null],
    ]);
    expect(shadow.app.threads.learnedFor(home.id, bob)).toEqual([]);
  } finally {
    clock.mockRestore();
  }
}, 15_000);

test("a quiet thread teaches Shadow about its people and its channel, and Shadow suggests an automation that waits for its person", async () => {
  shadow.faux.appendResponses(Array.from({ length: 20 }, () => agent));
  const home = await shadow.app.companies.create(alice, "Learning");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  // Only admins manage what Shadow learned; each sees only what their own turns may read.
  shadow.app.companies.setRole(home.id, alice, bob.id, "admin");
  const food = shadow.app.companies.addChannel(home.id, "food", alice.id, null);
  const general = shadow.app.companies
    .channels(home.id, alice)
    .find((channel) => channel.name === "general")!;
  const answered = (threadId: string) =>
    until(
      () =>
        shadow.app.threads.messages(
          shadow.app.companies.thread(threadId, alice)
        ),
      (state) => !state.running && state.messages.length === 2
    );
  const lunch = await shadow.app.threads.create(
    home.id,
    alice,
    food.id,
    "I am vegetarian, what is for lunch?"
  );
  await answered(lunch.id);
  shadow.app.companies.setThreadSettled(home.id, lunch.id, alice, true);
  const elsewhere = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    "Hello"
  );
  await answered(elsewhere.id);
  const learned = await until(
    () => Promise.resolve(shadow.app.threads.learnedFor(home.id, bob)),
    (items) => items.length === 2
  );
  expect(learned.map((item) => [item.kind, item.text, item.realm])).toEqual([
    ["about", "Alice is vegetarian", null],
    ["howto", "Groceries come from the corner shop", null],
  ]);
  expect(learned[1]!.channelId).toBe(food.id);

  const before = systemPrompts.length;
  const next = await shadow.app.threads.create(
    home.id,
    bob,
    food.id,
    "What do we eat?"
  );
  await answered(next.id);
  const prompt = systemPrompts
    .slice(before)
    .find((text) => text.includes("This thread is in #food."))!;
  expect(prompt).toContain("About Alice:\n- Alice is vegetarian");
  expect(prompt).toContain(
    "How-tos here:\n- Groceries come from the corner shop"
  );

  // Only the person who wrote gets a suggestion, and nothing runs before they accept it.
  expect(shadow.app.agenda.upcoming(home.id, bob).suggestions).toEqual([]);
  const [suggestion] = shadow.app.agenda.upcoming(home.id, alice).suggestions;
  expect(suggestion).toMatchObject({
    kind: "routine",
    name: "Morning menu",
    channelId: food.id,
    threadId: lunch.id,
  });
  expect(shadow.app.routines.inCompany(home.id, alice.id)).toEqual([]);
  await shadow.app.agenda.answer(home.id, alice, suggestion!.id, true);
  expect(
    shadow.app.routines
      .inCompany(home.id, alice.id)
      .map((routine) => [routine.name, routine.channelId])
  ).toEqual([["Morning menu", food.id]]);
  expect(shadow.app.agenda.upcoming(home.id, alice).suggestions).toEqual([]);
  expect(shadow.app.agenda.automations(home.id, alice.id)).toContain(
    'Suggested routine "Morning menu": accepted'
  );
  // Later tests tick every routine.
  for (const routine of shadow.app.routines.inCompany(home.id, alice.id)) {
    shadow.app.routines.delete(routine.id, alice);
  }

  // A person corrects and removes what Shadow learned; the agent reads the change.
  const [fact, howto] = learned;
  shadow.app.threads.changeLearned(
    home.id,
    bob,
    fact!.id,
    "Alice eats fish, no meat"
  );
  shadow.app.threads.removeLearned(home.id, alice, howto!.id);
  expect(
    shadow.app.threads.learnedFor(home.id, alice).map((item) => item.text)
  ).toEqual(["Alice eats fish, no meat"]);
  expect(() =>
    shadow.app.threads.removeLearned(home.id, alice, howto!.id)
  ).toThrow();
});

test("a settled thread goes into its channel's brief and summary, which a new thread of the channel reads with the channel's threads", async () => {
  shadow.faux.appendResponses(Array.from({ length: 20 }, () => agent));
  const home = await shadow.app.companies.create(alice, "Briefs");
  const food = shadow.app.companies.addChannel(home.id, "food", alice.id, null);
  const general = shadow.app.companies
    .channels(home.id, alice)
    .find((channel) => channel.name === "general")!;
  const pasta = await shadow.app.threads.create(
    home.id,
    alice,
    food.id,
    "We eat pasta tonight"
  );
  const answered = (threadId: string) =>
    until(
      () =>
        shadow.app.threads.messages(
          shadow.app.companies.thread(threadId, alice)
        ),
      (state) => !state.running && state.messages.length === 2
    );
  await answered(pasta.id);
  expect(await shadow.app.threads.brief(home.id, food.id, alice)).toBeNull();
  shadow.app.companies.setThreadSettled(home.id, pasta.id, alice, true);
  // Work anywhere in the company makes it catch up, and the settled thread needs no quiet time.
  const elsewhere = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    "Hello"
  );
  await answered(elsewhere.id);
  const brief = await until(
    () => shadow.app.threads.brief(home.id, food.id, alice),
    (found) => found !== null
  );
  expect(brief!.text).toBe(
    `## Now\n- Pasta tonight [We eat pasta tonight](thread:${pasta.id})`
  );
  expect(
    shadow.app.companies
      .channels(home.id, alice)
      .find((channel) => channel.id === food.id)!.summary
  ).toBe("What the company eats.");

  const before = systemPrompts.length;
  const next = await shadow.app.threads.create(
    home.id,
    alice,
    food.id,
    "What do we eat?"
  );
  await answered(next.id);
  const prompt = systemPrompts
    .slice(before)
    .find((text) => text.includes("This thread is in #food."))!;
  expect(prompt).toContain(
    `The brief of #food:\n## Now\n- Pasta tonight [We eat pasta tonight](thread:${pasta.id})`
  );
  expect(prompt).toMatch(
    new RegExp(
      `The newest other threads of #food, by title:\\n- \\[We eat pasta tonight\\]\\(thread:${pasta.id}\\): settled$`,
      "m"
    )
  );
  expect(prompt).not.toContain(next.id);

  await expect(
    shadow.app.threads.brief(home.id, food.id, bob)
  ).rejects.toThrow();
});

test("an agent creates private channels, searches, and merges them, and a merge keeps everything in the other channel", async () => {
  const home = await shadow.app.companies.create(alice, "Channels");
  const [general] = shadow.app.companies.channels(home.id, alice);
  const desk = shadow.app.companies.createChannel(home.id, alice, "desk");
  const [shared, asked] = await Promise.all(
    [general!.id, desk.id].map((channelId) =>
      shadow.app.threads.create(home.id, alice, channelId, "Hello")
    )
  );
  const answered = (threadId: string) =>
    until(
      () =>
        shadow.app.threads.messages(
          shadow.app.companies.thread(threadId, alice)
        ),
      (state) => !state.running && state.messages.length === 2
    );
  await answered(shared!.id);
  await answered(asked!.id);
  const ask = async (text: string, threadId = asked!.id) => {
    const before = toolResults.length;
    await shadow.app.threads.send(threadId, alice, text);
    return (
      await until(
        async () => toolResults,
        () => toolResults.length > before
      )
    )
      .slice(before)
      .join("\n");
  };
  // The channels that every member sees come only from Slack.
  expect(await ask("Create channel Sales: Deals", shared!.id)).toContain(
    "the channels that every member sees come from Slack"
  );
  expect(await ask("Create channel Trips: Company trips and holidays")).toBe(
    "Created #trips."
  );
  const trips = shadow.app.companies
    .channels(home.id, alice)
    .find((channel) => channel.name === "trips")!;
  expect(trips.summary).toBe("Company trips and holidays");
  expect(trips.ownerId).toBe(alice.id);
  expect(await ask("Search channels summer holidays")).toBe(
    "#trips (private): Company trips and holidays"
  );
  expect(await ask("Search channels dentist")).toBe(
    "No channel matches. list_channels shows them all."
  );
  expect(await ask("Create channel trips: Again")).toContain(
    "#trips already exists"
  );

  const packing = await shadow.app.threads.create(
    home.id,
    alice,
    trips.id,
    "Pack the tent"
  );
  await answered(packing.id);
  shadow.app.routines.create(home.id, trips.id, {
    id: crypto.randomUUID(),
    name: "Flight prices",
    schedule: "0 8 * * *",
    instructions: "Check the flight prices",
    createdBy: "shadow",
  });
  const [uploaded] = await shadow.app.threads.upload(home.id, trips.id, alice, [
    new File(["Tent, stove"], "packing.md"),
  ]);
  expect(await ask("Merge channel #trips into desk")).toBe(
    "Merged #trips into #desk."
  );
  expect(
    shadow.app.companies.channels(home.id, alice).map((channel) => channel.name)
  ).toEqual(["general", "alice", "desk"]);
  // The thread, the file that no thread mentions, and the routine go to #desk; nothing is lost.
  expect(shadow.app.companies.thread(packing.id, alice).channelId).toBe(
    desk.id
  );
  expect(
    (
      await shadow.app.threads.files({
        companyId: home.id,
        channelId: desk.id,
      })
    ).map((file) => file.id)
  ).toContain(uploaded!.id);
  expect(
    shadow.app.routines
      .inCompany(home.id, alice.id)
      .map((routine) => routine.channelId)
  ).toEqual([desk.id]);
  expect(
    shadow.app.database
      .query(
        "SELECT name, deleted_at IS NOT NULL AS deleted FROM channel WHERE id = ?"
      )
      .get(trips.id)
  ).toEqual({ name: `trips~${trips.id}`, deleted: 1 });

  expect(await ask("Create channel trips: New trips")).toBe("Created #trips.");
  expect(await ask("Merge channel trips into trips")).toContain(
    "#trips stays: Merge the channel into another channel."
  );
  expect(await ask("Merge channel dentist into general")).toContain(
    "There is no channel #dentist. list_channels shows the channels."
  );
  expect(await ask("Merge channel general into desk")).toContain(
    "copies a Slack channel"
  );

  // A private channel goes to every member only once its owner allows it.
  shadow.app.companies.createChannel(home.id, alice, "notes");
  const merged = ask("Merge channel notes into general");
  const [pending] = await until(
    async () => shadow.app.threads.approvalsFor(home.id, alice),
    (approvals) => approvals.length > 0
  );
  expect(pending!.approval).toMatchObject({
    tool: "merge_channel",
    approverId: alice.id,
  });
  expect(
    shadow.app.companies.channels(home.id, alice).map((channel) => channel.name)
  ).toContain("notes");
  shadow.app.threads.answerApproval(
    pending!.threadId,
    pending!.approval.id,
    alice,
    true
  );
  expect(await merged).toBe("Merged #notes into #general.");
});

test("people merge only a private channel into another; a channel that every member sees stays", async () => {
  const company = await shadow.app.companies.create(alice, "Moving");
  const [general] = shadow.app.companies.channels(company.id, alice);
  const food = shadow.app.companies.addChannel(
    company.id,
    "food",
    alice.id,
    null
  );
  const mine = shadow.app.companies.createChannel(company.id, alice, "mine");
  const orchestrator = await shadow.app.threads.orchestrator(company.id, alice);
  expect(orchestrator.channelId).toBe(general!.id);

  const token = await shadow.signIn("Alice", "alice@example.com");
  const outsider = await shadow.signIn("Bob", "bob@example.com");
  const merge = (channelId: string, into: string, as = token) =>
    shadow.call(`/api/v1/companies/${company.id}/channels/${channelId}/merge`, {
      method: "POST",
      token: as,
      body: { into },
    });
  expect((await merge(general!.id, food.id, outsider)).status).toBe(404);
  expect((await merge(general!.id, food.id)).status).toBe(403);
  expect((await merge(food.id, mine.id)).status).toBe(403);
  // The person's own channel stays; another private channel can merge into it.
  const own = shadow.app.companies.personalChannelOf(company.id, alice);
  expect((await merge(own.id, mine.id)).status).toBe(403);
  // A second person with the same name gets an own channel with a number.
  expect(
    shadow.app.companies.personalChannelOf(company.id, {
      id: "another-alice",
      name: "Alice",
      email: "alice@elsewhere.example",
    }).name
  ).toBe("alice-2");
  // A private channel merges into a shared one.
  expect((await merge(mine.id, food.id)).status).toBe(204);
  expect(
    shadow.app.companies
      .channels(company.id, alice)
      .map((channel) => channel.name)
  ).toEqual(["general", "alice", "food"]);
  expect(shadow.app.companies.orchestratorOf(company.id, alice.id)!.id).toBe(
    orchestrator.id
  );
});

test("save_file keeps the browser's screenshot and a file from the web in the channel", async () => {
  const home = await shadow.app.companies.create(alice, "Saves");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const web = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/report") {
        return new Response("PDF", {
          headers: {
            "content-disposition":
              "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
          },
        });
      }
      return new Response("photo");
    },
  });
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-save-"));
  const threads = savingThreads(dataDirectory, async () =>
    new TextEncoder().encode("browser screen")
  );
  try {
    const save = async (source: object) => {
      const { id } = await threads.create(
        home.id,
        alice,
        general.id,
        `Save ${JSON.stringify(source)}`
      );
      await answeredIn(threads, home.id, id);
    };
    await save({ browser_screenshot: true });
    await save({ url: `${web.url}photos/beach%20day.jpg` });
    await save({ url: `${web.url}report` });
    await save({ url: `${web.url}`, name: "front page.html" });

    const files = await threads.files({
      companyId: home.id,
      channelId: general.id,
    });
    const saved = await Promise.all(
      files.map(async (file) => {
        const { path } = await threads.file(home.id, alice, file.id);
        return [file.name, await Bun.file(path).text()];
      })
    );
    expect(saved).toEqual([
      ["screenshot.png", "browser screen"],
      ["beach day.jpg", "photo"],
      ["résumé.pdf", "PDF"],
      ["front page.html", "photo"],
    ]);
    expect(toolResults.at(-1)).toBe(
      `Saved front page.html as file ${files.at(-1)!.id}.`
    );
  } finally {
    web.stop(true);
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("save_file refuses what is not an http file under 100 MB, stops reading a body at the limit, and leaves nothing of a failed file", async () => {
  const home = await shadow.app.companies.create(alice, "Refusals");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  let endlessChunks = 0;
  const web = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/large") {
        return new Response(Bun.file(large));
      }
      if (pathname === "/endless") {
        return new Response(
          new ReadableStream({
            pull: (controller) => {
              endlessChunks += 1;
              controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            },
          })
        );
      }
      return new Response("Gone", { status: 404 });
    },
  });
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-save-"));
  // Sparse: it says its size without taking the disk space.
  const large = join(dataDirectory, "large.bin");
  await Bun.write(large, "");
  await truncate(large, 100 * 1024 ** 2 + 1);
  const threads = savingThreads(dataDirectory, async () => null);
  try {
    const refusal = async (source: object) => {
      const { id } = await threads.create(
        home.id,
        alice,
        general.id,
        `Save ${JSON.stringify(source)}`
      );
      await answeredIn(threads, home.id, id);
      return toolResults.at(-1);
    };
    expect(await refusal({ url: "file:///etc/hosts" })).toContain(
      "save_file gets only http and https addresses, not file:///etc/hosts."
    );
    expect(await refusal({ url: `${web.url}missing` })).toContain(
      `${web.url}missing answered 404 Not Found`
    );
    expect(await refusal({ url: `${web.url}large` })).toContain(
      `${web.url}large is over 100 MB`
    );
    expect(await refusal({ url: `${web.url}endless` })).toContain(
      `${web.url}endless is over 100 MB`
    );
    // The server reads a little ahead, and stops once save_file leaves the body.
    const pulled = endlessChunks;
    await Bun.sleep(100);
    expect(endlessChunks).toBe(pulled);
    expect(pulled).toBeLessThan(32);
    expect(await refusal({ browser_screenshot: true })).toContain(
      "The browser could not take a screenshot."
    );
    expect(await refusal({ name: "nothing" })).toContain(
      "Give content and name, artifact, browser_screenshot, or url."
    );
    expect(
      await readdir(
        join(
          dataDirectory,
          "companies",
          home.id,
          "channels",
          general.id,
          "files"
        )
      )
    ).toEqual([]);
  } finally {
    web.stop(true);
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("save_file writes text and prints an artifact", async () => {
  const home = await shadow.app.companies.create(alice, "Documents");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const printed: string[] = [];
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-save-"));
  const threads = savingThreads(dataDirectory, async () => null, {
    pdf: async (html) => {
      printed.push(html);
      return new TextEncoder().encode("%PDF");
    },
  });
  try {
    const ask = async (text: string) => {
      const { id } = await threads.create(home.id, alice, general.id, text);
      await answeredIn(threads, home.id, id);
      return toolResults.at(-1);
    };
    await ask(
      `Save ${JSON.stringify({ content: "# Shopping\n- milk", name: "list.md" })}`
    );
    const invite = shadow.app.artifacts.create(
      {
        ...shadow.app.companies.allThreadsIn(home.id)[0]!,
        companyId: home.id,
      },
      general.id,
      { title: "Party invite", html: "<h1>Party</h1>", requestKey: "invite" }
    );
    await ask(`Save ${JSON.stringify({ artifact: invite.id })}`);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("<h1>Party</h1>");
    expect(printed[0]).toContain("Content-Security-Policy");
    expect(await ask(`Save ${JSON.stringify({ content: "x" })}`)).toContain(
      "Give the file a name with its extension."
    );
    expect(
      await ask(`Save ${JSON.stringify({ artifact: "no-such-thing" })}`)
    ).toContain("There is no artifact no-such-thing in this company.");

    const files = await threads.files({
      companyId: home.id,
      channelId: general.id,
    });
    const saved = await Promise.all(
      files.map(async (file) => {
        const { path } = await threads.file(home.id, alice, file.id);
        return [file.name, await Bun.file(path).text()];
      })
    );
    expect(saved).toEqual([
      ["list.md", "# Shopping\n- milk"],
      ["Party invite.pdf", "%PDF"],
    ]);

    expect(
      await ask(
        `Save ${JSON.stringify({ content: "# Shopping\n- milk\n- eggs", replaces: files[0]!.id })}`
      )
    ).toContain(`Saved the new version of file ${files[0]!.id} as list.md.`);
    expect(
      await ask(`Delete ${JSON.stringify({ file: files[1]!.id })}`)
    ).toContain("Deleted Party invite.pdf.");
    expect(
      await ask(`Delete ${JSON.stringify({ file: files[1]!.id })}`)
    ).toContain(`There is no file ${files[1]!.id} in this channel.`);
    const left = await threads.files({
      companyId: home.id,
      channelId: general.id,
    });
    expect(left.map((file) => [file.id, file.name])).toEqual([
      [files[0]!.id, "list.md"],
    ]);
    const { path } = await threads.file(home.id, alice, files[0]!.id);
    expect(await Bun.file(path).text()).toBe("# Shopping\n- milk\n- eggs");
    const deleted = join(dirname(dirname(path)), "deleted");
    const kept = await Promise.all(
      (await readdir(deleted))
        .toSorted()
        .map((name) => Bun.file(join(deleted, name)).text())
    );
    expect(kept).toEqual(["# Shopping\n- milk", "%PDF"]);
  } finally {
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the file tools work in another channel that the thread's person sees, never in another person's private one", async () => {
  const home = await shadow.app.companies.create(alice, "Files across");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const work = shadow.app.companies.createChannel(home.id, alice, "work");
  shadow.app.companies.createChannel(home.id, bob, "bobs");
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-across-"));
  const threads = savingThreads(dataDirectory, async () => null);
  try {
    const ask = async (text: string) => {
      const { id } = await threads.create(home.id, alice, general.id, text);
      await answeredIn(threads, home.id, id);
      return toolResults.at(-1);
    };
    expect(
      await ask(
        `Save ${JSON.stringify({ content: "# Standup", name: "standup.md", channel: "#Work" })}`
      )
    ).toMatch(/^Saved standup\.md as file \S+ in #work\.$/);
    const [saved] = await threads.files({
      companyId: home.id,
      channelId: work.id,
    });
    expect(saved).toMatchObject({ name: "standup.md" });
    expect(
      await threads.files({ companyId: home.id, channelId: general.id })
    ).toEqual([]);
    expect(
      await ask('Run code: text(await tools.list_files({ channel: "work" }));')
    ).toContain(`standup.md (file ${saved!.id}`);
    // replaces and delete_file find the file only in the channel that they name.
    expect(
      await ask(
        `Save ${JSON.stringify({ content: "# Standup 2", replaces: saved!.id })}`
      )
    ).toContain(`There is no file ${saved!.id} in this channel.`);
    expect(
      await ask(
        `Save ${JSON.stringify({ content: "# Standup 2", replaces: saved!.id, channel: "work" })}`
      )
    ).toContain(
      `Saved the new version of file ${saved!.id} as standup.md in #work.`
    );
    expect(
      await ask(
        `Delete ${JSON.stringify({ file: saved!.id, channel: "work" })}`
      )
    ).toContain("Deleted standup.md.");
    // Bob's private channel is not one that Alice's turn sees.
    expect(
      await ask(
        `Save ${JSON.stringify({ content: "x", name: "x.md", channel: "bobs" })}`
      )
    ).toContain("There is no channel #bobs.");
  } finally {
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a script gets a connector tool's long answer whole, and an error for one that is too big", async () => {
  const home = await shadow.app.companies.create(alice, "Long answers");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-long-"));
  const threads = savingThreads(
    dataDirectory,
    async () => null,
    {},
    {
      namespaces: () => [
        { name: "notes", prefix: "notes_", description: "Notes." },
      ],
      tools: async () => [
        {
          name: "notes_lines",
          description: "Lines of a note",
          parameters: Type.Object({ lines: Type.Integer() }),
          // More than the harness's own 50 KB and 2000 lines.
          execute: async (args) =>
            "line\n".repeat((args as { lines: number }).lines),
        },
      ],
    }
  );
  try {
    const summary = await threads.create(
      home.id,
      alice,
      general.id,
      'Run code: text(String((await tools.notes_lines({ lines: 60000 })).length)); try { await tools.notes_lines({ lines: 300000 }); } catch (error) { text(String(error)); } text("finished");'
    );
    await answeredIn(threads, home.id, summary.id);
    expect(toolResults.at(-1)).toContain("300000");
    expect(toolResults.at(-1)).toContain(
      "notes_lines answered with 1500000 bytes, more than 1048576"
    );
  } finally {
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a script saves a tool's long answer as a file and gives a file to a tool, and the model sees neither text", async () => {
  const home = await shadow.app.companies.create(alice, "Piping");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const work = shadow.app.companies.createChannel(home.id, alice, "work");
  const counted: number[] = [];
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-piping-"));
  const threads = savingThreads(
    dataDirectory,
    async () => null,
    {},
    {
      namespaces: () => [
        { name: "notes", prefix: "notes_", description: "Notes." },
      ],
      tools: async () => [
        {
          name: "notes_transcript",
          description: "The transcript of a note",
          parameters: Type.Object({}),
          execute: async () => `# Standup\n${"said a thing\n".repeat(5000)}`,
        },
        {
          name: "notes_count",
          description: "Counts the characters of a text",
          parameters: Type.Object({ text: Type.String() }),
          execute: async (args) => {
            counted.push((args as { text: string }).text.length);
            return "counted";
          },
        },
      ],
    }
  );
  try {
    const summary = await threads.create(
      home.id,
      alice,
      general.id,
      'Run code: const saved = await tools.save_file({ content: await tools.notes_transcript({}), name: "standup.md", channel: "work" }); const id = /file (\\S+) in/.exec(saved)[1]; text(await tools.notes_count({ text: await tools.read_file({ file: id }) })); await tools.notes_count({ text: await tools.read_file({ file: id, from: 65000 }) }); await tools.notes_count({ text: await tools.read_file({ file: id, source: true }) }); return id;'
    );
    await answeredIn(threads, home.id, summary.id);
    const [file] = await threads.files({
      companyId: home.id,
      channelId: work.id,
    });
    const { path } = await threads.file(home.id, alice, file!.id);
    expect(await Bun.file(path).text()).toStartWith("# Standup\n");
    expect(counted).toEqual([10 + 13 * 5000, 10, 10 + 13 * 5000]);
    expect(toolResults.at(-1)).toContain("counted");
    expect(toolResults.at(-1)).toContain(file!.id);
    expect(toolResults.at(-1)).not.toContain("said a thing");
  } finally {
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a connector tool saves a file it brings to the channel of the thread", async () => {
  const home = await shadow.app.companies.create(alice, "Bringing");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-bringing-"));
  const threads = savingThreads(
    dataDirectory,
    async () => null,
    {},
    {
      namespaces: () => [
        { name: "thread", prefix: "thread_", description: "Threads." },
      ],
      tools: async () => [
        {
          name: "thread_photo",
          description: "Saves the photo of a message",
          parameters: Type.Object({}),
          execute: async (_args, turn) =>
            turn.save!(async (path) => {
              await Bun.write(path, "photo");
              return "photo.jpg";
            }),
        },
      ],
    }
  );
  try {
    const summary = await threads.create(
      home.id,
      alice,
      general.id,
      "Run code: text(JSON.stringify(await tools.thread_photo({})));"
    );
    await answeredIn(threads, home.id, summary.id);
    const [file] = await threads.files({
      companyId: home.id,
      channelId: general.id,
    });
    expect(file).toMatchObject({ name: "photo.jpg" });
    const { path } = await threads.file(home.id, alice, file!.id);
    expect(await Bun.file(path).text()).toBe("photo");
    expect(toolResults.at(-1)).toContain(file!.id);
  } finally {
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test.each(["message"] as const)(
  "a connector tool asks its person before every call (%s)",
  async () => {
    const home = await shadow.app.companies.create(alice, "Sending");
    await shadow.app.companies.addMember(home.id, alice, bob.email);
    const general = shadow.app.companies.channels(home.id, alice)[0]!;
    const sent: string[] = [];
    const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-sending-"));
    const threads = savingThreads(
      dataDirectory,
      async () => null,
      {},
      {
        namespaces: () => [
          { name: "thread", prefix: "thread_", description: "Messages." },
        ],
        tools: async () => [
          {
            name: "thread_send",
            description: "Sends a message",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (args, turn) => {
              const { text } = args as { text: string };
              await turn.approve!(`Send: ${text}`, turn.userId);
              sent.push(text);
              return { sent: true };
            },
          },
        ],
      }
    );
    try {
      const requestText =
        'Run code: await tools.thread_send({ text: "Hi" }); await tools.thread_send({ text: "Bye" }); text("finished");';
      const summary = await threads.create(
        home.id,
        alice,
        general.id,
        requestText
      );
      const thread = shadow.app.companies
        .allThreadsIn(home.id)
        .find((candidate) => candidate.id === summary.id)!;
      const waiting = (text: string) =>
        until(
          () => threads.messages(thread),
          (state) => state.approvals[0]?.text === text
        ).then((state) => state.approvals[0]!);
      const first = await waiting("Send: Hi");
      expect(first).toMatchObject({
        tool: "thread_send",
        approverId: alice.id,
      });
      expect(() =>
        threads.answerApproval(thread.id, first.id, bob, true)
      ).toThrow("Only the person it asks can answer");
      expect(() =>
        threads.answerApproval(thread.id, "no-such-approval", alice, true)
      ).toThrow("Not found");
      threads.answerApproval(thread.id, first.id, alice, true);
      // An allowed send does not allow the next one; it asks again.
      const second = await waiting("Send: Bye");
      threads.answerApproval(thread.id, second.id, alice, false);
      await answeredIn(threads, home.id, thread.id);
      expect(sent).toEqual(["Hi"]);
      expect(toolResults.at(-1)).toContain("Alice did not allow this.");
    } finally {
      await threads.closeAll();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }
);

test("an approval's route answers 400 for a malformed answer and 404 for an approval or thread the person cannot see", async () => {
  const home = await shadow.app.companies.create(alice, "Approval route");
  const general = shadow.app.companies.channels(home.id, alice)[0]!;
  const thread = await shadow.app.threads.create(
    home.id,
    alice,
    general.id,
    "Hi"
  );
  const answer = async (token: string, body: object) =>
    (
      await shadow.call(`/api/v1/threads/${thread.id}/approvals/none`, {
        token,
        body,
      })
    ).status;
  const aliceToken = await shadow.signIn("Alice", "alice@example.com");
  const eveToken = await shadow.signIn("Eve", "eve@example.com");
  expect(await answer(aliceToken, { allow: "yes" })).toBe(400);
  expect(await answer(aliceToken, { allow: true })).toBe(404);
  expect(await answer(eveToken, { allow: true })).toBe(404);
});

test("every codemode script gets a deadline of at most 15 minutes", () => {
  expect(scriptWithDeadline('text("hi");')).toBe(
    '// @options: {"timeout_ms":900000}\ntext("hi");'
  );
  expect(
    scriptWithDeadline(
      '// @options: {"timeout_ms": 3600000, "max_output_tokens": 50}\ntext("hi");'
    )
  ).toBe(
    '// @options: {"timeout_ms":900000,"max_output_tokens":50}\ntext("hi");'
  );
  expect(scriptWithDeadline('// @options: {"timeout_ms": 50}\nx();')).toBe(
    '// @options: {"timeout_ms":50}\nx();'
  );
});

test("a script runs with its deadline and stops at it", async () => {
  const garden = await shadow.app.companies.create(alice, "Deadlines");
  const general = shadow.app.companies.channels(garden.id, alice)[0]!;
  const run = await shadow.app.threads.create(
    garden.id,
    alice,
    general.id,
    'Run code: // @options: {"timeout_ms": 200}\nwhile (true) {}'
  );
  await idle(garden.id, run.id);
  expect(toolResults.at(-1)).toContain("timed out");
});

/** Threads over the test app's companies and model, with a browser that the test gives. */
function savingThreads(
  dataDirectory: string,
  screenshot: () => Promise<Uint8Array | null>,
  browser: Partial<Pick<ThreadBrowser, "pdf" | "tools">> = {},
  integrations: ThreadIntegrations = shadow.app.integrations,
  sourceRead: ThreadHooks["sourceRead"] = (thread, ownerId, read) =>
    shadow.app.intake.recordSourceRead(thread, ownerId, read),
  sources: ThreadSources = {
    names: () => [],
    skills: () => [],
    tools: () => [],
  }
) {
  // Each save is a tool call and an answer after it.
  shadow.faux.appendResponses(Array.from({ length: 20 }, () => agent));
  // The test's web server is on this machine, which the egress proxy refuses everywhere else.
  const web = new Browser(
    undefined,
    new Egress((address) => address === "127.0.0.1" || address === "::1")
  );
  return new Threads(
    dataDirectory,
    shadow.app.llm,
    shadow.app.companies,
    integrations,
    shadow.app.artifacts,
    {
      pdf: () => Promise.reject(new Error("There is no browser.")),
      download: (address, destination, signal) =>
        web.download(address, destination, signal),
      screenshot,
      tools: () => [],
      ...browser,
    },
    { tools: () => [] },
    sources,
    shadow.app.notifications,
    {
      sourceRead,
      audit: (companyId, ownerId, trace, stage, data) =>
        shadow.app.intake.audit.record(trace, stage, companyId, ownerId, data),
      changed: () => undefined,
      moved: () => undefined,
      merged: () => undefined,
      recall: async () => ({ results: [] }),
      automations: () => "",
      suggest: () => undefined,
      read: (path) => Bun.file(path).text(),
      picture: async () => null,
      tools: async () => [],
    }
  );
}

function answeredIn(threads: Threads, companyId: string, threadId: string) {
  const thread = shadow.app.companies
    .allThreadsIn(companyId)
    .find((candidate) => candidate.id === threadId)!;
  return until(
    () => threads.messages(thread),
    (state) => !state.running && state.messages.at(-1)?.text === "Done."
  );
}

test("agents get the company's sources and their skills, and search them from a script", async () => {
  const company = await shadow.app.companies.create(alice, "Sourced");
  const [general] = shadow.app.companies.channels(company.id, alice);
  const dataDirectory = await mkdtemp(join(tmpdir(), "shadow-sources-"));
  const searched: string[] = [];
  const threads = savingThreads(
    dataDirectory,
    async () => null,
    {},
    shadow.app.integrations,
    undefined,
    {
      names: () => ["pipes"],
      skills: () => [
        {
          source: "pipes",
          name: "pipes-product",
          description: "Use when working with Pipes.",
          path: "skill/SKILL.md",
        },
      ],
      // A tool of its own, in place of the real search.
      tools: () =>
        [
          defineTool({
            name: "sources_search",
            description: "Search the sources",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (args) => {
              searched.push(args.text);
              return { output: [{ type: "text", text: "pipes/a.ts:1:hit" }] };
            },
          }),
        ] as unknown as ReturnType<ThreadSources["tools"]>,
    }
  );
  try {
    const before = systemPrompts.length;
    const { id } = await threads.create(
      company.id,
      alice,
      general!.id,
      'Run code: text(await tools.sources_search({ text: "stitching" }))'
    );
    await answeredIn(threads, company.id, id);
    expect(searched).toEqual(["stitching"]);
    expect(toolResults.at(-1)).toContain("pipes/a.ts:1:hit");
    const prompt = systemPrompts.slice(before).join("\n");
    expect(prompt).toContain("The company's sources: git repositories");
    expect(prompt).toContain(
      "- pipes-product (pipes/skill/SKILL.md): Use when working with Pipes."
    );
  } finally {
    await threads.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the model calls the core tools itself, and every other tool from codemode scripts by namespace", async () => {
  const company = await shadow.app.companies.create(alice, "Namespaces");
  const [channel] = shadow.app.companies.channels(company.id, alice);
  const before = systemPrompts.length;
  const summary = await shadow.app.threads.create(
    company.id,
    alice,
    channel!.id,
    "Hi"
  );
  const thread = shadow.app.companies.thread(summary.id, alice);
  await until(
    () => shadow.app.threads.messages(thread),
    (state) => !state.running && state.messages.length === 2
  );
  const request = systemPrompts.findIndex(
    (system, index) => index >= before && system.includes("You are Shadow")
  );
  expect(offeredTools[request]!.toSorted()).toEqual([
    "codemode",
    "create_channel",
    "delete_file",
    "list_channels",
    "list_files",
    "list_threads",
    "merge_channel",
    "move_thread",
    "notify",
    "read_file",
    "read_thread",
    "recall",
    "save_file",
    "search_channels",
    "send_to_thread",
    "start_thread",
  ]);
  const prompt = systemPrompts.slice(before).join("\n");
  for (const namespace of ["artifacts", "browser", "routines", "reminders"]) {
    expect(prompt).toContain(`## ${namespace}`);
  }
});

test("a channel's emoji is the first emoji of the model's answer", () => {
  expect(emojiOf(" 🏡 Home")).toBe("🏡");
  expect(emojiOf("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  expect(emojiOf("🇨🇿")).toBe("🇨🇿");
  expect(emojiOf("Home 🏡")).toBeNull();
  expect(emojiOf("")).toBeNull();
});

test("a source destination request reuses the same thread after a retry", async () => {
  const home = await shadow.app.companies.create(alice, "Destination retry");
  const channel = shadow.app.companies.createChannel(home.id, alice, "repairs");
  const request = { id: "intake:subject:repair-review", personId: alice.id };
  const first = await shadow.app.threads.startAgentThread(
    home.id,
    channel.id,
    "Repair claim",
    request
  );
  const retry = await shadow.app.threads.startAgentThread(
    home.id,
    channel.id,
    "Repair claim",
    request
  );
  expect(retry.id).toBe(first.id);
  expect(retry.conversationId).toBe(first.conversationId);
  expect(shadow.app.companies.threadsIn(home.id, alice.id)).toHaveLength(1);
});
