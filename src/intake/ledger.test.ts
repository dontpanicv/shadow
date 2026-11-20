import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import { migrate } from "../platform/database.ts";
import { businessDays, Ledger } from "./ledger.ts";

const ZONE = "Europe/Prague";
// A Wednesday.
const WEDNESDAY = Date.parse("2026-11-18T09:00:00+01:00");
const DAY = 24 * 60 * 60_000;

function setup() {
  const database = authDatabase();
  migrate(database);
  return { database, ledger: new Ledger(database) };
}

function row(ledger: Ledger, id: string, owner = "alice") {
  return ledger.fields("co", owner).get(id)!;
}

function state(database: ReturnType<typeof setup>["database"], id: string) {
  return (
    database.query("SELECT state FROM intake_check WHERE id=?").get(id) as {
      state: string;
    }
  ).state;
}

test("business days count Monday to Friday after the first day", () => {
  // Wednesday to the next Wednesday: Thursday, Friday, Monday, Tuesday, Wednesday.
  expect(businessDays(WEDNESDAY, WEDNESDAY + 7 * DAY, ZONE)).toBe(5);
  // Friday to Monday.
  expect(businessDays(WEDNESDAY + 2 * DAY, WEDNESDAY + 5 * DAY, ZONE)).toBe(1);
  expect(businessDays(WEDNESDAY, WEDNESDAY, ZONE)).toBe(0);
});

test("each row gets the next permanent ref of its person, and a row with the same source changes instead", () => {
  const { database, ledger } = setup();
  const first = ledger.save(
    "co",
    "alice",
    {
      text: "Send Acme the offer",
      section: "on_me",
      whyMine: "promise",
      bucket: "today",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      note: "Promised in #c_acme",
    },
    WEDNESDAY
  );
  const second = ledger.save(
    "co",
    "alice",
    {
      text: "Bob sends the logs",
      section: "waiting",
      owedBy: "Bob",
      note: "Bob promised",
    },
    WEDNESDAY
  );
  const other = ledger.save(
    "co",
    "bob",
    { text: "Review the plan", note: "Asked" },
    WEDNESDAY
  );
  expect([row(ledger, first).ref, row(ledger, second).ref]).toEqual([1, 2]);
  expect(row(ledger, other, "bob").ref).toBe(1);
  expect(row(ledger, first)).toMatchObject({
    section: "on_me",
    whyMine: "promise",
    bucket: "today",
    sourceType: null,
    firstAskedAt: WEDNESDAY,
  });
  // The same source changes the open row; its History only grows.
  const again = ledger.save(
    "co",
    "alice",
    {
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      state: "done",
      note: "Sent, see the thread",
    },
    WEDNESDAY + DAY
  );
  expect(again).toBe(first);
  expect(state(database, first)).toBe("resolved");
  expect(row(ledger, first).closedAt).toEqual(expect.any(Number));
  expect(
    ledger
      .notes("co", "alice", [first])
      .get(first)!
      .map((note) => note.text)
  ).toEqual(["Sent, see the thread", "Promised in #c_acme"]);
  // Opening it again clears its close.
  ledger.save("co", "alice", {
    id: first,
    state: "open",
    note: "Acme asks again",
  });
  expect(row(ledger, first).closedAt).toBeNull();
  expect(() =>
    ledger.save("co", "alice", { text: "No line", note: " " })
  ).toThrow("History line");
  expect(() =>
    ledger.save("co", "alice", {
      text: "Odd",
      section: "x" as never,
      note: "n",
    })
  ).toThrow("section is one of");
});

test("a B row without movement moves to C after 5 business days, and needs the person after 10 in C", () => {
  const { ledger } = setup();
  const id = ledger.save(
    "co",
    "alice",
    {
      text: "Bob sends the logs",
      section: "waiting",
      owedBy: "Bob",
      note: "Bob promised",
    },
    WEDNESDAY
  );
  // Four business days later (Thursday to Tuesday): no change.
  expect(ledger.age("co", "alice", WEDNESDAY + 6 * DAY, ZONE)).toBe(0);
  expect(ledger.age("co", "alice", WEDNESDAY + 7 * DAY, ZONE)).toBe(1);
  expect(row(ledger, id)).toMatchObject({
    section: "dropped",
    movedToCAt: WEDNESDAY + 7 * DAY,
    needsYou: false,
  });
  expect(ledger.age("co", "alice", WEDNESDAY + 20 * DAY, ZONE)).toBe(0);
  expect(ledger.age("co", "alice", WEDNESDAY + 21 * DAY, ZONE)).toBe(1);
  expect(row(ledger, id).needsYou).toBe(true);
  expect(ledger.age("co", "alice", WEDNESDAY + 30 * DAY, ZONE)).toBe(0);
});

test("movement holds a B row in B", () => {
  const { ledger } = setup();
  const id = ledger.save(
    "co",
    "alice",
    { text: "Bob sends the logs", section: "waiting", note: "Bob promised" },
    WEDNESDAY
  );
  ledger.save(
    "co",
    "alice",
    { id, movement: true, note: "Bob: tomorrow" },
    WEDNESDAY + 6 * DAY
  );
  expect(ledger.age("co", "alice", WEDNESDAY + 7 * DAY, ZONE)).toBe(0);
});

