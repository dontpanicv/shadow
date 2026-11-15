import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { clientJson } from "../src/app/http.ts";
import { startTestApp, type TestApp, until } from "./harness.ts";

let shadow: TestApp;
let alice: string;
let bob: string;
let companyId: string;
let channelId: string;

beforeAll(async () => {
  shadow = await startTestApp();
  alice = await shadow.signIn("Alice", "alice@example.com");
  bob = await shadow.signIn("Bob", "bob@example.com");
  // The first person to sign in starts Shadow's one company.
  const [company] = (
    await body(await shadow.call("/api/v1/me", { token: alice }))
  ).companies;
  companyId = company.id;
  const detail = await body(
    await shadow.call(`/api/v1/companies/${companyId}`, { token: alice })
  );
  channelId = detail.channels[0].id;
});

afterAll(() => shadow.close());

async function body(response: Response): Promise<any> {
  return await response.json();
}

/** Another company, which only the server makes, for a test of what stays apart. */
async function companyOf(token: string, name: string) {
  const { user } = await body(await shadow.call("/api/v1/me", { token }));
  return shadow.app.companies.create(user, name);
}

async function failure(response: Response) {
  return { status: response.status, ...(await body(response)) };
}

test("JSON for the apps has no half emoji and no line end that splits an event", () => {
  // Text cut inside an emoji, as a search result can be, and a caption with a line separator.
  const text = `donut!${"🥹".slice(0, 1)}… one\u2028two\u0085three\u2029`;
  const sent = clientJson({ text });
  expect(sent).not.toMatch(/[\u0085\u2028\u2029]|\\ud83e/);
  expect(JSON.parse(sent)).toEqual({
    text: "donut!\ufffd… one\u2028two\u0085three\u2029",
  });
});

