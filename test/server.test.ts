import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { cookies, startTestApp, type TestApp, until } from "./harness.ts";

let shadow: TestApp;
let app: TestApp["app"];
let call: TestApp["call"];
let handler: TestApp["handler"];
let signIn: TestApp["signIn"];
let signedCookie: TestApp["signedCookie"];

beforeAll(async () => {
  shadow = await startTestApp({
    catalog: [
      {
        id: "notes",
        name: "Notes",
        description: "The person's notes server.",
        secretLabel: "API key",
        address: true,
        tools: [],
      },
    ],
  });
  ({ app, call, handler, signIn, signedCookie } = shadow);
});

afterAll(() => shadow.close());

let alice: string;
let bob: string;
let companyId: string;
let threadId: string;

test("only allowed emails sign in, and only with Google", async () => {
  alice = await signIn("Alice", "alice@example.com");
  bob = await signIn("Bob", "bob@example.com");
  await expect(signIn("Mallory", "mallory@example.com")).rejects.toThrow(
    "cannot sign in"
  );
  // Someone whose email left the list keeps no access.
  app.database.run(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('old', 'Old', 'old@example.com', 1, 0, 0)"
  );
  await expect(signIn("Old", "old@example.com")).rejects.toThrow(
    "cannot sign in"
  );
  // A session made before the email left the list signs in nobody, and better-auth's routes refuse it.
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  app.database
    .query(
      "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES ('old-session', 'old-token', 'old', ?, ?, ?)"
    )
    .run(later, now, now);
  expect((await call("/api/v1/me", { token: "old-token" })).status).toBe(401);
  expect(
    (await call("/api/auth/get-session", { token: "old-token" })).status
  ).toBe(401);
  expect(
    (await call("/api/auth/organization/list", { token: "old-token" })).status
  ).toBe(401);

  const body = {
    name: "Mallory",
    email: "mallory@example.com",
    password: "correct horse battery",
  };
  expect((await call("/api/auth/sign-up/email", { body })).status).not.toBe(
    200
  );
  expect((await call("/api/auth/sign-in/email", { body })).status).not.toBe(
    200
  );
  expect((await call("/api/v1/me")).status).toBe(401);
  expect((await call("/api/v1/me", { token: alice })).status).toBe(200);
});

test("the first person to sign in starts the company, with a general channel", async () => {
  const [company] = (
    (await (await call("/api/v1/me", { token: alice })).json()) as any
  ).companies;
  companyId = company.id;
  const detail = (await (
    await call(`/api/v1/companies/${companyId}`, { token: alice })
  ).json()) as any;
  expect(
    detail.channels.map((channel: { name: string }) => channel.name)
  ).toEqual(["general"]);
  const duplicate = await call(`/api/v1/companies/${companyId}/channels`, {
    token: alice,
    body: { name: "General" },
  });
  expect(duplicate.status).toBe(409);
});

test("a thread is a Pi Durable session that knows who wrote each message", async () => {
  shadow.faux.setResponses([fauxAssistantMessage("Saturday works.")]);
  const { channels } = (await (
    await call(`/api/v1/companies/${companyId}`, { token: alice })
  ).json()) as any;
  const thread = (await (
    await call(`/api/v1/companies/${companyId}/threads`, {
      token: alice,
      body: { channelId: channels[0].id, text: "Plan the cabin trip" },
    })
  ).json()) as any;
  threadId = thread.id;
  expect(thread.title).toBe("Plan the cabin trip");
  const state = await until(
    async () =>
      (
        await call(`/api/v1/threads/${threadId}`, { token: alice })
      ).json() as any,
    (current) => current.messages.length === 2 && !current.running
  );
  expect(
    state.messages.map((message: { author: string; text: string }) => [
      message.author,
      message.text,
    ])
  ).toEqual([
    ["Alice", "Plan the cabin trip"],
    ["Shadow", "Saturday works."],
  ]);
});

test("companies are isolated until someone adds you", async () => {
  expect(
    (await call(`/api/v1/companies/${companyId}`, { token: bob })).status
  ).toBe(404);
  expect(
    (await call(`/api/v1/threads/${threadId}`, { token: bob })).status
  ).toBe(404);
  expect(
    (
      await call(`/api/v1/threads/${threadId}/messages`, {
        token: bob,
        body: { text: "hi" },
      })
    ).status
  ).toBe(404);
  expect(
    ((await (await call("/api/v1/me", { token: bob })).json()) as any).companies
  ).toEqual([]);

  const added = await call(`/api/v1/companies/${companyId}/members`, {
    token: alice,
    body: { email: "BOB@example.com" },
  });
  expect(added.status).toBe(200);
  expect(
    (await call(`/api/v1/threads/${threadId}`, { token: bob })).status
  ).toBe(200);
});

