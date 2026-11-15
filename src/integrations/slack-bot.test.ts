import { afterAll, beforeAll, expect, test } from "bun:test";
import { fakeSlack } from "../../test/fake-slack.ts";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import { Secrets } from "../platform/secrets.ts";
import { SlackBot } from "./slack-bot.ts";
import type {
  SlackHistoryMessage,
  SlackHistoryPorts,
} from "./slack-history.ts";

let shadow: TestApp;
let alice: User;
let bob: User;

beforeAll(async () => {
  shadow = await startTestApp();
  const { internalAdapter } = await shadow.app.auth.$context;
  const person = async (name: string, email: string): Promise<User> => {
    await shadow.signIn(name, email);
    const { user } = (await internalAdapter.findUserByEmail(email))!;
    return { id: user.id, name: user.name, email: user.email };
  };
  alice = await person("Alice", "alice@example.com");
  bob = await person("Bob", "bob@example.com");
});

afterAll(() => shadow.close());

async function setup() {
  const slack = fakeSlack();
  const company = await shadow.app.companies.create(alice, "Acme");
  await shadow.app.companies.addMember(company.id, alice, bob.email);
  const changed: string[] = [];
  const writes: string[] = [];
  const briefed: SlackHistoryMessage[][] = [];
  const { threads } = shadow.app;
  const ports: SlackHistoryPorts = {
    writeFile: (companyId, channelId, file, replaces) => {
      writes.push(file.name);
      return threads.writeFile(companyId, channelId, alice, file, replaces);
    },
    deleteFile: async (companyId, fileId) => {
      await threads.deleteFile(companyId, alice, fileId);
    },
    brief: async (_companyId, _channelId, messages) => {
      briefed.push([...messages]);
    },
  };
  const bot = new SlackBot(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    (companyId) => changed.push(companyId),
    ports,
    { fetch: slack.fetch, connectTo: slack.connectTo }
  );
  const names = () =>
    shadow.app.companies
      .channels(company.id, alice)
      .filter((channel) => !channel.personal)
      .map((channel) => [channel.name, channel.ownerId === null]);
  /** The bot's connection opens, and it does what a new connection does. */
  const connected = async () => {
    await Bun.sleep(0);
    slack.send({ type: "hello" });
    await bot.flush(company.id);
  };
  return { slack, bot, company, changed, names, writes, briefed, connected };
}

test("an admin connects the Slack bot with its two tokens, and its public channels become the channels that every member sees", async () => {
  const { slack, bot, company, changed, names, connected } = await setup();
  slack.channels = [
    { id: "C1", name: "company", is_general: true, purpose: { value: "" } },
    { id: "C2", name: "sales", purpose: { value: "Deals and leads" } },
    { id: "C3", name: "dev_ops" },
  ];
  // A private channel of Alice already has the name of a Slack channel.
  shadow.app.companies.createChannel(company.id, alice, "sales");

  expect(() => bot.status(company.id, bob)).toThrow(
    "Only an admin can do this"
  );
  await expect(
    bot.connect(company.id, bob, "xoxb-good", "xapp-good")
  ).rejects.toThrow("Only an admin can do this");
  await expect(
    bot.connect(company.id, alice, "xoxp-user", "xapp-good")
  ).rejects.toThrow("Use the bot token of the Slack app");
  await expect(
    bot.connect(company.id, alice, "xoxb-good", "xoxb-good")
  ).rejects.toThrow("Use the app-level token of the Slack app");
  await expect(
    bot.connect(company.id, alice, "xoxb-bad", "xapp-good")
  ).rejects.toThrow("Slack refused the bot token: invalid_auth");
  await expect(
    bot.connect(company.id, alice, "xoxb-good", "xapp-bad")
  ).rejects.toThrow("Slack refused the app token: invalid_auth");

  const status = await bot.connect(
    company.id,
    alice,
    " xoxb-good ",
    "xapp-good"
  );
  expect(status).toMatchObject({ connected: true, team: "Acme", error: null });
  // Slack's general channel takes over #general, where the orchestrators live.
  expect(names()).toEqual([
    ["company", true],
    ["sales", false],
    ["sales-slack", true],
    ["dev_ops", true],
  ]);
  const channels = shadow.app.companies.channels(company.id, alice);
  expect(
    channels.find((channel) => channel.name === "sales-slack")
  ).toMatchObject({ slackId: "C2", summary: "Deals and leads" });
  expect(changed).toEqual([company.id]);
  // The tokens stay encrypted on the server.
  const row = shadow.app.database
    .query("SELECT token, app_token FROM slack_bot WHERE company_id = ?")
    .get(company.id) as { token: Uint8Array; app_token: Uint8Array };
  expect(Buffer.from(row.token).toString()).not.toContain("xoxb-good");
  expect(Buffer.from(row.app_token).toString()).not.toContain("xapp-good");

  await connected();
  expect(bot.status(company.id, alice)).toMatchObject({ listening: true });
  // Shadow acknowledges each envelope, as Socket Mode asks.
  expect(JSON.parse(slack.sockets.at(-1)!.sent[0]!)).toHaveProperty(
    "envelope_id"
  );
  // Nothing changed in Slack, so nothing changes here.
  expect(changed).toHaveLength(1);
  await bot.close();
});

