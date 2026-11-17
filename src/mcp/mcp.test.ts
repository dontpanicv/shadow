import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

const REDIRECT = "http://127.0.0.1:5555/callback";
const VERIFIER = "a-code-verifier-of-at-least-forty-three-characters";

let shadow: TestApp;
let alice: string;
let client: Client;

beforeAll(async () => {
  shadow = await startTestApp();
  alice = await shadow.signIn("Alice", "alice@example.com");
  // The first person to sign in starts the company.
  await shadow.call("/api/v1/me", { token: alice });
  client = await connect(await accessToken(alice));
});

afterAll(async () => {
  await client.close();
  await shadow.close();
});

test("an MCP client finds where to sign in", async () => {
  const response = await shadow.call("/mcp", {
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer resource_metadata="http://shadow.test/.well-known/oauth-protected-resource/mcp"'
  );
  const resource = (await (
    await shadow.call("/.well-known/oauth-protected-resource/mcp")
  ).json()) as { resource: string; authorization_servers: string[] };
  expect(resource.resource).toBe("http://shadow.test/mcp");
  const server = (await (
    await shadow.call(
      `/.well-known/oauth-authorization-server${new URL(resource.authorization_servers[0]!).pathname}`
    )
  ).json()) as { issuer: string; registration_endpoint: string };
  expect(server.issuer).toBe(resource.authorization_servers[0]!);
  expect(server.registration_endpoint).toBe(
    "http://shadow.test/api/auth/oauth2/register"
  );
});

test("a session token does not open the MCP server", async () => {
  const response = await shadow.call("/mcp", {
    token: alice,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(response.status).toBe(401);
});

test("the tools work as the person who signed in", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toContain("ask");
  expect(await text("list_channels", {})).toContain("#general");
  const made = await text("create_artifact", {
    title: "Lunch poll",
    html: "<p>Pizza?</p>",
  });
  expect(made).toContain("Made the artifact.");
  expect(await text("list_artifacts", {})).toContain("Lunch poll");
  expect(
    await text("save_file", { name: "notes.md", text: "# Notes" })
  ).toContain("Saved notes.md as file");
  const fileId = /file (\S+)\./.exec(
    await text("save_file", { name: "plan.md", text: "# Plan" })
  )![1]!;
  expect(await text("read_file", { file_id: fileId })).toBe("# Plan");
  const failed = await client.callTool({
    name: "list_files",
    arguments: { channel: "nowhere" },
  });
  expect(failed.isError).toBe(true);
});

test("ask gives the orchestrator's answer", async () => {
  shadow.faux.setResponses([fauxAssistantMessage("Your day is free.")]);
  const answer = await text("ask", { text: "What is on today?" });
  expect(answer).toStartWith("Your day is free.");
  expect(await text("read_thread", {})).toContain("What is on today?");
});

test("the skill tells the agent where to keep notes, without a sign-in", async () => {
  const response = await shadow.call("/mcp/skill.md");
  expect(response.headers.get("content-type")).toStartWith("text/markdown");
  const skill = await response.text();
  expect(skill).toStartWith("---\nname: shadow-notes\n");
  expect(skill).toContain("whose remote is under github.com/acme");
});

test("note files a note in the channel of its topic", async () => {
  const user = await me();
  const general = shadow.app.companies
    .channels(shadow.app.companies.list(user)[0]!.id, user)
    .find((channel) => channel.name === "general")!;
  shadow.faux.setResponses([
    fauxAssistantMessage(JSON.stringify({ channel: general.id })),
  ]);
  const saved = await text("note", {
    title: "Use Postgres 16 for v2",
    text: "The v2 migration needs logical replication.",
    kind: "decision",
    repository: "github.com/acme/app on v2",
  });
  expect(saved).toMatch(
    /^Saved the note as note-\d{4}-\d{2}-\d{2}-use-postgres-16-for-v2\.md \(file \S+\) in #general\.$/
  );
  const fileId = /file (\S+)\)/.exec(saved)![1]!;
  const note = await text("read_file", { file_id: fileId });
  expect(note).toStartWith("# Use Postgres 16 for v2\n\ndecision · Alice · ");
  expect(note).toContain("github.com/acme/app on v2");
  // Without a channel that fits, the note stays in the person's own channel.
  shadow.faux.setResponses([fauxAssistantMessage('{"channel": null}')]);
  expect(
    await text("note", {
      title: "Flaky test",
      text: "It fails.",
      kind: "problem",
    })
  ).not.toContain("in #general.");
});

async function me(): Promise<User> {
  const response = await shadow.call("/api/v1/me", { token: alice });
  return ((await response.json()) as { user: User }).user;
}

async function text(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { text: string }[])[0]!.text;
}

/** What Claude Code or Codex does: registers itself, signs in as the person, allows it, and gets a token. */
async function accessToken(session: string): Promise<string> {
  const registered = (await (
    await shadow.call("/api/auth/oauth2/register", {
      body: {
        client_name: "Claude Code",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    })
  ).json()) as { client_id: string };
  const challenge = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER))
  ).toBase64({ alphabet: "base64url", omitPadding: true });
  const cookie = await shadow.sessionCookie(session);
  const authorized = await shadow.call(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: REDIRECT,
      scope: "openid profile email offline_access",
      state: "state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "http://shadow.test/mcp",
    })}`,
    { headers: { cookie } }
  );
  const consent = new URL(authorized.headers.get("location")!, "http://x");
  expect(consent.pathname).toBe("/consent");
  const allowed = (await (
    await shadow.call("/api/auth/oauth2/consent", {
      headers: { cookie },
      body: { accept: true, oauth_query: consent.search.slice(1) },
    })
  ).json()) as { url: string };
  const tokens = await shadow.handler(
    new Request("http://shadow.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(allowed.url).searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: registered.client_id,
        code_verifier: VERIFIER,
        resource: "http://shadow.test/mcp",
      }),
    })
  );
  return ((await tokens.json()) as { access_token: string }).access_token;
}

async function connect(token: string): Promise<Client> {
  const connected = new Client({ name: "test", version: "1" });
  await connected.connect(
    new StreamableHTTPClientTransport(new URL("http://shadow.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, init) => shadow.handler(new Request(String(input), init)),
    })
  );
  return connected;
}
