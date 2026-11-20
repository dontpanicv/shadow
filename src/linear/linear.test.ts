import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import type { Channel } from "../companies/companies.ts";
import { migrate } from "../platform/database.ts";
import { localDay } from "../platform/time.ts";
import {
  LINEAR_BACKFILL_DAYS,
  LinearFeed,
  type LinearPorts,
} from "./linear.ts";

const NOW = Date.parse("2026-11-16T10:00:00Z");
const MINUTE = 60_000;

function channel(id: string, name: string, summary: string): Channel {
  return {
    id,
    name,
    ownerId: null,
    summary,
    icon: null,
    slackId: `S-${id}`,
    slackPrivate: false,
    personal: false,
    threads: [],
  };
}

/** An issue as Linear's API gives it, changed at `at`. */
function issue(
  identifier: string,
  at: number,
  changes: {
    state?: [string, string, string];
    comment?: string;
    createdAt?: number;
  } = {}
) {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    createdAt: new Date(
      changes.createdAt ?? NOW - 90 * 24 * 60 * MINUTE
    ).toISOString(),
    updatedAt: new Date(at).toISOString(),
    description: "What it does",
    priorityLabel: "No priority",
    state: {
      name: changes.state?.[1] ?? "In Progress",
      type: changes.state?.[2] ?? "started",
    },
    team: { key: "PIP" },
    project: null,
    assignee: { name: "Ann" },
    labels: { nodes: [] },
    history: {
      nodes: changes.state
        ? [
            {
              createdAt: new Date(at).toISOString(),
              actor: { name: "Ann" },
              fromState: { name: changes.state[0] },
              toState: { name: changes.state[1] },
            },
          ]
        : [],
    },
    comments: {
      nodes: changes.comment
        ? [
            {
              createdAt: new Date(at).toISOString(),
              body: changes.comment,
              user: { name: "Bob" },
            },
          ]
        : [],
    },
  };
}

