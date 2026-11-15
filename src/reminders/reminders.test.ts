import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import type { Companies } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { migrate } from "../platform/database.ts";
import type { Threads } from "../threads/threads.ts";
import { Reminders } from "./reminders.ts";

const alice: User = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob: User = { id: "bob", name: "Bob", email: "bob@example.com" };
const time = {
  at: "2090-11-01T09:00:00+01:00",
  timeZone: "Europe/Prague",
};

function setup(
  answer: (requestId: string) => string | null = () => "Done",
  requester: User | null = alice
) {
  const database = authDatabase();
  migrate(database);
  const threadsOf = (companyId: string) =>
    companyId === "home"
      ? [
          {
            id: "thread",
            companyId,
            channelId: "general",
            conversationId: 1,
            title: "Plans",
            updatedAt: 0,
            settledAt: null,
            ownerId: null,
            realm: null,
          },
        ]
      : [];
  const companies = {
    requireMember(companyId: string, user: User) {
      if (companyId !== "home" || ![alice.id, bob.id].includes(user.id)) {
        throw new Error("Not found");
      }
      return { id: "home", name: "Home", role: "admin" };
    },
    members(companyId: string, user: User) {
      if (companyId !== "home" || ![alice.id, bob.id].includes(user.id)) {
        throw new Error("Not found");
      }
      return [
        {
          userId: alice.id,
          name: alice.name,
          email: alice.email,
          role: "admin",
        },
        { userId: bob.id, name: bob.name, email: bob.email, role: "member" },
      ];
    },
    agentMember() {
      return alice;
    },
    threadsIn: (companyId: string) => threadsOf(companyId),
    allThreadsIn: (companyId: string) => threadsOf(companyId),
    threadOf: (companyId: string, conversationId: number) =>
      threadsOf(companyId).find(
        (thread) => thread.conversationId === conversationId
      ) ?? null,
  } as unknown as Pick<
    Companies,
    | "agentMember"
    | "allThreadsIn"
    | "requireMember"
    | "members"
    | "threadOf"
    | "threadsIn"
  >;
  const calls: string[] = [];
  const requesters: (string | null)[] = [];
  const asking = { requester };
  const threads = {
    instruct: async (
      _thread: unknown,
      _text: string,
      requestId: string,
      _notify: unknown,
      requesterId: string | null
    ) => {
      calls.push(requestId);
      requesters.push(requesterId);
      return answer(requestId);
    },
    requester: async () => asking.requester,
    realm: async () => null,
  } as unknown as Pick<Threads, "instruct" | "realm" | "requester">;
  return {
    database,
    companies,
    threads,
    reminders: new Reminders(database, companies, threads),
    calls,
    requesters,
    asking,
  };
}

test("one-time reminders run once, also when the machine starts after their due time", async () => {
  const { database, companies, threads, reminders, calls } = setup();
  const reminder = reminders.create("home", alice, "thread", alice.id, {
    id: "first",
    createdBy: alice.id,
    text: "Review the document",
    ...time,
  });
  expect(reminder.dueAt).toBe(Date.UTC(2090, 10, 1, 8));
  expect(reminders.tick(reminder.dueAt - 1)).toEqual([]);
  const restarted = new Reminders(database, companies, threads);
  await Promise.all(restarted.tick(reminder.dueAt + 60_000));
  expect(calls).toEqual(["reminder:first:0"]);
  expect(reminders.get("home", alice, null, "first").deliveredAt).toBeNumber();
  expect(reminders.tick(reminder.dueAt + 120_000)).toEqual([]);
  database.close();
});

test("a failed reminder retries, a quiet one is done, and a cancelled one stays quiet", async () => {
  let fail = true;
  const { database, reminders, calls } = setup((requestId) => {
    if (fail) {
      fail = false;
      throw new Error("The model failed");
    }
    return requestId.startsWith("reminder:quiet") ? null : "Done";
  });
  const quiet = reminders.create("home", alice, "thread", alice.id, {
    id: "quiet",
    createdBy: alice.id,
    text: "Water the plants",
    ...time,
    at: "2090-11-01T10:00:00+01:00",
  });
  const first = reminders.create("home", alice, "thread", alice.id, {
    id: "retry",
    createdBy: alice.id,
    text: "Call grandma",
    ...time,
  });
  const second = reminders.create("home", alice, "thread", alice.id, {
    id: "cancel",
    createdBy: alice.id,
    text: "Buy milk",
    ...time,
  });
  reminders.cancel("home", alice, null, second.id);
  await Promise.all(reminders.tick(first.dueAt));
  const pending = reminders.get("home", alice, null, first.id);
  expect(pending.attempts).toBe(1);
  expect(pending.deliveredAt).toBeNull();
  await Promise.all(reminders.tick(pending.nextAttemptAt));
  expect(reminders.get("home", alice, null, first.id).deliveredAt).toBeNumber();
  await Promise.all(reminders.tick(quiet.dueAt));
  expect(reminders.get("home", alice, null, quiet.id).deliveredAt).toBeNumber();
  expect(calls).toEqual([
    "reminder:retry:0",
    "reminder:retry:1",
    "reminder:quiet:0",
  ]);
  database.close();
});