test("a credential is private until its owner shares it, only its owner deletes it, and secrets never leave the server", async () => {
  const base = `/api/v1/companies/${companyId}`;
  const credential = (await (
    await call(`${base}/integrations/notes/credentials`, {
      token: alice,
      body: {
        label: "Company",
        secret: "company-secret",
        address: "http://notes.local:8080",
      },
    })
  ).json()) as any;
  expect(credential.shared).toBe(false);
  const bobsView = async () =>
    (await call(`${base}/integrations`, { token: bob })).text();
  expect(await bobsView()).not.toContain("Company");

  const share = (token: string) =>
    call(`${base}/credentials/${credential.id}`, {
      method: "PUT",
      token,
      body: { shared: true },
    });
  expect((await share(bob)).status).toBe(404);
  expect(await (await share(alice)).json()).toMatchObject({ shared: true });
  expect(await bobsView()).toContain("Company");
  expect(await bobsView()).not.toContain("company-secret");

  const remove = (token: string) =>
    call(`${base}/credentials/${credential.id}`, { method: "DELETE", token });
  expect((await remove(bob)).status).toBe(404);
  expect((await remove(alice)).status).toBe(204);
  // The credential stays encrypted, marked deleted, and no tool reads it.
  expect(
    shadow.app.database
      .query(
        "SELECT deleted_at IS NOT NULL AS deleted FROM credential WHERE id = ?"
      )
      .get(credential.id)
  ).toEqual({ deleted: 1 });
});

test("only the server's owner restarts Shadow", async () => {
  const refused = await call("/api/v1/server/restart", {
    method: "POST",
    token: bob,
    body: {},
  });
  expect(refused.status).toBe(403);
});

test("everyone uses the one LLM provider, and only an admin changes it", async () => {
  const llm = (await (await call("/api/v1/llm", { token: bob })).json()) as any;
  // The faux model has no reasoning, so the default effort moves to the one level it supports.
  expect(llm).toMatchObject({
    provider: "Test model",
    model: shadow.model.id,
    effort: "off",
    models: [
      { id: shadow.model.id, name: shadow.model.name, efforts: ["off"] },
    ],
    login: null,
    admin: false,
  });
  for (const [path, method, body] of [
    ["/api/v1/llm/model", "PUT", { model: shadow.model.id }],
    ["/api/v1/llm/effort", "PUT", { effort: "off" }],
    ["/api/v1/llm/login", "POST", {}],
    ["/api/v1/llm/logout", "POST", {}],
  ] as const) {
    const refused = await call(path, { method, token: bob, body });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only an admin changes this",
    });
  }
  // Alice started the company, so she is its admin.
  expect(
    await (await call("/api/v1/llm", { token: alice })).json()
  ).toMatchObject({ admin: true });
  expect(
    (
      await call("/api/v1/llm/model", {
        method: "PUT",
        token: alice,
        body: { model: "nope" },
      })
    ).status
  ).toBe(400);
  expect(
    (
      await call("/api/v1/llm/effort", {
        method: "PUT",
        token: alice,
        body: { effort: "high" },
      })
    ).status
  ).toBe(400);
  expect(
    await (
      await call("/api/v1/llm/effort", {
        method: "PUT",
        token: alice,
        body: { effort: "off" },
      })
    ).json()
  ).toMatchObject({ effort: "off", admin: true });
});

test("the web app signs in with Google and keeps cross-site posts out", async () => {
  // Behind a TLS proxy the request arrives at the internal address, with the browser's origin.
  const login = await handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        origin: "http://shadow.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    })
  );
  expect(login.status).toBe(200);
  const google = new URL(((await login.json()) as { url: string }).url);
  expect(google.origin).toBe("https://accounts.google.com");
  expect(google.searchParams.get("redirect_uri")).toBe(
    "http://shadow.test/api/auth/callback/google"
  );
  expect(cookies(login)).toContain("state");

  const cookie = `better-auth.session_token=${await signedCookie(alice)}`;
  const crossSite = await handler(
    new Request(`http://shadow.test/api/v1/companies/${companyId}/channels`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "pwned" }),
    })
  );
  expect(crossSite.status).toBe(403);
  expect(
    (await call(`/api/v1/threads/${threadId}`, { headers: { cookie } })).status
  ).toBe(200);
});
