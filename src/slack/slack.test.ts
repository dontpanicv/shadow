import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fakeSlack } from "../../test/fake-slack.ts";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

let shadow: TestApp;
let alice: User;
/** What the faux model answers: the check gives `probability`, an agent turn `answer`. */
const model = { probability: 0.9, answer: "The invoice was paid on Friday." };
/** The Slack of the running test; the app's own bot speaks to it. */
let slack = fakeSlack();

beforeAll(async () => {
  shadow = await startTestApp({
    slack: {
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        slack.fetch(input, init)) as typeof fetch,
      connectTo: (url) => slack.connectTo(url),
    },
  });
  await shadow.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await shadow.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
});

afterAll(() => shadow.close());

/** The faux model's answer to a prompt: the check's probability, a channel's brief, or an agent's answer. */
function answerFor(prompt: string): string {
  if (prompt.includes("<conversation>")) {
    return JSON.stringify({ probability: model.probability });
  }
  if (prompt.includes("<brief>")) {
    return "<summary>Customer support.</summary>\n<brief>\n## Now\n- Invoices\n</brief>";
  }
  return model.answer;
}

/** A company with Slack connected and listening, and Shadow in its Slack. */
async function setup() {
  slack = fakeSlack();
  slack.emails = {
    U1: "alice@example.com",
    U2: "bob@example.com",
    U9: "mallory@elsewhere.example",
  };
  slack.users.U9 = "Mallory";
  const now = Date.now() / 1000;
  const root = (now - 600).toFixed(6);
  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "support" },
  ];
  slack.messages.C2 = [
    { ts: root, user: "U2", text: "Did the customer pay invoice 42?" },
  ];
  // One faux step for each model call: the check and the agent's turns answer from `model`.
  shadow.faux.setResponses(
    Array.from(
      { length: 60 },
      () => (context: { messages: readonly unknown[] }) =>
        fauxAssistantMessage(answerFor(JSON.stringify(context.messages)))
    )
  );
  const { companies, slackBot: bot, slack: surface } = shadow.app;
  const company = await companies.create(alice, "Acme");
  await bot.connect(company.id, alice, "xoxb-good", "xapp-good");
  await Bun.sleep(0);
  slack.send({ type: "hello" });
  await bot.flush(company.id);
  const support = companies
    .channels(company.id, alice)
    .find((channel) => channel.name === "support")!;
  const writes = (method: string) =>
    slack.writes.filter((write) => write.method === method);
  const close = () => {
    bot.disconnect(company.id, alice);
    return Promise.resolve();
  };
  return { bot, surface, company, support, root, writes, close };
}

test("a mention in a channel is a Shadow thread with the Slack thread before it, and its answer replaces the status", async () => {
  const { company, support, root, writes, close } = await setup();
  model.answer = "The invoice was paid on Friday. See [the plan](thread:t1).";
  slack.event({
    type: "app_mention",
    channel: "C2",
    user: "U1",
    text: "<@B1> did they pay?",
    ts: (Date.now() / 1000).toFixed(6),
    thread_ts: root,
  });
  const update = await until(
    async () => writes("chat.update"),
    (updates) =>
      updates.some((each) => JSON.stringify(each.body).includes("Friday"))
  );
  const status = writes("chat.postMessage")[0]!.body;
  expect(status).toMatchObject({ channel: "C2", thread_ts: root });
  expect(String(status.text)).toStartWith("Working");
  const answer = update.findLast((each) =>
    JSON.stringify(each.body).includes("Friday")
  )!.body;
  expect(answer.ts).toBe("1000001");
  const blocks = JSON.stringify(answer.blocks);
  // Shadow's own links open in Shadow, and the answer links its thread.
  expect(blocks).toContain(`(http://shadow.test/c/${company.id}/thread/t1)`);
  const thread = shadow.app.companies
    .allThreadsIn(company.id)
    .find((candidate) => candidate.channelId === support.id)!;
  expect(blocks).toContain(
    `/c/${company.id}/thread/${thread.id}|Open in Shadow`
  );
  const { messages } = await shadow.app.threads.messages(thread);
  expect(messages[0]!.text).toContain("Earlier in this Slack thread");
  expect(messages[0]!.text).toContain("Did the customer pay invoice 42?");
  expect(messages[0]!.text).toContain("did they pay?");
  expect(messages[0]!.author).toBe("Alice");

  // Someone whose email is not allowed gets one fixed answer.
  slack.event({
    type: "app_mention",
    channel: "C2",
    user: "U9",
    text: "<@B1> hello",
    ts: (Date.now() / 1000 + 1).toFixed(6),
  });
  await until(
    async () => writes("chat.postMessage"),
    (posts) =>
      posts.some((post) => String(post.body.text).includes("not allowed"))
  );
  await close();
});