test("reminders stay in their company and reject a wrong time-zone offset", () => {
  const { database, reminders } = setup();
  expect(reminders.tools("home").map((tool) => tool.name)).toEqual([
    "reminders_create",
    "reminders_list",
    "reminders_update",
    "reminders_cancel",
  ]);
  expect(() =>
    reminders.create("home", alice, "thread", alice.id, {
      id: "wrong-zone",
      createdBy: alice.id,
      text: "Call grandma",
      at: "2090-11-01T09:00:00+02:00",
      timeZone: "Europe/Prague",
    })
  ).toThrow("UTC offset");
  expect(() =>
    reminders.create("home", alice, "thread", "eve", {
      id: "wrong-person",
      createdBy: alice.id,
      text: "Call grandma",
      ...time,
    })
  ).toThrow("Not found");
  expect(() => reminders.list("other", alice, null)).toThrow("Not found");
  expect(() =>
    reminders.get("home", { ...bob, id: "eve" }, null, "wrong-person")
  ).toThrow("Not found");
  database.close();
});

test("the agent tool creates a company reminder for the person who asked", async () => {
  const { database, reminders } = setup();
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_create")!;
  const result = await tool.execute(
    { text: "Review the document", ...time },
    { conversationId: 1, taskId: 3 } as never,
    {} as never
  );
  expect(result.output?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("2090-11-01T09:00+01:00 (Europe/Prague)"),
  });
  const [reminder] = reminders.list("home", alice, null);
  expect(reminder).toMatchObject({
    threadId: "thread",
    recipientId: alice.id,
    text: "Review the document",
  });
  const update = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_update")!;
  await update.execute(
    {
      reminder: reminder!.id,
      text: "Review the new document",
      at: "2091-11-01T09:00:00+01:00",
      timeZone: "Europe/Prague",
    },
    { conversationId: 1, taskId: 4 } as never,
    {} as never
  );
  const cancel = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_cancel")!;
  await cancel.execute(
    { reminder: reminder!.id },
    { conversationId: 1, taskId: 5 } as never,
    {} as never
  );
  expect(reminders.get("home", alice, null, reminder!.id)).toMatchObject({
    text: "Review the new document",
    cancelledAt: expect.any(Number),
  });
  database.close();
});

test("a turn without a person makes no reminder", async () => {
  const { database, reminders } = setup(() => "Done", null);
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_create")!;
  await expect(
    tool.execute(
      { text: "Review the document", recipient: "Alice", ...time },
      { conversationId: 1, taskId: 5 } as never,
      {} as never
    )
  ).rejects.toThrow("Only a person's own request makes a reminder.");
  expect(reminders.list("home", alice, null)).toHaveLength(0);
  database.close();
});

test("a reminder runs as the person who asked for it or last changed it, not as its recipient", async () => {
  const { database, reminders, requesters, asking } = setup();
  const tool = (name: string) =>
    reminders.tools("home").find((candidate) => candidate.name === name)!;
  await tool("reminders_create").execute(
    { text: "Send the invoice", recipient: "Bob", ...time },
    { conversationId: 1, taskId: 6 } as never,
    {} as never
  );
  const [reminder] = reminders.list("home", alice, null);
  expect(reminder).toMatchObject({ recipientId: bob.id, createdBy: alice.id });
  await Promise.all(reminders.tick(reminder!.dueAt));
  expect(requesters).toEqual([alice.id]);

  const second = reminders.create("home", alice, "thread", alice.id, {
    id: "changed",
    createdBy: alice.id,
    text: "Pay rent",
    ...time,
  });
  asking.requester = bob;
  await tool("reminders_update").execute(
    { reminder: second.id, text: "Pay rent to me", ...time },
    { conversationId: 1, taskId: 7 } as never,
    {} as never
  );
  await Promise.all(reminders.tick(second.dueAt));
  expect(requesters).toEqual([alice.id, bob.id]);

  const older = reminders.create("home", alice, "thread", alice.id, {
    id: "older",
    createdBy: alice.id,
    text: "Water the plants",
    ...time,
  });
  database
    .query("UPDATE reminder SET created_by = NULL WHERE id = ?")
    .run(older.id);
  await Promise.all(reminders.tick(older.dueAt));
  expect(requesters).toEqual([alice.id, bob.id, null]);
  database.close();
});