test("a request body must be a JSON object", async () => {
  const post = (text: string) =>
    shadow.handler(
      new Request(`http://shadow.test/api/v1/companies/${companyId}/channels`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${alice}`,
          "content-type": "application/json",
        },
        body: text,
      })
    );
  for (const text of ["{", "[1]", '"Company"', "null"]) {
    expect(await failure(await post(text))).toEqual({
      status: 400,
      error: "Send a JSON object",
    });
  }
  // An empty body is an empty object, so the missing field is the error.
  expect(await failure(await post(" "))).toEqual({
    status: 400,
    error: "Name is required",
  });
});

test("names and messages are checked before anything is stored", async () => {
  const base = `/api/v1/companies/${companyId}`;
  expect(
    await failure(
      await shadow.call(`${base}/channels`, {
        token: alice,
        body: { name: "#!!" },
      })
    )
  ).toEqual({
    status: 400,
    error: "Use letters or numbers in the channel name",
  });
  expect(
    await failure(
      await shadow.call(`${base}/channels`, {
        token: alice,
        body: { name: 42 },
      })
    )
  ).toEqual({ status: 400, error: "Name is required" });
  expect(
    await body(
      await shadow.call(`${base}/channels`, {
        token: alice,
        body: { name: "#Weekend Plans" },
      })
    )
  ).toMatchObject({ name: "weekend-plans", threads: [] });
  expect(
    (
      await shadow.call(`${base}/threads`, {
        token: alice,
        body: { channelId: "no-such-channel", text: "Hello" },
      })
    ).status
  ).toBe(404);
  expect(
    await failure(
      await shadow.call(`${base}/threads`, {
        token: alice,
        body: { channelId, text: "   " },
      })
    )
  ).toEqual({ status: 400, error: "Message is required" });
  const { channels } = await body(await shadow.call(base, { token: alice }));
  expect(
    channels.flatMap((channel: { threads: unknown[] }) => channel.threads)
  ).toEqual([]);
});

test("a channel name keeps Czech letters, and only a member renames a channel", async () => {
  const base = `/api/v1/companies/${companyId}/channels`;
  const trips = await body(
    await shadow.call(base, { token: alice, body: { name: "Výlety do hor" } })
  );
  expect(trips.name).toBe("výlety-do-hor");
  await shadow.call(base, { token: alice, body: { name: "Účty" } });
  const rename = (name: string) =>
    shadow.call(`${base}/${trips.id}`, {
      token: alice,
      method: "PUT",
      body: { name },
    });
  expect(await body(await rename("#Žluťoučký kůň!"))).toMatchObject({
    id: trips.id,
    name: "žluťoučký-kůň",
  });
  expect(await failure(await rename("účty"))).toEqual({
    status: 409,
    error: "#účty already exists",
  });
  // Its own name again is no conflict.
  expect((await rename("Žluťoučký kůň")).status).toBe(200);
  expect(
    (
      await shadow.call(`${base}/${trips.id}`, {
        token: bob,
        method: "PUT",
        body: { name: "mine" },
      })
    ).status
  ).toBe(404);
});

test("a person pins and unpins a channel they see, for themselves only", async () => {
  const base = `/api/v1/companies/${companyId}`;
  const notes = await body(
    await shadow.call(`${base}/channels`, {
      token: alice,
      body: { name: "pinned notes" },
    })
  );
  const pin = (token: string, method: "PUT" | "DELETE") =>
    shadow.call(`${base}/channels/${notes.id}/pin`, { token, method });
  const pinned = async (token: string) =>
    (await body(await shadow.call(base, { token }))).pinned;
  expect((await pin(alice, "PUT")).status).toBe(204);
  expect(await pinned(alice)).toEqual([notes.id]);
  // Another person's private channel is not found.
  expect((await pin(bob, "PUT")).status).toBe(404);
  expect((await pin(alice, "DELETE")).status).toBe(204);
  expect(await pinned(alice)).toEqual([]);
});

test("a long first line makes a short thread title", async () => {
  shadow.faux.setResponses([fauxAssistantMessage("Noted.")]);
  const thread = await body(
    await shadow.call(`/api/v1/companies/${companyId}/threads`, {
      token: alice,
      body: { channelId, text: `${"a".repeat(80)}\nsecond line` },
    })
  );
  expect(thread.title).toBe(`${"a".repeat(59)}…`);
  // The answer must use its own scripted response before the next test sets others.
  await until(
    async () =>
      body(await shadow.call(`/api/v1/threads/${thread.id}`, { token: alice })),
    (state) => state.messages.length === 2 && !state.running
  );
});

test("a message sent again with the same request id, as the web app's outbox retries, stays one message", async () => {
  shadow.faux.setResponses([
    fauxAssistantMessage("Noted."),
    fauxAssistantMessage("Got it."),
  ]);
  const thread = await body(
    await shadow.call(`/api/v1/companies/${companyId}/threads`, {
      token: alice,
      body: { channelId, text: "Groceries" },
    })
  );
  const state = () =>
    shadow.call(`/api/v1/threads/${thread.id}`, { token: alice }).then(body);
  await until(state, (now) => now.messages.length === 2 && !now.running);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sent = await shadow.call(`/api/v1/threads/${thread.id}/messages`, {
      token: alice,
      body: { text: "And milk", requestId: "outbox-1" },
    });
    expect(sent.status).toBe(204);
  }
  const done = await until(
    state,
    (now) => now.messages.length >= 4 && !now.running
  );
  expect(
    done.messages.map((message: { text: string }) => message.text)
  ).toEqual(["Groceries", "Noted.", "And milk", "Got it."]);
});

test("members are listed, and only people who signed in once can be added once", async () => {
  const members = `/api/v1/companies/${companyId}/members`;
  expect((await shadow.call(members, { token: bob })).status).toBe(404);
  expect(
    await failure(
      await shadow.call(members, {
        token: alice,
        body: { email: "eve@example.com" },
      })
    )
  ).toEqual({ status: 400, error: "Nobody has signed up with that email yet" });
  expect(
    (
      await shadow.call(members, {
        token: alice,
        body: { email: "bob@example.com" },
      })
    ).status
  ).toBe(200);
  expect(
    await failure(
      await shadow.call(members, {
        token: alice,
        body: { email: "Bob@Example.com" },
      })
    )
  ).toEqual({ status: 409, error: "Bob is already a member" });
  expect(await body(await shadow.call(members, { token: bob }))).toEqual([
    expect.objectContaining({
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    }),
    expect.objectContaining({
      name: "Bob",
      email: "bob@example.com",
      role: "member",
    }),
  ]);
  expect(
    await failure(
      await shadow.call(members, {
        token: bob,
        body: { email: "alice@example.com" },
      })
    )
  ).toEqual({ status: 403, error: "Only an admin can do this" });
});

test("an admin makes a member an admin and back, and a company keeps one admin at least", async () => {
  const idOf = async (token: string) =>
    (await body(await shadow.call("/api/v1/me", { token }))).user.id as string;
  const [aliceId, bobId] = await Promise.all([idOf(alice), idOf(bob)]);
  const role = (userId: string, value: string, token: string) =>
    shadow.call(`/api/v1/companies/${companyId}/members/${userId}`, {
      token,
      method: "PUT",
      body: { role: value },
    });
  const admin = async (token: string) =>
    (await body(await shadow.call("/api/v1/me", { token }))).admin;

  expect(await failure(await role(bobId, "admin", bob))).toEqual({
    status: 403,
    error: "Only an admin can do this",
  });
  expect(await failure(await role(bobId, "owner", alice))).toEqual({
    status: 400,
    error: "A role is admin or member",
  });
  expect(await body(await role(bobId, "admin", alice))).toMatchObject({
    userId: bobId,
    role: "admin",
  });
  expect(await admin(bob)).toBe(true);
  expect((await role(aliceId, "member", bob)).status).toBe(200);
  expect(await admin(alice)).toBe(false);
  expect(await failure(await role(bobId, "member", bob))).toEqual({
    status: 409,
    error: "A company keeps one admin at least",
  });
  // Alice is the admin again, and Bob a member, for the tests after this one.
  expect((await role(aliceId, "admin", bob)).status).toBe(200);
  expect((await role(bobId, "member", alice)).status).toBe(200);
  expect(await admin(bob)).toBe(false);
});

test("a profile picture shows to its person and the members of their company only", async () => {
  const eve = await shadow.signIn("Eve", "eve@example.com");
  const { user } = await body(await shadow.call("/api/v1/me", { token: bob }));
  const id = await shadow.app.pictures.set(
    user.id,
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "picture.jpg")
  );
  const picture = `/api/v1/pictures/${id}`;
  expect(
    (await body(await shadow.call("/api/v1/me", { token: bob }))).user.picture
  ).toBe(picture);
  expect(
    (
      await body(
        await shadow.call(`/api/v1/companies/${companyId}/members`, {
          token: alice,
        })
      )
    ).find((member: { userId: string }) => member.userId === user.id).picture
  ).toBe(picture);
  const shown = await shadow.call(picture, { token: alice });
  expect(shown.headers.get("content-type")).toBe("image/jpeg");
  expect((await shadow.call(picture, { token: eve })).status).toBe(404);
  expect(
    (await shadow.call("/api/v1/me/picture", { token: bob, method: "DELETE" }))
      .status
  ).toBe(204);
  expect((await shadow.call(picture, { token: bob })).status).toBe(404);
});

test("only an admin writes the company's facts, every member reads them, and nobody else", async () => {
  const facts = `/api/v1/companies/${companyId}/facts`;
  expect(await body(await shadow.call(facts, { token: alice }))).toEqual({
    text: "",
  });
  const text = "Sales: Bob\nOffice: Prague";
  expect(
    (
      await shadow.call(facts, {
        token: bob,
        method: "PUT",
        body: { text },
      })
    ).status
  ).toBe(403);
  expect(
    await body(
      await shadow.call(facts, {
        token: alice,
        method: "PUT",
        body: { text: `  ${text}\n` },
      })
    )
  ).toEqual({ text });
  expect(await body(await shadow.call(facts, { token: bob }))).toEqual({
    text,
  });
  expect(shadow.app.companies.factsOf(companyId)).toBe(text);
  const eve = await shadow.signIn("Eve", "eve@example.com");
  expect((await shadow.call(facts, { token: eve })).status).toBe(404);
  expect(
    (
      await shadow.call(facts, {
        token: alice,
        method: "PUT",
        body: { text: "x".repeat(20_001) },
      })
    ).status
  ).toBe(400);
});

test("an unknown integration is not found", async () => {
  const base = `/api/v1/companies/${companyId}/integrations/nope`;
  expect(
    (
      await shadow.call(`${base}/credentials`, {
        token: alice,
        body: { label: "Key", secret: "x" },
      })
    ).status
  ).toBe(404);
});

test("routines of a channel are listed, paused, run, and deleted, and only members see them", async () => {
  const routine = shadow.app.routines.create(companyId, channelId, {
    id: crypto.randomUUID(),
    name: "Morning",
    schedule: "0 7 * * *",
    instructions: "Say what is new.",
    script: "return [];",
    createdBy: "shadow",
  });
  const list = `/api/v1/companies/${companyId}/channels/${channelId}/routines`;
  expect(await body(await shadow.call(list, { token: alice }))).toMatchObject({
    routines: [
      {
        id: routine.id,
        channelId,
        name: "Morning",
        schedule: "0 7 * * *",
        instructions: "Say what is new.",
        script: "return [];",
        enabled: true,
        nextRunAt: routine.nextRunAt,
        threadId: null,
        lastRun: null,
      },
    ],
    runs: [],
  });
  const path = `/api/v1/routines/${routine.id}`;
  // Bob joined the company in an earlier test; Eve is not a member.
  const eve = await shadow.signIn("Eve", "eve@example.com");
  expect((await shadow.call(list, { token: eve })).status).toBe(404);
  expect(
    (await shadow.call(path, { method: "DELETE", token: eve })).status
  ).toBe(404);

  expect(
    await body(
      await shadow.call(path, {
        method: "PUT",
        token: alice,
        body: { enabled: false },
      })
    )
  ).toMatchObject({ enabled: false, nextRunAt: null });
  expect(
    (await shadow.call(`${path}/runs`, { method: "POST", token: alice })).status
  ).toBe(202);
  const { runs } = await until(
    async () => body(await shadow.call(list, { token: alice })),
    (state) => state.runs[0]?.outcome === "quiet"
  );
  expect(runs[0]).toMatchObject({
    routineId: routine.id,
    routineName: "Morning",
    error: null,
  });
  expect(
    (await shadow.call(path, { method: "DELETE", token: alice })).status
  ).toBe(204);
  expect(
    (await shadow.call(`${path}/runs`, { method: "POST", token: alice })).status
  ).toBe(404);
});

test("artifacts of a channel open with their runtime, run calls, and change and delete only for members", async () => {
  shadow.faux.setResponses([fauxAssistantMessage("Here it is.")]);
  const thread = await body(
    await shadow.call(`/api/v1/companies/${companyId}/threads`, {
      token: alice,
      body: { channelId, text: "Make a quiz" },
    })
  );
  const artifact = shadow.app.artifacts.create(
    shadow.app.companies
      .allThreadsIn(companyId)
      .find((t) => t.id === thread.id)!,
    channelId,
    { title: "Quiz", html: "<p>Q</p>", requestKey: "api-test" }
  );
  const eve = await shadow.signIn("Eve", "eve@example.com");
  const path = `/api/v1/artifacts/${artifact.id}`;

  expect(
    await body(
      await shadow.call(
        `/api/v1/companies/${companyId}/channels/${channelId}/artifacts`,
        { token: alice }
      )
    )
  ).toEqual({ artifacts: [artifact] });
  const rpc = (op: string, args: unknown, token = alice) =>
    shadow.call(`/a/${artifact.id}/rpc`, { token, body: { op, args } });
  expect(
    await body(await rpc("set", { scope: "mine", key: "score", value: 7 }))
  ).toEqual({ result: null });
  const opened = await body(await shadow.call(path, { token: alice }));
  expect(opened.artifact).toMatchObject({ id: artifact.id, visitors: 1 });
  expect(opened.records).toMatchObject([
    { visitor: expect.any(String), name: "Alice", key: "score", value: 7 },
  ]);

  for (const response of [
    await shadow.call(path, { token: eve }),
    await rpc("me", {}, eve),
    await shadow.call(path, { method: "DELETE", token: eve }),
  ]) {
    expect(response.status).toBe(404);
  }
  expect(
    await body(
      await shadow.call(path, {
        method: "PUT",
        token: alice,
        body: { visibility: "public" },
      })
    )
  ).toMatchObject({ visibility: "public" });
  expect(await body(await rpc("me", {}, eve))).toMatchObject({
    // A visitor of another company is an id of this artifact only, with no name.
    result: { name: null, member: false },
  });
  expect(
    await failure(
      await rpc("set", { scope: "shared", key: "a", value: 1 }, eve)
    )
  ).toEqual({ status: 403, error: "Only members change shared data" });

  expect(
    (
      await shadow.call(`${path}/records/${opened.records[0].id}`, {
        method: "DELETE",
        token: alice,
      })
    ).status
  ).toBe(204);
  expect(
    (await shadow.call(`${path}/data`, { method: "DELETE", token: alice }))
      .status
  ).toBe(204);
  expect(
    (await body(await shadow.call(path, { token: alice }))).records
  ).toEqual([]);
  expect(
    (await shadow.call(path, { method: "DELETE", token: alice })).status
  ).toBe(204);
  expect((await shadow.call(path, { token: alice })).status).toBe(404);
});

test("a JSON body over 1 MB gets 413 before the route reads it", async () => {
  const large = await shadow.call(`/api/v1/companies/${companyId}/channels`, {
    token: alice,
    body: { name: "x".repeat(2 * 1024 ** 2) },
  });
  expect(await failure(large)).toEqual({
    status: 413,
    error: "The request is too large",
  });
});

test("thread events stream every change until the client leaves", async () => {
  shadow.faux.setResponses([fauxAssistantMessage("Saturday works.")]);
  const thread = await body(
    await shadow.call(`/api/v1/companies/${companyId}/threads`, {
      token: alice,
      body: { channelId, text: "Plan the cabin trip" },
    })
  );
  const events = await shadow.call(`/api/v1/threads/${thread.id}/events`, {
    token: bob,
  });
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  const stream = threadEvents(events);
  const first = await stream.until(
    (state) => state.messages.length === 2 && !state.running
  );
  expect(first.thread).toEqual(thread);

  shadow.faux.setResponses([fauxAssistantMessage("Then Sunday.")]);
  const sent = await shadow.call(`/api/v1/threads/${thread.id}/messages`, {
    token: bob,
    body: { text: "Saturday I work" },
  });
  expect(sent.status).toBe(204);
  const answered = await stream.until(
    (state) => state.messages.length === 4 && !state.running
  );
  expect(
    answered.messages.map((message: { author: string; text: string }) => [
      message.author,
      message.text,
    ])
  ).toEqual([
    ["Alice", "Plan the cabin trip"],
    ["Shadow", "Saturday works."],
    ["Bob", "Saturday I work"],
    ["Shadow", "Then Sunday."],
  ]);
  // A new message moves the thread up.
  const { channels } = await body(
    await shadow.call(`/api/v1/companies/${companyId}`, { token: bob })
  );
  const general = channels.find(
    (channel: { id: string }) => channel.id === channelId
  );
  expect(general.threads[0].id).toBe(thread.id);
  expect(general.threads[0].updatedAt).toBeGreaterThan(thread.updatedAt);
  await stream.stop();

  expect(
    (
      await shadow.call(`/api/v1/threads/${thread.id}/events`, {
        token: "nope",
      })
    ).status
  ).toBe(401);
});

test("a person who leaves a company stops getting its thread's events", async () => {
  shadow.faux.setResponses([fauxAssistantMessage("Noted.")]);
  const leaving = await companyOf(alice, "Leaving");
  await shadow.call(`/api/v1/companies/${leaving.id}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  const { channels } = await body(
    await shadow.call(`/api/v1/companies/${leaving.id}`, { token: alice })
  );
  const thread = await body(
    await shadow.call(`/api/v1/companies/${leaving.id}/threads`, {
      token: alice,
      body: { channelId: channels[0].id, text: "A secret plan" },
    })
  );
  const stream = threadEvents(
    await shadow.call(`/api/v1/threads/${thread.id}/events`, { token: bob })
  );
  await stream.until((state) => state.messages.length === 2 && !state.running);
  const bobId = (
    shadow.app.database
      .query("SELECT id FROM user WHERE email = 'bob@example.com'")
      .get() as { id: string }
  ).id;
  shadow.app.database
    .query("DELETE FROM member WHERE organizationId = ? AND userId = ?")
    .run(leaving.id, bobId);
  shadow.faux.setResponses([fauxAssistantMessage("The new plan.")]);
  await shadow.call(`/api/v1/threads/${thread.id}/messages`, {
    token: alice,
    body: { text: "The new secret" },
  });
  await expect(stream.until(() => true)).rejects.toThrow(
    "The event stream closed"
  );
});

test("the recall tool says when the company has nothing", async () => {
  shadow.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("recall", { query: "zebra" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult"
      ) as ToolResultMessage | undefined;
      const text = result?.content[0];
      return fauxAssistantMessage(
        text?.type === "text" ? text.text : "no tool result"
      );
    },
  ]);
  const empty = await companyOf(alice, "Empty");
  const emptyDetail = await body(
    await shadow.call(`/api/v1/companies/${empty.id}`, { token: alice })
  );
  const thread = await body(
    await shadow.call(`/api/v1/companies/${empty.id}/threads`, {
      token: alice,
      body: { channelId: emptyDetail.channels[0].id, text: "Any zebras?" },
    })
  );
  const stream = threadEvents(
    await shadow.call(`/api/v1/threads/${thread.id}/events`, { token: alice })
  );
  const done = await stream.until(
    (state) => !state.running && state.messages.length === 2
  );
  await stream.stop();
  expect(done.messages[1]).toMatchObject({
    agent: true,
    text: "Nothing found in this company.",
  });
});

