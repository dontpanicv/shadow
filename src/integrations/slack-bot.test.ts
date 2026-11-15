import { afterAll, beforeAll, expect, test } from "bun:test";
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

/**
 * A Slack whose channels, messages, and replies a test changes. It answers the methods that the bot calls, lists the
 * channels in two pages, and answers `not_in_channel` until the bot joins a channel.
 */
function fakeSlack() {
  const slack = {
    channels: [] as Record<string, unknown>[],
    /** The messages of each channel, newest first, with the replies of each thread in `replies`. */
    messages: {} as Record<string, Record<string, unknown>[]>,
    replies: {} as Record<string, Record<string, unknown>[]>,
    users: { U1: "Alice Novak", U2: "Bob Smith" } as Record<string, string>,
    joined: new Set<string>(),
    token: "xoxb-good",
    calls: [] as string[],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      slack.calls.push(url.pathname);
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== `Bearer ${slack.token}`) {
        return Response.json({ ok: false, error: "invalid_auth" });
      }
      const query = url.searchParams;
      const channel = query.get("channel") ?? "";
      switch (url.pathname) {
        case "/api/auth.test":
          return Response.json({ ok: true, team: "Acme", team_id: "T1" });
        case "/api/conversations.join":
          slack.joined.add(channel);
          return Response.json({ ok: true });
        case "/api/conversations.history": {
          if (slack.messages[channel] && !slack.joined.has(channel)) {
            return Response.json({ ok: false, error: "not_in_channel" });
          }
          const oldest = Number(query.get("oldest"));
          return Response.json({
            ok: true,
            messages: (slack.messages[channel] ?? []).filter(
              (message) => Number(message.ts) >= oldest
            ),
          });
        }
        case "/api/conversations.replies": {
          const ts = query.get("ts")!;
          const parent = slack.messages[channel]!.find(
            (message) => message.ts === ts
          )!;
          return Response.json({
            ok: true,
            messages: [parent, ...(slack.replies[ts] ?? [])],
          });
        }
        case "/api/users.info": {
          const id = query.get("user")!;
          return Response.json({
            ok: true,
            user: { real_name: slack.users[id] },
          });
        }
        case "/api/conversations.list": {
          // Two pages, so the bot follows the cursor.
          const second = query.get("cursor") === "next";
          const half = Math.ceil(slack.channels.length / 2);
          return Response.json({
            ok: true,
            channels: second
              ? slack.channels.slice(half)
              : slack.channels.slice(0, half),
            response_metadata: { next_cursor: second ? "" : "next" },
          });
        }
        default:
          // An attachment's download.
          return new Response(`bytes of ${url.pathname}`);
      }
    }) as typeof fetch,
  };
  return slack;
}

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
    slack.fetch
  );
  const names = () =>
    shadow.app.companies
      .channels(company.id, alice)
      .map((channel) => [channel.name, channel.ownerId === null]);
  return { slack, bot, company, changed, names, writes, briefed };
}

test("an admin connects the Slack bot, and its public channels become the channels that every member sees", async () => {
  const { slack, bot, company, changed, names } = await setup();
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
  await expect(bot.connect(company.id, bob, "xoxb-good")).rejects.toThrow(
    "Only an admin can do this"
  );
  await expect(bot.connect(company.id, alice, "xoxp-user")).rejects.toThrow(
    "Use the bot token of the Slack app"
  );
  await expect(bot.connect(company.id, alice, "xoxb-bad")).rejects.toThrow(
    "Slack refused the token: invalid_auth"
  );

  const status = await bot.connect(company.id, alice, " xoxb-good ");
  expect(status).toMatchObject({ connected: true, team: "Acme", error: null });
  expect(status.syncedAt).toBeNumber();
  // Slack's general channel takes over #general, where the orchestrators live.
  expect(names()).toEqual([
    ["company", true],
    ["sales", false],
    ["sales-slack", true],
    ["dev-ops", true],
  ]);
  const channels = shadow.app.companies.channels(company.id, alice);
  expect(
    channels.find((channel) => channel.name === "sales-slack")
  ).toMatchObject({ slackId: "C2", summary: "Deals and leads" });
  expect(changed).toEqual([company.id]);
  // The token stays encrypted on the server.
  const row = shadow.app.database
    .query("SELECT token FROM slack_bot WHERE company_id = ?")
    .get(company.id) as { token: Uint8Array };
  expect(Buffer.from(row.token).toString()).not.toContain("xoxb-good");

  // Nothing changed in Slack, so nothing changes here.
  await bot.sync(company.id);
  expect(changed).toHaveLength(1);
});

test("the sync follows a renamed Slack channel, hides an archived one with its threads, and brings it back", async () => {
  const { slack, bot, company, names } = await setup();
  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "support" },
  ];
  await bot.connect(company.id, alice, "xoxb-good");
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
  await bot.sync(company.id);
  expect(names()).toEqual([
    ["general", true],
    ["customer-care", true],
  ]);

  slack.channels = [{ id: "C1", name: "general", is_general: true }];
  await bot.sync(company.id);
  expect(names()).toEqual([["general", true]]);
  expect(() => shadow.app.companies.thread(thread.id, alice)).toThrow();

  slack.channels.push({ id: "C2", name: "customer-care" });
  await bot.sync(company.id);
  expect(names()).toEqual([
    ["general", true],
    ["customer-care", true],
  ]);
  expect(shadow.app.companies.thread(thread.id, alice).channelId).toBe(
    support.id
  );
});

test("a failed sync keeps the error until a sync works, and a disconnect keeps the channels", async () => {
  const { slack, bot, company, names } = await setup();
  slack.channels = [
    { id: "C1", name: "general", is_general: true },
    { id: "C2", name: "design" },
  ];
  await bot.connect(company.id, alice, "xoxb-good");
  slack.token = "xoxb-rotated";
  await bot.sync(company.id);
  expect(bot.status(company.id, alice)).toMatchObject({
    connected: true,
    error: "invalid_auth",
  });
  expect(names()).toEqual([
    ["general", true],
    ["design", true],
  ]);

  bot.disconnect(company.id, alice);
  expect(bot.status(company.id, alice)).toEqual({
    connected: false,
    team: null,
    syncedAt: null,
    error: null,
  });
  const calls = slack.calls.length;
  await bot.sync(company.id);
  expect(slack.calls).toHaveLength(calls);
  expect(names()).toEqual([
    ["general", true],
    ["design", true],
  ]);
});

test("a new channel gets the last 30 days of its Slack channel in day files, and each sync brings what changed", async () => {
  const { slack, bot, company, writes, briefed } = await setup();
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

  await bot.connect(company.id, alice, "xoxb-good");
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
  expect(invoiceDay.text).toContain(
    "**Bob Smith**, " // the author, then the local time
  );
  expect(invoiceDay.text).toContain(
    "@Alice Novak the invoice is [here](https://pay.example/1) & due"
  );
  expect(invoiceDay.text).toContain(
    `Attachments: [invoice.pdf](file:${pdf.id})`
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

  // An edit, a new reply to an older thread, and a deleted reply.
  slack.messages.C2[0]!.text = "Shipping tomorrow";
  const late = ts(60);
  slack.messages.C2[2]!.latest_reply = late;
  slack.replies[invoice] = [
    { ts: late, thread_ts: invoice, user: "U2", text: "Receipt sent" },
  ];
  await bot.sync(company.id, true);
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

  // Nothing changed: no file is written again, and the brief reads nothing.
  const before = [writes.length, briefed.length];
  await bot.sync(company.id, true);
  expect([writes.length, briefed.length]).toEqual(before);
});
