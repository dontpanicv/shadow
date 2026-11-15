import { expect, test } from "bun:test";
import { watchGmail } from "./google.ts";
import type { WatchSource } from "./integrations.ts";

test("Gmail watch keeps new incoming and sent mail, and skips seen threads", async () => {
  const since = Date.parse("2026-11-15T10:00:00Z");
  const called: { tool: string; args: Record<string, unknown> }[] = [];
  const coverage: unknown[] = [];
  let checkpoint: unknown = {};
  const source: WatchSource = {
    since,
    account: "me@example.com",
    seen: (id) => id === "old",
    secret: async () => "",
    call: async (tool, args) => {
      called.push({ tool, args });
      if (tool === "search_threads") {
        return {
          threads: [
            { id: "thread-1", messages: [{ id: "old" }, { id: "new" }] },
            { id: "thread-2", messages: [{ id: "old" }] },
          ],
        };
      }
      return {
        messages: [
          { id: "old", date: "2026-11-14T12:00:00Z" },
          {
            id: "new",
            subject: "Work",
            sender: "peer@example.com",
            date: "2026-11-15T11:00:00Z",
            plaintextBody: "Please review",
          },
          {
            id: "sent",
            subject: "Work",
            sender: "me@example.com",
            date: "2026-11-15T12:00:00Z",
            labelIds: ["SENT"],
            plaintextBody: "I will review",
          },
          {
            id: "draft",
            date: "2026-11-15T12:30:00Z",
            labelIds: ["DRAFT"],
            plaintextBody: "Unsent reply",
          },
        ],
      };
    },
    record: (stage, data) => {
      if (stage === "coverage") {
        coverage.push(data);
      }
    },
    checkpoint: {
      value: checkpoint,
      save: (value) => {
        checkpoint = value;
      },
    },
  };
  const items = await watchGmail(source);
  expect(items.map(({ id, fromOwner, chat }) => [id, fromOwner, chat])).toEqual(
    [
      ["new", false, "thread-1"],
      ["sent", true, "thread-1"],
    ]
  );
  expect(called.map(({ tool }) => tool)).toEqual([
    "search_threads",
    "get_thread",
  ]);
  expect(called[0]!.args).toMatchObject({ pageSize: 50 });
  expect(coverage).toEqual([{ complete: true, through: expect.any(Number) }]);
  expect(checkpoint).toEqual({ pageToken: undefined, through: undefined });
});

test("Gmail watch saves its page when a large mailbox exceeds one poll", async () => {
  const tokens: unknown[] = [];
  const coverage: unknown[] = [];
  let checkpoint: unknown = {};
  const source: WatchSource = {
    since: Date.parse("2026-11-15T10:00:00Z"),
    account: "me@example.com",
    seen: () => false,
    secret: async () => "",
    call: async (tool, args) => {
      expect(tool).toBe("search_threads");
      tokens.push(args.pageToken);
      return { threads: [], nextPageToken: `page-${tokens.length}` };
    },
    record: (stage, data) => {
      if (stage === "coverage") {
        coverage.push(data);
      }
    },
    checkpoint: {
      value: checkpoint,
      save: (value) => {
        checkpoint = value;
      },
    },
  };
  expect(await watchGmail(source)).toEqual([]);
  expect(tokens).toEqual([undefined, "page-1", "page-2", "page-3", "page-4"]);
  expect(checkpoint).toMatchObject({ pageToken: "page-5" });
  expect(coverage).toEqual([{ complete: false, reason: "Gmail page budget" }]);
  tokens.length = 0;
  await watchGmail({
    ...source,
    checkpoint: { ...source.checkpoint!, value: checkpoint },
  });
  expect(tokens[0]).toBe("page-5");
});
