import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import type { User } from "../platform/auth.ts";
import { migrate } from "../platform/database.ts";
import {
  type NotificationCompanies,
  Notifications,
  plainText,
} from "./notifications.ts";

const alice: User = { id: "alice", name: "Alice", email: "alice@example.com" };
const eve: User = { id: "eve", name: "Eve", email: "eve@example.com" };
const answer = {
  companyId: "home",
  userId: alice.id,
  channelId: "general",
  threadId: "flights",
  title: "Flights",
  text: "## Found\n- **Prague → Rome**: 89 EUR, see [the offer](https://example.com) ![chart](file:1)",
};

function setup() {
  const database = authDatabase();
  migrate(database);
  const companies = {
    requireMember(companyId: string, user: User) {
      if (companyId !== "home" || user.id !== alice.id) {
        throw new Error("Not found");
      }
      return { id: "home", name: "Home", role: "admin" };
    },
  } as NotificationCompanies;
  return { notifications: new Notifications(database, companies) };
}

test("a notification goes to the person's inbox as plain text", () => {
  const { notifications } = setup();
  const notification = notifications.notify(answer);
  expect(notification.text).toBe("Found Prague → Rome: 89 EUR, see the offer");
  expect(notifications.inbox("home", alice)).toEqual({
    notifications: [notification],
    unread: 1,
  });
  expect(() => notifications.inbox("home", eve)).toThrow("Not found");
  expect(notifications.notify({ ...answer, id: notification.id })).toEqual(
    notification
  );
});

test("opening a thread reads its notifications, and a new one there is read at once", () => {
  const { notifications } = setup();
  notifications.notify(answer);
  const unwatch = notifications.watch(alice, "flights");
  expect(notifications.inbox("home", alice).unread).toBe(0);
  const seen = notifications.notify(answer);
  expect(seen.readAt).toBe(seen.createdAt);
  unwatch();
  unwatch();
  notifications.notify(answer);
  expect(notifications.inbox("home", alice).unread).toBe(1);
});

test("people read one notification or all, only their own", () => {
  const { notifications } = setup();
  const first = notifications.notify(answer);
  notifications.notify({
    ...answer,
    threadId: null,
    text: "Look at the channel",
  });
  expect(notifications.read("home", alice, first.id).unread).toBe(1);
  expect(() => notifications.read("home", alice, "missing")).toThrow(
    "Not found"
  );
  expect(() => notifications.read("home", eve, null)).toThrow("Not found");
  expect(notifications.read("home", alice, null).unread).toBe(0);
});

test("plain text keeps what a person reads of Markdown", () => {
  expect(plainText("# Title\n\n1. one\n2. `two`\n> quoted <b>bold</b>")).toBe(
    "Title one two quoted bold"
  );
  expect(plainText("See [Rome](thread:abc) | 3 |")).toBe("See Rome 3");
  expect(
    plainText('Done.\n\n```card\n[{"value":"78 %"}]\n```\n\nTake the umbrella.')
  ).toBe("Done. Take the umbrella.");
});
