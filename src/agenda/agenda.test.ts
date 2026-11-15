import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

let shadow: TestApp;
let alice: User;
let bob: User;

beforeAll(async () => {
  shadow = await startTestApp();
  shadow.faux.setResponses(
    Array.from({ length: 50 }, () => fauxAssistantMessage("Ok."))
  );
  alice = await person("Alice", "alice@example.com");
  bob = await person("Bob", "bob@example.com");
});
afterAll(() => shadow.close());

async function person(name: string, email: string): Promise<User> {
  await shadow.signIn(name, email);
  const { internalAdapter } = await shadow.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(email))!;
  return { id: user.id, name: user.name, email: user.email };
}

/** A local time a day from now, in the server's time zone, with its offset. */
function tomorrow(): string {
  const at = new Date(Date.now() + 86_400_000);
  at.setSeconds(0, 0);
  const offset = -at.getTimezoneOffset();
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const local = new Date(at.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, 16);
  return `${local}:00${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

test("Shadow keeps few suggestions per person, drops ones that cannot run, and never asks again what a person declined", async () => {
  const home = await shadow.app.companies.create(alice, "Agenda");
  const [general] = shadow.app.companies.channels(home.id, alice);
  const offer = (name: string, schedule = "0 7 * * *") =>
    shadow.app.agenda.offer(home.id, "thread", general!.id, {
      kind: "routine",
      personId: alice.id,
      name,
      schedule,
      instructions: "Do it",
      channel: null,
    });
  offer("Broken", "not cron");
  shadow.app.agenda.offer(home.id, "thread", general!.id, {
    kind: "reminder",
    personId: alice.id,
    text: "Too late",
    at: "2020-01-01T09:00:00+01:00",
  });
  offer("Weather");
  offer("weather");
  offer("Mail");
  offer("News");
  offer("Fourth");
  const names = () =>
    shadow.app.agenda.suggestions(home.id, alice).map((item) => item.name);
  expect(names()).toEqual(["Weather", "Mail", "News"]);

  const [weather] = shadow.app.agenda.suggestions(home.id, alice);
  const token = await shadow.signIn("Alice", "alice@example.com");
  const declined = await shadow.call(
    `/api/v1/companies/${home.id}/suggestions/${weather!.id}`,
    { token, body: { accept: false } }
  );
  expect(declined.status).toBe(204);
  offer("Weather");
  expect(names()).toEqual(["Mail", "News"]);
  expect(shadow.app.routines.inCompany(home.id, alice.id)).toEqual([]);
  expect(shadow.app.agenda.automations(home.id, alice.id)).toContain(
    'Suggested routine "Weather": declined'
  );
  // Another person cannot answer it.
  const bobToken = await shadow.signIn("Bob", "bob@example.com");
  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const [mail] = shadow.app.agenda.suggestions(home.id, alice);
  expect(
    (
      await shadow.call(
        `/api/v1/companies/${home.id}/suggestions/${mail!.id}`,
        { token: bobToken, body: { accept: true } }
      )
    ).status
  ).toBe(404);
});

test("an accepted reminder waits in the person's orchestrator, shows in Upcoming, and the person cancels it there", async () => {
  const home = await shadow.app.companies.create(alice, "Reminders");
  const [general] = shadow.app.companies.channels(home.id, alice);
  shadow.app.agenda.offer(home.id, "thread", general!.id, {
    kind: "reminder",
    personId: alice.id,
    text: "Call the dentist",
    at: tomorrow(),
  });
  const [suggestion] = shadow.app.agenda.upcoming(home.id, alice).suggestions;
  expect(suggestion!.at).toBeGreaterThan(Date.now());
  await shadow.app.agenda.answer(home.id, alice, suggestion!.id, true);

  const token = await shadow.signIn("Alice", "alice@example.com");
  const upcoming = (await (
    await shadow.call(`/api/v1/companies/${home.id}/upcoming`, { token })
  ).json()) as {
    reminders: { id: string; text: string; threadId: string }[];
    suggestions: unknown[];
    routines: unknown[];
    approvals: unknown[];
  };
  const orchestrator = await shadow.app.threads.orchestrator(home.id, alice);
  expect(upcoming.suggestions).toEqual([]);
  expect(upcoming.approvals).toEqual([]);
  expect(upcoming.reminders.map((item) => [item.text, item.threadId])).toEqual([
    ["Call the dentist", orchestrator.id],
  ]);

  await shadow.app.companies.addMember(home.id, alice, bob.email);
  const bobToken = await shadow.signIn("Bob", "bob@example.com");
  const path = `/api/v1/companies/${home.id}/reminders/${upcoming.reminders[0]!.id}`;
  expect(
    (await shadow.call(path, { token: bobToken, method: "DELETE" })).status
  ).toBe(404);
  expect((await shadow.call(path, { token, method: "DELETE" })).status).toBe(
    204
  );
  expect(shadow.app.agenda.upcoming(home.id, alice).reminders).toEqual([]);
});
