import { afterAll, expect, test } from "bun:test";
import { chmod, exists, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directSlackMessage,
  type SlackMessage,
  slackConnector,
} from "./slack.ts";
import { slackPermalink, slackTime } from "./slack-text.ts";

const directory = await mkdtemp(join(tmpdir(), "shadow-slack-test-"));
const slackcli = join(directory, "slackcli");
const SESSION =
  '{"default_workspace":"T1","workspaces":{"T1":{"workspace_id":"T1","workspace_name":"Company","auth_type":"browser"}}}';
// slackcli as Shadow runs it: parse-curl keeps a session of the cURL on stdin; other commands answer with their
// arguments, their home, and the session there; `fail` fails as a `--json` command does.
await Bun.write(
  slackcli,
  `#!/bin/sh
config="$HOME/.config/slackcli/workspaces.json"
case "$*" in
  "auth parse-curl --login --secret-backend file")
    case "$(cat)" in
      curl*) printf '%s' '${SESSION}' > "$config" ;;
      *) printf '\\u274c Error: Failed to parse cURL command\\n   Could not find Slack workspace URL\\n\\nTip\\n' >&2; exit 1 ;;
    esac ;;
  *fail*) echo "- Searching" >&2; echo '{"error":{"code":"not_found","message":"Channel not found"}}' >&2; exit 1 ;;
  *) printf '{"arguments":"%s","home":"%s","token":"%s","session":%s}' "$*" "$HOME" "$SLACKCLI_TOKEN" "$(cat "$config")" ;;
esac
`
);
await chmod(slackcli, 0o755);
const connector = slackConnector(slackcli);
const tools = new Map(connector.tools.map((tool) => [tool.name, tool]));
afterAll(() => rm(directory, { recursive: true }));

test("a pasted cURL signs in, and names the credential after the workspace", async () => {
  expect(
    await connector.secretFrom!("curl 'https://company.slack.com/api'")
  ).toEqual({
    secret: SESSION,
    label: "Company",
  });
  await expect(connector.secretFrom!("hello")).rejects.toThrow(
    "Failed to parse cURL command Could not find Slack workspace URL"
  );
});

test("each tool runs slackcli with the session in a home of its own, which it removes after", async () => {
  Bun.env.SLACKCLI_TOKEN = "xoxb-of-this-machine";
  try {
    const answer = (await tools
      .get("slack_read")!
      .execute(
        { channel: "-general", thread: "1.2" } as never,
        SESSION,
        undefined
      )) as { arguments: string; home: string; token: string; session: object };
    // A value that looks like a flag stays a value, and this machine's token is not used.
    expect(answer.arguments).toBe(
      "conversations read --thread-ts=1.2 --json -- -general"
    );
    expect(answer.token).toBe("");
    expect(answer.session).toEqual(JSON.parse(SESSION));
    expect(await exists(answer.home)).toBe(false);
  } finally {
    Reflect.deleteProperty(Bun.env, "SLACKCLI_TOKEN");
  }
  await expect(
    tools
      .get("slack_search")!
      .execute({ query: "fail" } as never, SESSION, undefined)
  ).rejects.toThrow("Channel not found");
});

test("only slack_send acts as the person, and its approval shows what it sends", () => {
  expect(
    connector.tools.filter((tool) => tool.approval).map((tool) => tool.name)
  ).toEqual(["slack_send"]);
  expect(
    tools.get("slack_send")!.approval!(
      { to: "#company", text: "Dinner at 7", thread: "1.2" } as never,
      SESSION,
      undefined
    )
  ).toBe("Send on Slack to #company in a thread: Dinner at 7");
});

test("the personal Slack source keeps only DMs and group DMs, as the bot's copy has the channels", () => {
  const message: SlackMessage = {
    channel: { id: "C1", name: "work" },
    user: "U2",
    author: "Bob Smith",
    ts: "1.2",
    text: "@Alice Novak please check",
    permalink: "https://example.slack.com/archives/C1/p1200000",
  };
  const owner = { id: "U1", name: "Alice Novak" };
  expect(directSlackMessage(message, owner)).toBeNull();
  const direct = directSlackMessage(
    { ...message, channel: { id: "D1", is_im: true } },
    owner
  );
  expect(direct).toMatchObject({
    chat: "D1",
    group: false,
    sender: "Bob Smith",
    text: "@me please check",
  });
  expect(
    directSlackMessage(
      { ...message, user: "U1", channel: { id: "G1", is_mpim: true } },
      owner
    )
  ).toMatchObject({ chat: "G1", group: true, fromOwner: true, sender: "" });
});