test("a channel event lists the channels again: a rename follows, an archived channel hides with its threads, and it comes back", async () => {
  const { slack, bot, company, names, connected } = await setup();
  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "support" },
  ];
  await bot.connect(company.id, alice, "xoxb-good", "xapp-good");
  await connected();
  const support = shadow.app.companies
    .channels(company.id, alice)
    .find((channel) => channel.name === "support")!;
  const thread = await shadow.app.threads.create(
    company.id,
    alice,
    support.id,
    "A customer waits"
  );

  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "customer-care" },
  ];
  slack.event({ type: "channel_rename", channel: { id: "C2" } });
  await bot.flush(company.id);
  expect(names()).toEqual([
    ["general", true],
    ["customer-care", true],
  ]);

  slack.channels = [{ id: "C1", name: "general", is_general: true }];
  slack.event({ type: "channel_archive", channel: "C2" });
  await bot.flush(company.id);
  expect(names()).toEqual([["general", true]]);
  expect(() => shadow.app.companies.thread(thread.id, alice)).toThrow();

  slack.channels.push({ id: "C2", name: "customer-care" });
  slack.event({ type: "channel_unarchive", channel: "C2" });
  await bot.flush(company.id);
  expect(names()).toEqual([
    ["general", true],
    ["customer-care", true],
  ]);
  expect(shadow.app.companies.thread(thread.id, alice).channelId).toBe(
    support.id
  );
  await bot.close();
});

test("a failed reading keeps its error until one works, and a disconnect stops listening and keeps the channels", async () => {
  const { slack, bot, company, names, connected } = await setup();
  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "design" },
  ];
  await bot.connect(company.id, alice, "xoxb-good", "xapp-good");
  await connected();
  slack.token = "xoxb-rotated";
  slack.event({ type: "channel_created", channel: { id: "C3" } });
  await bot.flush(company.id);
  expect(bot.status(company.id, alice)).toMatchObject({
    connected: true,
    error: "invalid_auth",
  });

  bot.disconnect(company.id, alice);
  expect(slack.sockets.at(-1)!.closed).toBe(true);
  expect(bot.status(company.id, alice)).toEqual({
    connected: false,
    listening: false,
    team: null,
    syncedAt: null,
    error: null,
  });
  expect(names()).toEqual([
    ["general", true],
    ["design", true],
  ]);
  await bot.close();
});

