import { afterAll, beforeAll, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fakeSlack } from "../../test/fake-slack.ts";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import { noticeTools } from "./tools.ts";

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
  const statusWrite = writes("chat.postMessage")[0]!;
  const status = statusWrite.body;
  expect(status).toMatchObject({ channel: "C2", thread_ts: root });
  expect(String(status.text)).toStartWith("Working");
  const answer = update.findLast((each) =>
    JSON.stringify(each.body).includes("Friday")
  )!.body;
  expect(answer.ts).toBe(statusWrite.ts);
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
  // The person looks at #support in Slack while they write.
  slack.event({
    type: "app_context_changed",
    user: "U1",
    context: { entities: [{ type: "slack#/types/channel_id", value: "C2" }] },
  });
  const asked = (Date.now() / 1000).toFixed(6);
  slack.event({
    type: "message",
    channel_type: "im",
    channel: "D1",
    user: "U1",
    text: "What is on today?",
    ts: asked,
  });
  await until(
    async () => writes("chat.update"),
    (updates) =>
      updates.some((each) => JSON.stringify(each.body).includes("two meetings"))
  );
  const own = await shadow.app.threads.orchestrator(company.id, alice);
  const { messages } = await shadow.app.threads.messages(own);
  expect(messages.at(-2)!.text).toBe(
    "What is on today?\n\n(In Slack, Alice is looking at <#C2>.)"
  );
  // The answer goes in the agent session's thread, whose status shows the work.
  expect(
    writes("chat.postMessage").find((post) => post.body.channel === "D1")!.body
      .thread_ts
  ).toBe(asked);
  expect(
    writes("agents.sessions.setStatus").map((write) => write.body.status)
  ).toEqual(["processing", "active"]);

  const general = shadow.app.companies.channels(company.id, alice)[0]!;
  shadow.app.notifications.notify({
    companyId: company.id,
    userId: alice.id,
    channelId: general.id,
    threadId: null,
    title: "Reminder",
    // The inbox keeps the start of a long notification; the DM has all of it, such as a whole morning briefing.
    text: `Call Anna about the contract.\n\n${"- One more matter.\n".repeat(60)}- **The last matter.**`,
  });
  await until(
    async () => writes("chat.postMessage"),
    (posts) =>
      posts.some(
        (post) =>
          post.body.channel === "D-U1" &&
          JSON.stringify(post.body).includes("Call Anna") &&
          JSON.stringify(post.body).includes("**The last matter.**")
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

test("the default goal lets Shadow listen in every channel, until an admin switches one off or takes the default away", async () => {
  const { surface, company, support, close } = await setup();
  let tick = 0;
  const say = (text: string) => {
    tick += 1;
    const message = {
      type: "message",
      channel: "C2",
      user: "U2",
      text,
      ts: (Date.now() / 1000 + tick).toFixed(6),
    };
    slack.messages.C2!.unshift(message);
    slack.event(message);
  };
  const decisions = () => surface.decisions(company.id, alice);
  model.probability = 0.9;
  model.answer = "QUIET";

  surface.setDefaultGoal(company.id, alice, {
    wakeWhen: "questions that the company's sources answer",
    engagement: "answer briefly, with the source",
  });
  expect(surface.defaultGoal(company.id, alice).wakeWhen).toBe(
    "questions that the company's sources answer"
  );
  // A channel without its own goal listens with the default one.
  expect(
    surface
      .goals(company.id, alice)
      .find((goal) => goal.channelId === support.id)
  ).toMatchObject({ wakeWhen: null, off: false });
  say("Where is the price list?");
  await until(
    async () => decisions(),
    (list) => list.length === 1
  );
  expect(decisions()[0]!.outcome).toBe("quiet");

  // Off stops listening, whatever the goals say.
  surface.setOff(company.id, alice, support.id, true);
  say("Where is the old price list?");
  await Bun.sleep(50);
  expect(decisions()).toHaveLength(1);

  // A channel's own goal is the consent to listen there again.
  surface.setGoal(company.id, alice, support.id, {
    wakeWhen: "questions about invoices",
    engagement: "answer briefly",
  });
  expect(
    surface
      .goals(company.id, alice)
      .find((goal) => goal.channelId === support.id)
  ).toMatchObject({ wakeWhen: "questions about invoices", off: false });

  // Without its own goal and without the default, the channel answers only mentions.
  surface.removeGoal(company.id, alice, support.id);
  surface.removeDefaultGoal(company.id, alice);
  say("Anyone for lunch?");
  await Bun.sleep(50);
  expect(decisions()).toHaveLength(1);
  expect(surface.defaultGoal(company.id, alice)).toEqual({
    wakeWhen: null,
    engagement: null,
  });
  await close();
});

test("a mention in a group DM answers once, from the asker's own thread, with the group's conversation as data", async () => {
  const { company, writes, close } = await setup();
  model.answer = "Acme renewed in May.";
  slack.joined.add("G1");
  slack.messages.G1 = [
    {
      ts: (Date.now() / 1000 - 60).toFixed(6),
      user: "U2",
      text: "Are we on for the Acme call?",
    },
  ];
  const mention = {
    channel: "G1",
    user: "U1",
    text: "<@B1> what do we know about Acme?",
    ts: (Date.now() / 1000).toFixed(6),
  };
  // Slack sends a group DM's mention twice: as a message and as an app_mention.
  slack.event({ type: "message", channel_type: "mpim", ...mention });
  slack.event({ type: "app_mention", ...mention });
  await until(
    async () => writes("chat.update"),
    (updates) =>
      updates.some((each) => JSON.stringify(each.body).includes("renewed"))
  );
  expect(
    writes("chat.postMessage").filter((post) => post.body.channel === "G1")
  ).toHaveLength(1);
  const own = await shadow.app.threads.orchestrator(company.id, alice);
  const { messages } = await shadow.app.threads.messages(own);
  const request = messages.findLast((message) => !message.agent)!.text;
  expect(request).toContain(
    "Alice asks you in a Slack group DM: what do we know about Acme?"
  );
  expect(request).toContain("- Bob Smith: Are we on for the Acme call?");
  expect(request).toContain("leave out what only Alice may see");
  await close();
});

test("a mention in a private channel answers from the asker's own thread, with the channel's conversation as data", async () => {
  const { company, writes, close } = await setup();
  model.answer = "Acme renewed in May.";
  slack.joined.add("P1");
  slack.messages.P1 = [
    {
      ts: (Date.now() / 1000 - 60).toFixed(6),
      user: "U2",
      text: "Did Acme sign?",
    },
  ];
  slack.event({
    type: "app_mention",
    channel: "P1",
    user: "U1",
    text: "<@B1> what do we know about Acme?",
    ts: (Date.now() / 1000).toFixed(6),
  });
  await until(
    async () => writes("chat.update"),
    (updates) =>
      updates.some((each) => JSON.stringify(each.body).includes("renewed"))
  );
  const own = await shadow.app.threads.orchestrator(company.id, alice);
  const { messages } = await shadow.app.threads.messages(own);
  const request = messages.findLast((message) => !message.agent)!.text;
  expect(request).toContain(
    "Alice asks you in a Slack private channel #p1: what do we know about Acme?"
  );
  expect(request).toContain("- Bob Smith: Did Acme sign?");
  expect(request).toContain("leave out what only Alice may see");
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

test("each turn has its own realm: a mention is the asker's, an ambient turn nobody's, so it has no private data or personal accounts", async () => {
  const { company, support, root, close } = await setup();
  model.answer = "Paid.";
  slack.event({
    type: "app_mention",
    channel: "C2",
    user: "U1",
    text: "<@B1> did they pay?",
    ts: (Date.now() / 1000).toFixed(6),
    thread_ts: root,
  });
  const asked = await until(
    async () =>
      shadow.app.companies
        .allThreadsIn(company.id)
        .find((thread) => thread.channelId === support.id),
    Boolean
  );
  await until(
    async () => shadow.app.threads.messages(asked!),
    (state) => !state.running && state.messages.at(-1)?.agent === true
  );
  expect(
    await shadow.app.threads.realm(company.id, asked!.conversationId as never)
  ).toBe(alice.id);

  shadow.app.slack.setGoal(company.id, alice, support.id, {
    wakeWhen: "questions about invoices",
    engagement: "answer briefly",
  });
  model.probability = 0.9;
  model.answer = "Invoice 7 is due Friday.";
  const ts = (Date.now() / 1000 + 5).toFixed(6);
  const message = {
    type: "message",
    channel: "C2",
    user: "U2",
    text: "When is invoice 7 due?",
    ts,
  };
  slack.messages.C2!.unshift(message);
  slack.event(message);
  await until(
    async () => shadow.app.slack.decisions(company.id, alice),
    (list) => list.some((decision) => decision.outcome === "replied")
  );
  const ambient = shadow.app.companies
    .allThreadsIn(company.id)
    .find(
      (thread) => thread.id !== asked!.id && thread.channelId === support.id
    )!;
  expect(
    await shadow.app.threads.realm(company.id, ambient.conversationId as never)
  ).toBeNull();
  expect(
    await shadow.app.threads.requester(
      company.id,
      ambient.conversationId as never
    )
  ).toBeNull();
  await close();
});

test("search finds the Slack history for every member, and a DM only for its person", async () => {
  const { company, close } = await setup();
  model.answer = "Noted.";
  slack.event({
    type: "message",
    channel_type: "im",
    channel: "D1",
    user: "U1",
    text: "Remember the flamingo budget",
    ts: (Date.now() / 1000).toFixed(6),
  });
  const own = await shadow.app.threads.orchestrator(company.id, alice);
  await until(
    async () => shadow.app.threads.messages(own),
    (state) => !state.running && state.messages.at(-1)?.agent === true
  );
  await shadow.app.indexer.scan(company.id);
  const found = async (query: string, realm: string | null) =>
    (await shadow.app.indexer.search(company.id, query, 10, realm)).results;
  expect(
    (await found("invoice 42", null)).some((result) =>
      /-slack-\d{4}-\d{2}-\d{2}\.md$/.test(result.uri)
    )
  ).toBe(true);
  expect(await found("flamingo", alice.id)).not.toEqual([]);
  expect(await found("flamingo", "someone-else")).toEqual([]);
  expect(await found("flamingo", null)).toEqual([]);
  await close();
});

test("an unasked turn offers a routine, and it becomes the person's own, posting in Slack, only when they accept", async () => {
  const { company, support, writes, close } = await setup();
  const thread = await shadow.app.threads.startAgentThread(
    company.id,
    support.id,
    "Weekly numbers"
  );
  const root = (Date.now() / 1000).toFixed(6);
  shadow.app.database
    .query(
      "INSERT INTO slack_conversation (company_id, slack_channel_id, root_ts, thread_id) VALUES (?, 'C2', ?, ?)"
    )
    .run(company.id, root, thread.id);
  // Both people write in Slack once, so Shadow knows them.
  const { companies } = shadow.app;
  for (const user of ["U1", "U2"]) {
    shadow.app.database
      .query(
        "INSERT INTO slack_member (company_id, slack_user_id, user_id) SELECT ?, ?, id FROM user WHERE email = ?"
      )
      .run(company.id, user, slack.emails[user]!);
  }
  await companies.memberByEmail(company.id, "bob@example.com", "Bob");
  const [, suggest] = noticeTools(
    companies,
    shadow.app.notifications,
    shadow.app.agenda,
    shadow.app.slack,
    company.id
  );
  await suggest!.execute(
    {
      text: "",
      person: "alice@example.com",
      kind: "routine",
      name: "Weekly numbers",
      schedule: "0 9 * * 1",
      instructions: "Sum up the week's invoices.",
    },
    { conversationId: thread.conversationId, taskId: "offer-1" } as never,
    BACKGROUND_CONTEXT
  );
  const offer = writes("chat.postMessage").at(-1)!;
  expect(offer.body.thread_ts).toBe(root);
  expect(JSON.stringify(offer.body.blocks)).toContain("<@U1>, I can set up");
  const value = JSON.parse(
    JSON.stringify(offer.body.blocks)
      .match(/"value":"(\{[^}]*\})"/)![1]!
      .replaceAll('\\"', '"')
  ) as { id: string };
  const click = (user: string, action: string) =>
    slack.send({
      type: "interactive",
      payload: {
        type: "block_actions",
        user: { id: user },
        channel: { id: "C2" },
        message: { ts: offer.ts },
        actions: [
          {
            action_id: action,
            value: JSON.stringify({ id: value.id, kind: "routine" }),
          },
        ],
      },
    });
  click("U2", "shadow_accept");
  await until(
    async () => writes("chat.postEphemeral"),
    (ephemeral) =>
      ephemeral.some((each) =>
        String(each.body.text).startsWith("Only the person")
      )
  );
  expect(shadow.app.routines.inCompany(company.id, alice.id)).toEqual([]);
  click("U1", "shadow_accept");
  const [routine] = await until(
    async () => shadow.app.routines.inCompany(company.id, alice.id),
    (routines) => routines.length === 1
  );
  expect(routine).toMatchObject({
    name: "Weekly numbers",
    schedule: "0 9 * * 1",
    channelId: support.id,
    postInSlack: true,
  });
  await close();
});

test("a routine asked for in a person's own thread runs in their own channel, and a turn without a person makes none", async () => {
  const { company, close } = await setup();
  const own = await shadow.app.threads.orchestrator(company.id, alice);
  const create = (await shadow.app.routines.tools(company.id)).find(
    (tool) => tool.name === "routines_create"
  )!;
  const ask = (taskId: string) =>
    create.execute(
      {
        name: "Mondays",
        schedule: "0 9 * * 1",
        instructions: "Tell me what needs me.",
      },
      { conversationId: own.conversationId, taskId } as never,
      BACKGROUND_CONTEXT
    );
  await expect(ask("routine-1")).rejects.toThrow(
    "Only a person's own request makes a routine."
  );
  await shadow.app.threads.send(own.id, alice, "Hello");
  await until(
    () => shadow.app.threads.messages(own),
    (state) => !state.running && state.messages.length === 2
  );
  await ask("routine-2");
  const [routine] = shadow.app.routines.inCompany(company.id, alice.id);
  const personal = shadow.app.companies.personalChannelOf(company.id, alice);
  expect(personal).toMatchObject({ ownerId: alice.id, personal: true });
  expect(routine).toMatchObject({
    name: "Mondays",
    channelId: personal.id,
  });
  await close();
});