test("source polling keeps DMs and group DMs across pages, and a page cursor until the search is done", async () => {
  const binary = join(directory, "watch-slackcli");
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
const args=process.argv.slice(2);
const page=Number(args.find(a=>a.startsWith("--page=")).slice(7));
const channels=[{id:"C1",name:"work"},{id:"D1",is_im:true},{id:"G1",is_mpim:true}];
const matches=Array.from({length:6},(_,i)=>({type:"message",ts:(page*10+i)+".1",user:"U2",text:"m"+page+"-"+i,channel:channels[i%3],permalink:"https://example.slack.com/archives/X/p1"}));
console.log(JSON.stringify({pages:6,matches}));
`
  );
  await chmod(binary, 0o755);
  const watched = slackConnector(binary);
  let checkpoint: unknown = {};
  const coverage: boolean[] = [];
  const source = {
    since: 1000,
    account: "Work",
    seen: () => false,
    secret: async () =>
      JSON.stringify({
        default_workspace: "T1",
        workspaces: { T1: { user_id: "U1" } },
      }),
    call: async () => null,
    checkpoint: {
      get value() {
        return checkpoint;
      },
      save: (value: unknown) => {
        checkpoint = value;
      },
    },
    record: (stage: string, data: unknown) => {
      if (stage === "coverage") {
        coverage.push((data as { complete: boolean }).complete);
      }
    },
  };
  const first = await watched.watch!(source);
  expect(first).toHaveLength(20);
  expect(first.every((item) => /^[DG]1$/.test(item.chat))).toBe(true);
  expect(coverage.at(-1)).toBe(false);
  const second = await watched.watch!(source);
  expect(second.map((item) => item.text)).toEqual([
    "m6-1",
    "m6-2",
    "m6-4",
    "m6-5",
  ]);
  expect(coverage.at(-1)).toBe(true);
  expect(checkpoint).toEqual({});
}, 15_000);

test("the tools give messages in the form of the bot's copy: names, the text with names, the time, and the link", async () => {
  const binary = join(directory, "form-slackcli");
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args[0]==="users") console.log(JSON.stringify(args.at(-1)==="U1"?{id:"U1",name:"alice",real_name:"Alice Novak"}:{}));
else console.log(JSON.stringify({channel_id:"C1",messages:[{type:"message",ts:"1731668700.000100",thread_ts:"1731668600.000200",user:"U2",text:"<@U1> the invoice is <https://pay.example/1|here> &amp; due",blocks:[{type:"rich_text"}]}],users:[{id:"U2",name:"bob",real_name:"Bob Smith"}]}));
`
  );
  await chmod(binary, 0o755);
  const session = JSON.stringify({
    default_workspace: "T1",
    workspaces: {
      T1: {
        workspace_id: "T1",
        workspace_url: "https://acme.slack.com",
        user_id: "U1",
      },
    },
  });
  const read = slackConnector(binary).tools.find(
    (tool) => tool.name === "slack_read"
  )!;
  const answer = (await read.execute(
    { channel: "C1" } as never,
    session,
    undefined
  )) as { messages: Record<string, unknown>[] };
  const [message] = answer.messages;
  expect(message).toMatchObject({
    user: "U2",
    author: "Bob Smith",
    mentions: ["U1"],
    // The same text as the day file of the copy has; see the bot's test.
    text: "@Alice Novak the invoice is [here](https://pay.example/1) & due",
    time: slackTime("1731668700.000100"),
    permalink: slackPermalink(
      "https://acme.slack.com/",
      "C1",
      "1731668700.000100",
      "1731668600.000200"
    ),
  });
  expect(message!.permalink).toBe(
    "https://acme.slack.com/archives/C1/p1731668700000100?thread_ts=1731668600.000200&cid=C1"
  );
  expect(message).not.toHaveProperty("blocks");
});