test("a DM goes to the person's own thread, and a notice they did not see comes as a DM too", async () => {
  const { company, writes, close } = await setup();
  model.answer = "You have two meetings today.";
  slack.event({
    type: "message",
    channel_type: "im",
    channel: "D1",
    user: "U1",
    text: "What is on today?",
    ts: (Date.now() / 1000).toFixed(6),
  });
  await until(
    async () => writes("chat.update"),
    (updates) =>
      updates.some((each) => JSON.stringify(each.body).includes("two meetings"))
  );
  const own = await shadow.app.threads.orchestrator(company.id, alice);
  const { messages } = await shadow.app.threads.messages(own);
  expect(messages.some((message) => message.text === "What is on today?")).toBe(
    true
  );

  const general = shadow.app.companies.channels(company.id, alice)[0]!;
  shadow.app.notifications.notify({
    companyId: company.id,
    userId: alice.id,
    channelId: general.id,
    threadId: null,
    title: "Reminder",
    text: "Call Anna about the contract.",
  });
  await until(
    async () => writes("chat.postMessage"),
    (posts) =>
      posts.some(
        (post) =>
          post.body.channel === "D-U1" &&
          JSON.stringify(post.body).includes("Call Anna")
      )
  );
  await close();
});

test("Shadow listens only where a goal or its own reply asks it to: the check skips, the agent stays quiet or answers, and mute stops it", async () => {
  const { surface, company, support, writes, close } = await setup();
  // Each message is newer than the one before, as in Slack.
  let tick = 0;
  const say = (text: string, thread?: string) => {
    tick += 1;
    const ts = (Date.now() / 1000 + tick).toFixed(6);
    const message = {
      type: "message",
      channel: "C2",
      user: "U2",
      text,
      ts,
      ...(thread ? { thread_ts: thread } : {}),
    };
    slack.messages.C2!.unshift(message);
    slack.event(message);
    return ts;
  };
  const decisions = () => surface.decisions(company.id, alice);

  // Without a goal, a message costs nothing.
  say("Lunch at noon?");
  await Bun.sleep(50);
  expect(decisions()).toEqual([]);

  surface.setGoal(company.id, alice, support.id, {
    wakeWhen: "questions about invoices and payments",
    engagement: "answer with the source, briefly",
  });
  model.probability = 0.05;
  say("Lunch at noon?");
  await until(
    async () => decisions(),
    (list) => list.length === 1
  );
  expect(decisions()[0]).toMatchObject({
    outcome: "skipped",
    reason: "decided",
  });

  model.probability = 0.9;
  model.answer = "QUIET";
  say("Paying invoice 7 now");
  await until(
    async () => decisions(),
    (list) => list.length === 2
  );
  expect(decisions()[0]!.outcome).toBe("quiet");

  model.answer = "Invoice 42 was paid on Friday.";
  const asked = say("Was invoice 42 paid?");
  await until(
    async () => decisions(),
    (list) => list.length === 3
  );
  expect(decisions()[0]!.outcome).toBe("replied");
  const reply = writes("chat.postMessage").findLast((post) =>
    JSON.stringify(post.body).includes("Invoice 42 was paid")
  )!.body;
  expect(reply.thread_ts).toBe(asked);
  expect(JSON.stringify(reply.blocks)).toContain("shadow_mute");
  // The log keeps why, never what people wrote.
  expect(JSON.stringify(decisions())).not.toContain("invoice");

  // A reply in a thread that Shadow answered goes through the check, until someone mutes the thread.
  slack.send({
    type: "interactive",
    payload: {
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "C2" },
      message: { ts: String(reply.ts ?? "") },
      actions: [
        {
          action_id: "shadow_mute",
          value: JSON.stringify({ channel: "C2", root: asked }),
        },
      ],
    },
  });
  await until(
    async () => writes("chat.postEphemeral"),
    (ephemeral) => ephemeral.length === 1
  );
  say("Thanks!", asked);
  await until(
    async () => decisions(),
    (list) => list.length === 4
  );
  expect(decisions()[0]!.outcome).toBe("muted");
  await close();
});

test("a routine that posts in Slack posts each answer at the top of its Slack channel", async () => {
  const { company, support, surface, writes, close } = await setup();
  await surface.postRoutine(
    { companyId: company.id, channelId: support.id, name: "Weekly support" },
    "Three tickets are open."
  );
  const post = writes("chat.postMessage").at(-1)!.body;
  expect(post.channel).toBe("C2");
  expect(post.thread_ts).toBeUndefined();
  expect(JSON.stringify(post.blocks)).toContain("Weekly support");
  await close();
});