test("the LLM login and logout answer with the provider status", async () => {
  // The faux provider has an API key and no device login.
  const login = await body(
    await shadow.call("/api/v1/llm/login", { method: "POST", token: alice })
  );
  expect(login).toMatchObject({ connected: true, login: null });
  expect(login.error).toContain("does not support oauth login");
  expect(
    await body(
      await shadow.call("/api/v1/llm/logout", { method: "POST", token: alice })
    )
  ).toMatchObject({ login: null, error: null });
  expect(
    await body(
      await shadow.call("/api/v1/llm/model", {
        method: "PUT",
        token: alice,
        body: { model: shadow.model.id },
      })
    )
  ).toMatchObject({ model: shadow.model.id });
  expect(
    (await shadow.call("/api/v1/llm/login", { method: "POST" })).status
  ).toBe(401);
});

/** Reads `event: thread` messages from a server-sent events response. */
function threadEvents(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async until(done: (state: any) => boolean): Promise<any> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end === -1) {
          const { value, done: closed } = await reader.read();
          if (closed) {
            throw new Error("The event stream closed");
          }
          buffer += decoder.decode(value, { stream: true });
          continue;
        }
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!block.startsWith("event: thread\n")) {
          continue;
        }
        const state = JSON.parse(block.slice(block.indexOf("data: ") + 6));
        if (done(state)) {
          return state;
        }
      }
    },
    stop: () => reader.cancel(),
  };
}

