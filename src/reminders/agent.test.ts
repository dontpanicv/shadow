import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  scriptCall,
  startTestApp,
  type TestApp,
  until,
} from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

let shadow: TestApp;
let alice: User;

beforeAll(async () => {
  shadow = await startTestApp();
  await shadow.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await shadow.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
  shadow.faux.setResponses(Array.from({ length: 30 }, () => agent));
});
afterAll(() => shadow.close());

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

function agent(context: Context) {
  const last = context.messages.at(-1)!;
  if (last.role === "toolResult") {
    return fauxAssistantMessage("Scheduled.");
  }
  if (textOf(last).endsWith("Delegate reminder")) {
    return fauxAssistantMessage(
      [fauxToolCall("start_thread", { message: "Remind me next year" })],
      { stopReason: "toolUse" }
    );
  }
  if (textOf(last).endsWith("Remind me next year")) {
    return fauxAssistantMessage(
      [
        scriptCall("reminders_create", {
          text: "Review the document",
          at: "2090-11-01T09:00:00+01:00",
          timeZone: "Europe/Prague",
        }),
      ],
      { stopReason: "toolUse" }
    );
  }
  return fauxAssistantMessage("Ok.");
}

test("the orchestrator and a channel thread can both schedule reminders in their company", async () => {
  const company = await shadow.app.companies.create(alice, "Family");
  const orchestrator = await shadow.app.threads.orchestrator(company.id, alice);
  const channel = shadow.app.companies.channels(company.id, alice)[0]!;
  const thread = await shadow.app.threads.create(
    company.id,
    alice,
    channel.id,
    "Remind me next year"
  );
  await shadow.app.threads.send(orchestrator.id, alice, "Remind me next year");
  await until(
    () => shadow.app.threads.messages(orchestrator),
    (state) => !state.running && state.messages.at(-1)?.text === "Scheduled."
  );
  await until(
    () =>
      shadow.app.threads.messages(
        shadow.app.companies.thread(thread.id, alice)
      ),
    (state) => !state.running && state.messages.at(-1)?.text === "Scheduled."
  );
  expect(
    shadow.app.reminders
      .list(company.id, alice, alice.id)
      .map((reminder) => reminder.threadId)
      .sort()
  ).toEqual([orchestrator.id, thread.id].sort());
  await shadow.app.threads.send(orchestrator.id, alice, "Delegate reminder");
  const delegated = await until(
    async () => shadow.app.reminders.list(company.id, alice, alice.id),
    (reminders) => reminders.length === 3
  );
  expect(delegated.every((reminder) => reminder.recipientId === alice.id)).toBe(
    true
  );
  const other = await shadow.app.companies.create(alice, "Other");
  expect(shadow.app.reminders.list(other.id, alice, null)).toEqual([]);
});