test("a Linear issue closes the rows that name it as done or written off, and other changes are movement", () => {
  const { database, ledger } = setup();
  const named = ledger.save(
    "co",
    "alice",
    { text: "Ship PIP-12 to Acme", note: "Promised" },
    WEDNESDAY
  );
  const linked = ledger.save(
    "co",
    "alice",
    {
      text: "Fix the export",
      sourceUrl: "https://linear.app/acme/issue/AGE-3",
      note: "Asked",
    },
    WEDNESDAY
  );
  const inHistory = ledger.save(
    "co",
    "bob",
    { text: "Review the export", note: "See AGE-3" },
    WEDNESDAY
  );
  const unrelated = ledger.save(
    "co",
    "alice",
    { text: "Ship PIP-123", note: "Promised" },
    WEDNESDAY
  );
  ledger.issueChanged("co", {
    identifier: "PIP-12",
    url: "https://linear.app/acme/issue/PIP-12",
    stateType: "started",
    stateName: "In Progress",
    changes: ["Bob commented: on it"],
    at: WEDNESDAY + DAY,
  });
  expect(row(ledger, named).lastMovementAt).toBe(WEDNESDAY + DAY);
  expect(state(database, named)).toBe("open");
  expect(row(ledger, unrelated).lastMovementAt).toBeNull();
  ledger.issueChanged("co", {
    identifier: "AGE-3",
    url: "https://linear.app/acme/issue/AGE-3",
    stateType: "canceled",
    stateName: "Canceled",
    changes: [],
    at: WEDNESDAY + DAY,
  });
  expect(state(database, linked)).toBe("stopped");
  expect(state(database, inHistory)).toBe("stopped");
  ledger.issueChanged("co", {
    identifier: "PIP-12",
    url: "https://linear.app/acme/issue/PIP-12",
    stateType: "completed",
    stateName: "Done",
    changes: [],
    at: WEDNESDAY + 2 * DAY,
  });
  expect(state(database, named)).toBe("resolved");
  expect(ledger.notes("co", "alice", [named]).get(named)![0]!.text).toContain(
    "PIP-12 is Done in Linear"
  );
});

test("a :ledger: reaction makes one A row, and a reaction taken away asks closed? once", () => {
  const { ledger } = setup();
  const reaction = {
    permalink: "https://acme.slack.com/archives/C1/p2",
    text: "Can you check the invoice?",
    author: "Bob",
    at: WEDNESDAY,
    removed: false,
  };
  expect(ledger.importReactions("co", "alice", [reaction], WEDNESDAY)).toBe(1);
  expect(ledger.importReactions("co", "alice", [reaction], WEDNESDAY)).toBe(0);
  const [id, fields] = [...ledger.fields("co", "alice")][0]!;
  expect(fields).toMatchObject({
    section: "on_me",
    sourceType: "slack",
    sourceUrl: reaction.permalink,
    firstAskedAt: WEDNESDAY,
  });
  const removed = { ...reaction, removed: true };
  expect(
    ledger.importReactions("co", "alice", [removed], WEDNESDAY + DAY)
  ).toBe(1);
  expect(
    ledger.importReactions("co", "alice", [removed], WEDNESDAY + DAY)
  ).toBe(0);
  expect(ledger.notes("co", "alice", [id]).get(id)![0]!.text).toContain(
    "closed?"
  );
});

test("a meeting is kept by its event, lists the rows it opened, and a brief logs its window", () => {
  const { ledger } = setup();
  const meeting = {
    eventId: "event-1",
    title: "DevOps Sync",
    startAt: "2026-11-16T15:00:00+01:00",
    coverage: "gemini_transcript" as const,
  };
  const id = ledger.saveMeeting("co", "alice", meeting);
  expect(
    ledger.saveMeeting("co", "alice", { ...meeting, decisions: "Move to K8s" })
  ).toBe(id);
  const opened = ledger.save("co", "alice", {
    text: "Write the K8s plan",
    meetingId: id,
    note: "From the sync",
  });
  expect(ledger.meetings("co", "alice", 0)).toMatchObject([
    {
      id,
      title: "DevOps Sync",
      decisions: "Move to K8s",
      actions: [ledger.fields("co", "alice").get(opened)!.ref],
    },
  ]);
  expect(() =>
    ledger.saveMeeting("co", "alice", {
      ...meeting,
      coverage: "maybe" as never,
    })
  ).toThrow("Coverage");
  expect(ledger.lastBrief("co", "alice")).toBeNull();
  ledger.logBrief("co", "alice", {
    windowStart: WEDNESDAY - DAY,
    windowEnd: WEDNESDAY,
    zone: ZONE,
    notCovered: "",
    printedRefs: [2, 1],
  });
  expect(ledger.lastBrief("co", "alice")).toMatchObject({
    windowEnd: WEDNESDAY,
    printedRefs: [2, 1],
  });
});