test("only an admin renames the company, and nobody makes or deletes one", async () => {
  const trip = await companyOf(alice, "Trip");
  const path = `/api/v1/companies/${trip.id}`;
  expect(
    (
      await shadow.call(path, {
        token: bob,
        method: "PUT",
        body: { name: "X" },
      })
    ).status
  ).toBe(404);
  await shadow.call(`${path}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  expect(
    await failure(
      await shadow.call(path, {
        token: bob,
        method: "PUT",
        body: { name: "X" },
      })
    )
  ).toEqual({ status: 403, error: "Only an admin can do this" });
  expect(
    await failure(
      await shadow.call(path, {
        token: alice,
        method: "PUT",
        body: { name: " " },
      })
    )
  ).toEqual({ status: 400, error: "Name is required" });
  expect(
    await body(
      await shadow.call(path, {
        token: alice,
        method: "PUT",
        body: { name: " Holiday " },
      })
    )
  ).toEqual({ id: trip.id, name: "Holiday", role: "admin" });
  expect(
    (await body(await shadow.call("/api/v1/me", { token: bob }))).companies
  ).toContainEqual({ id: trip.id, name: "Holiday", role: "member" });

  // better-auth's own routes neither delete a company nor make another.
  await shadow.call("/api/auth/organization/delete", {
    token: alice,
    body: { organizationId: trip.id },
  });
  expect((await shadow.call(path, { token: alice })).status).toBe(200);
  const before = shadow.app.companies.ids().length;
  await shadow.call("/api/auth/organization/create", {
    token: alice,
    body: { name: "Another", slug: "another" },
  });
  await shadow.call("/api/v1/companies", {
    token: alice,
    body: { name: "Another" },
  });
  expect(
    (await shadow.call(path, { token: alice, method: "DELETE" })).status
  ).toBe(404);
  expect(shadow.app.companies.ids()).toHaveLength(before);
});

test("a private channel and its search results are private, and neither orchestrator copies its messages", async () => {
  shadow.faux.setResponses([
    fauxAssistantMessage("Noted."),
    fauxAssistantMessage("Noted."),
  ]);
  const base = `/api/v1/companies/${companyId}`;
  // Bob is a member already when the earlier tests ran.
  await shadow.call(`${base}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  const orchestrators = await Promise.all(
    [alice, bob].map(async (token) =>
      body(await shadow.call(`${base}/orchestrator`, { token }))
    )
  );
  const channel = await body(
    await shadow.call(`${base}/channels`, {
      token: alice,
      body: { name: "surprise", private: true },
    })
  );
  expect(channel.ownerId).toBeString();
  const shared = await body(
    await shadow.call(`${base}/channels`, {
      token: alice,
      body: { name: "together" },
    })
  );
  // A person makes only private channels; the shared ones come from Slack.
  expect(shared.ownerId).toBe(channel.ownerId);
  const listed = async (token: string) =>
    (await body(await shadow.call(base, { token }))).channels.map(
      (candidate: { name: string }) => candidate.name
    );
  expect(await listed(alice)).toContain("surprise");
  expect(await listed(bob)).not.toContain("surprise");
  expect(await listed(bob)).not.toContain("together");

  const thread = await body(
    await shadow.call(`${base}/threads`, {
      token: alice,
      body: { channelId: channel.id, text: "A zebrafish tank for Bob" },
    })
  );
  expect(
    (await shadow.call(`/api/v1/threads/${thread.id}`, { token: bob })).status
  ).toBe(404);
  expect(
    (
      await shadow.call(`${base}/threads`, {
        token: bob,
        body: { channelId: channel.id, text: "Let me in" },
      })
    ).status
  ).toBe(404);
  expect(
    (
      await shadow.call(`${base}/channels/${channel.id}`, {
        token: bob,
        method: "DELETE",
      })
    ).status
  ).toBe(404);

  await shadow.app.indexer.scan(companyId);
  const found = async (token: string) =>
    (
      await body(await shadow.call(`${base}/search?q=zebrafish`, { token }))
    ).results.map((result: { threadId: string }) => result.threadId);
  expect(await found(alice)).toContain(thread.id);
  expect(await found(bob)).toEqual([]);

  const linesOf = (orchestratorId: string) => {
    const path = join(
      shadow.dataDirectory,
      "companies",
      companyId,
      "threads",
      orchestratorId,
      "memory.sqlite"
    );
    if (!existsSync(path)) {
      return [];
    }
    const memory = new Database(path);
    const rows = memory
      .query("SELECT thread_id AS threadId FROM line WHERE level = 0")
      .all() as { threadId: string }[];
    memory.close();
    return rows.map((row) => row.threadId);
  };
  await until(
    async () =>
      orchestrators.every((orchestrator) =>
        existsSync(
          join(
            shadow.dataDirectory,
            "companies",
            companyId,
            "threads",
            orchestrator.id,
            "memory.sqlite"
          )
        )
      ),
    Boolean
  );
  expect(linesOf(orchestrators[0].id)).not.toContain(thread.id);
  expect(linesOf(orchestrators[1].id)).not.toContain(thread.id);
});

test("in a channel every member sees, a turn finds the private threads of the person it answers, and only theirs", async () => {
  const base = `/api/v1/companies/${companyId}`;
  await shadow.call(`${base}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  const echoRecall = () => [
    fauxAssistantMessage(fauxToolCall("recall", { query: "okapi" }), {
      stopReason: "toolUse" as const,
    }),
    (context: { messages: { role: string }[] }) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult"
      ) as ToolResultMessage | undefined;
      const text = result?.content[0];
      return fauxAssistantMessage(
        text?.type === "text" ? text.text : "no tool result"
      );
    },
  ];
  shadow.faux.setResponses([fauxAssistantMessage("Noted.")]);
  const secret = await body(
    await shadow.call(`${base}/channels`, {
      token: alice,
      body: { name: "okapi-plans", private: true },
    })
  );
  const hidden = await body(
    await shadow.call(`${base}/threads`, {
      token: alice,
      body: { channelId: secret.id, text: "An okapi plush for Bob" },
    })
  );
  await until(
    async () =>
      body(await shadow.call(`/api/v1/threads/${hidden.id}`, { token: alice })),
    (state) => !state.running && state.messages.length === 2
  );
  await shadow.app.indexer.scan(companyId);

  const { channels } = await body(await shadow.call(base, { token: alice }));
  const general = channels.find(
    (channel: { name: string }) => channel.name === "general"
  );
  shadow.faux.setResponses(echoRecall());
  const shared = await body(
    await shadow.call(`${base}/threads`, {
      token: alice,
      body: { channelId: general.id, text: "What about the okapi?" },
    })
  );
  const answered = async (count: number) =>
    until(
      async () =>
        body(await shadow.call(`/api/v1/threads/${shared.id}`, { token: bob })),
      (state) => !state.running && state.messages.length === count
    );
  expect((await answered(2)).messages[1].text).toContain(hidden.id);

  shadow.faux.setResponses(echoRecall());
  await shadow.call(`/api/v1/threads/${shared.id}/messages`, {
    token: bob,
    body: { text: "And for me, the okapi?" },
  });
  expect((await answered(4)).messages[3].text).not.toContain(hidden.id);
});