function setup() {
  const database = authDatabase();
  migrate(database);
  const channels = [
    channel("c1", "pipes-dev", "The Pipes team."),
    channel("c2", "client-acme", "Acme, a client that waits for exports."),
  ];
  let issues: unknown[] = [];
  let failing = false;
  const reads: string[] = [];
  const asked: string[] = [];
  const files: {
    channelId: string;
    name: string;
    text: string;
    replaces?: string;
  }[] = [];
  const posts: Parameters<LinearPorts["post"]>[0][] = [];
  const changed: Parameters<LinearPorts["issueChanged"]>[1][] = [];
  const ports: LinearPorts = {
    keys: () => [{ companyId: "co", key: "lin_api_read" }],
    graphql: async (_key, _query, variables) => {
      if (failing) {
        throw new Error("Linear is down");
      }
      reads.push(String(variables.since));
      return {
        issues: {
          nodes: issues,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    },
    channels: () => channels,
    mentioning: (_companyId, key) => (key === "PIP-1" ? ["c1"] : []),
    // A private channel that search finds never reaches the model.
    search: async () => ["c2", "private"],
    ask: async (_companyId, _system, text) => {
      asked.push(text);
      return JSON.stringify({
        routes: [
          { issue: "PIP-2", channels: [{ id: "c2", action: "post" }] },
          { issue: "PIP-3", channels: [{ id: "private", action: "post" }] },
        ],
      });
    },
    writeFile: async (_companyId, channelId, file, replaces) => {
      files.push({
        channelId,
        name: file.name,
        text: await file.text(),
        ...(replaces ? { replaces } : {}),
      });
      return { id: replaces ?? `file-${files.length}`, name: file.name };
    },
    post: async (post) => {
      posts.push(post);
    },
    issueChanged: (_companyId, change) => {
      changed.push(change);
    },
  };
  const admins: string[] = [];
  const feed = new LinearFeed(
    database,
    {
      requireAdmin: (_companyId: string, user: { id: string }) => {
        admins.push(user.id);
      },
    } as never,
    ports
  );
  return {
    feed,
    admins,
    reads,
    asked,
    files,
    posts,
    changed,
    setIssues: (next: unknown[]) => {
      issues = next;
    },
    fail: (value: boolean) => {
      failing = value;
    },
  };
}

test("the first read files the last 30 days silently, and later reads post what finishes in a channel that has the issue", async () => {
  const shadow = setup();
  const admin = { id: "admin", name: "Admin", email: "admin@example.com" };
  const day = localDay(NOW - 60 * MINUTE);
  shadow.setIssues([
    issue("PIP-1", NOW - 60 * MINUTE, {
      state: ["In Progress", "Done", "completed"],
    }),
    issue("PIP-2", NOW - 50 * MINUTE, {
      comment: "Acme can test the export now",
    }),
    issue("PIP-3", NOW - 40 * MINUTE, { comment: "An internal cleanup" }),
    // A change of its order only, which no channel has, goes nowhere and costs nothing.
    issue("PIP-4", NOW - 30 * MINUTE),
  ]);
  await shadow.feed.tick(NOW);
  expect(shadow.reads).toEqual([
    new Date(NOW - LINEAR_BACKFILL_DAYS * 24 * 60 * MINUTE).toISOString(),
  ]);
  // Only issues that no channel named reach the model, with only the channels that every member sees.
  expect(shadow.asked).toHaveLength(1);
  expect(shadow.asked[0]).toContain("PIP-2");
  expect(shadow.asked[0]).not.toContain("PIP-1 ");
  expect(shadow.asked[0]).not.toContain("PIP-4");
  expect(shadow.asked[0]).not.toContain("private");
  expect(shadow.posts).toEqual([]);
  expect(shadow.files.map((file) => [file.channelId, file.name])).toEqual([
    ["c1", `linear-${day}.md`],
    ["c2", `linear-${day}.md`],
  ]);
  expect(shadow.files[0]!.text).toContain("In Progress → Done");
  expect(shadow.files[1]!.text).toContain(
    "Bob commented: Acme can test the export now"
  );

  // A later change adds to the day's entry; an issue that finishes in a channel that got it posts there once.
  shadow.setIssues([
    issue("PIP-1", NOW + 2 * MINUTE, { comment: "Released" }),
    issue("PIP-2", NOW + 3 * MINUTE, {
      state: ["In Review", "Done", "completed"],
    }),
  ]);
  await shadow.feed.tick(NOW + 5 * MINUTE);
  expect(shadow.reads.at(-1)).toBe(new Date(NOW - 10 * MINUTE).toISOString());
  expect(shadow.asked).toHaveLength(1);
  const pipes = shadow.files.findLast((file) => file.channelId === "c1")!;
  expect(pipes.replaces).toBe("file-1");
  expect(pipes.text).toContain("In Progress → Done");
  expect(pipes.text).toContain("Bob commented: Released");
  expect(shadow.posts.map((post) => [post.channelId, post.title])).toEqual([
    ["c2", "PIP-2 Title of PIP-2"],
  ]);
  expect(shadow.posts[0]!.file.name).toMatch(/^linear-/);

  // The ledgers get each change once, with the issue's state.
  expect(shadow.changed.at(-1)).toMatchObject({
    identifier: "PIP-2",
    url: "https://linear.app/acme/issue/PIP-2",
    stateType: "completed",
    stateName: "Done",
  });
  const changes = shadow.changed.length;

  // A read of the same versions again changes nothing.
  await shadow.feed.tick(NOW + 10 * MINUTE);
  expect(shadow.posts).toHaveLength(1);
  expect(shadow.changed).toHaveLength(changes);

  const status = shadow.feed.status("co", admin);
  expect(shadow.admins).toEqual(["admin"]);
  expect(status.backfilledAt).toBe(NOW);
  expect(status.polledThrough).toBe(NOW + 10 * MINUTE);
  expect(
    status.decisions.map((decision) => [
      decision.identifier,
      decision.channelName,
      decision.action,
      decision.reason,
    ])
  ).toEqual([
    ["PIP-2", "client-acme", "posted", "mentioned"],
    ["PIP-1", "pipes-dev", "filed", "mentioned"],
    ["PIP-3", null, "dropped", "no-fit"],
    ["PIP-2", "client-acme", "filed", "model"],
    ["PIP-1", "pipes-dev", "filed", "mentioned"],
  ]);
});

test("a failed read keeps where the next one starts, and says why", async () => {
  const shadow = setup();
  const admin = { id: "admin", name: "Admin", email: "admin@example.com" };
  shadow.setIssues([]);
  await shadow.feed.tick(NOW);
  shadow.fail(true);
  await shadow.feed.tick(NOW + 5 * MINUTE);
  expect(shadow.feed.status("co", admin)).toMatchObject({
    polledThrough: NOW,
    error: "Linear is down",
  });
  shadow.fail(false);
  await shadow.feed.tick(NOW + 10 * MINUTE);
  expect(shadow.reads.at(-1)).toBe(new Date(NOW - 10 * MINUTE).toISOString());
  expect(shadow.feed.status("co", admin).error).toBeNull();
});