test("a new channel gets its last 30 days at once, events bring each change, and a new connection reads only what it missed", async () => {
  const { slack, bot, company, writes, briefed, connected } = await setup();
  const now = Date.now() / 1000;
  const ts = (secondsAgo: number) => (now - secondsAgo).toFixed(6);
  const day = (stamp: string) =>
    new Date(Number(stamp) * 1000).toLocaleDateString("sv-SE");
  const invoice = ts(2 * 86_400);
  const paid = ts(2 * 86_400 - 60);
  const shipping = ts(3600);
  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "support" },
  ];
  slack.messages.C2 = [
    { ts: shipping, user: "U1", text: "Shipping today" },
    {
      ts: ts(2 * 86_400 + 10),
      subtype: "channel_join",
      user: "U2",
      text: "joined",
    },
    {
      ts: invoice,
      user: "U2",
      text: "<@U1> the invoice is <https://pay.example/1|here> &amp; due",
      reply_count: 1,
      latest_reply: paid,
      files: [
        {
          id: "F1",
          name: "invoice.pdf",
          size: 10,
          url_private_download: "https://files.slack.example/F1/invoice.pdf",
        },
      ],
    },
    // Older than 30 days: never read.
    { ts: ts(40 * 86_400), user: "U1", text: "Ancient history" },
  ];
  slack.replies[invoice] = [
    { ts: paid, thread_ts: invoice, user: "U1", text: "Paid" },
  ];

  await bot.connect(company.id, alice, "xoxb-good", "xapp-good");
  await connected();
  expect(bot.status(company.id, alice).error).toBeNull();
  expect(slack.joined.has("C2")).toBe(true);
  const support = shadow.app.companies
    .channels(company.id, alice)
    .find((channel) => channel.name === "support")!;
  const fileText = async (name: string) => {
    const files = await shadow.app.threads.files({
      companyId: company.id,
      channelId: support.id,
    });
    const file = files.find((each) => each.name === name)!;
    const { path } = await shadow.app.threads.file(company.id, alice, file.id);
    return { id: file.id, text: await Bun.file(path).text() };
  };
  const pdf = await fileText("invoice.pdf");
  expect(pdf.text).toBe("bytes of /F1/invoice.pdf");
  const invoiceDay = await fileText(`slack-${day(invoice)}.md`);
  expect(invoiceDay.text).toContain("**Bob Smith**, ");
  expect(invoiceDay.text).toContain(
    "@Alice Novak the invoice is [here](https://pay.example/1) & due"
  );
  expect(invoiceDay.text).toContain(
    `Attachments: [invoice.pdf](file:${pdf.id})`
  );
  // Each time links to its message, with the IDs that the slack_ tools of a person's account take.
  expect(invoiceDay.text).toStartWith(
    `# [#support](https://acme.slack.com/archives/C2), ${day(invoice)}`
  );
  expect(invoiceDay.text).toContain(
    `(https://acme.slack.com/archives/C2/p${invoice.replace(".", "")})`
  );
  expect(invoiceDay.text).toContain(
    `(https://acme.slack.com/archives/C2/p${paid.replace(".", "")}?thread_ts=${invoice}&cid=C2)`
  );
  expect(invoiceDay.text).toContain("> **Alice Novak**, ");
  expect(invoiceDay.text).toContain("> Paid");
  expect(invoiceDay.text).not.toContain("joined");
  expect(invoiceDay.text).not.toContain("Ancient history");
  expect((await fileText(`slack-${day(shipping)}.md`)).text).toContain(
    "Shipping today"
  );
  // The brief reads every message once, oldest first, with the link of its day file.
  expect(briefed).toHaveLength(1);
  expect(briefed[0]!.map((message) => [message.author, message.text])).toEqual([
    [
      "Bob Smith",
      "@Alice Novak the invoice is [here](https://pay.example/1) & due",
    ],
    ["Alice Novak", "Paid"],
    ["Alice Novak", "Shipping today"],
  ]);
  expect(briefed[0]![0]!.file).toEqual({
    id: invoiceDay.id,
    name: `slack-${day(invoice)}.md`,
  });

  // Events: an edit, a new reply to an older thread, and a deleted reply. Slack is not read for them.
  const reads = slack.calls.filter(
    (call) => call.method === "/api/conversations.history"
  ).length;
  slack.event({
    type: "message",
    subtype: "message_changed",
    channel: "C2",
    message: { ts: shipping, user: "U1", text: "Shipping tomorrow" },
  });
  const late = ts(60);
  slack.event({
    type: "message",
    channel: "C2",
    ts: late,
    thread_ts: invoice,
    user: "U2",
    text: "Receipt sent",
  });
  slack.event({
    type: "message",
    subtype: "message_deleted",
    channel: "C2",
    deleted_ts: paid,
  });
  await bot.flush(company.id);
  expect(
    slack.calls.filter((call) => call.method === "/api/conversations.history")
  ).toHaveLength(reads);
  const changedDay = await fileText(`slack-${day(invoice)}.md`);
  expect(changedDay.id).toBe(invoiceDay.id);
  expect(changedDay.text).toContain("> Receipt sent");
  expect(changedDay.text).not.toContain("Paid");
  expect((await fileText(`slack-${day(shipping)}.md`)).text).toContain(
    "Shipping tomorrow"
  );
  // Oldest first: the edited message is an hour old, the new reply a minute.
  expect(briefed.at(-1)!.map((message) => message.text)).toEqual([
    "Shipping tomorrow",
    "Receipt sent",
  ]);

  // Slack refreshes the connection; a message came between the two. The new one reads only from the last event.
  slack.messages.C2.unshift({ ts: ts(1), user: "U1", text: "Back online" });
  slack.send({ type: "disconnect", reason: "refresh_requested" });
  await connected();
  const history = slack.calls.filter(
    (call) => call.method === "/api/conversations.history"
  );
  expect(Number(history.at(-1)!.query.get("oldest"))).toBeGreaterThan(
    now - 3600
  );
  expect((await fileText(`slack-${day(ts(1))}.md`)).text).toContain(
    "Back online"
  );

  // Nothing changed: no file is written again, and the brief reads nothing.
  const before = [writes.length, briefed.length];
  await bot.flush(company.id);
  expect([writes.length, briefed.length]).toEqual(before);
  await bot.close();
});
