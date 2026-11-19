import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleConnectors, watchGmail } from "./google.ts";
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

/** The Google REST tools of Shadow, with a fake Google that answers by method and path. */
function restTools(
  answer: (method: string, url: URL, body: unknown) => Response
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    return answer(method, url, body);
  }) as typeof globalThis.fetch;
  const tools = googleConnectors("http://localhost/callback", fetch).flatMap(
    (connector) => connector.tools
  );
  const tool = (name: string) => tools.find((each) => each.name === name)!;
  return { calls, tool };
}

/** Saves to a file in a fresh folder, as a thread's channel does. */
function saver() {
  const saved: { path: string; name: string }[] = [];
  const save = async (write: (path: string) => Promise<string>) => {
    const path = `${mkdtempSync(join(tmpdir(), "google-"))}/file`;
    const name = await write(path);
    saved.push({ path, name });
    return { id: `file-${saved.length}`, name };
  };
  return { saved, save };
}

test("Gmail's REST tools send a draft after the person allows who gets it, and save an attachment", async () => {
  const { calls, tool } = restTools((method, url) => {
    if (url.pathname.endsWith("/drafts/draft-1")) {
      return Response.json({
        message: {
          payload: {
            headers: [
              { name: "To", value: "ada@example.com" },
              { name: "Cc", value: "bob@example.com" },
              { name: "Subject", value: "Offer" },
            ],
          },
        },
      });
    }
    if (method === "POST" && url.pathname.endsWith("/drafts/send")) {
      return Response.json({ id: "sent-1", threadId: "thread-1" });
    }
    if (url.pathname.endsWith("/messages/message-1")) {
      return Response.json({
        payload: {
          partId: "",
          parts: [
            { partId: "0", body: { data: "eA" } },
            {
              partId: "1",
              filename: "offer.pdf",
              body: { attachmentId: "fresh-id" },
            },
          ],
        },
      });
    }
    if (url.pathname.endsWith("/attachments/fresh-id")) {
      return Response.json({
        data: Buffer.from("%PDF").toString("base64url"),
      });
    }
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  });
  const send = tool("google_send_draft");
  expect(await send.approval!({ draftId: "draft-1" }, "token", undefined)).toBe(
    "Send the mail “Offer” to ada@example.com (cc bob@example.com)"
  );
  expect(
    await send.execute({ draftId: "draft-1" }, "token", undefined)
  ).toEqual({ id: "sent-1", threadId: "thread-1" });
  expect(calls.at(-1)).toMatchObject({
    method: "POST",
    body: { id: "draft-1" },
  });

  const { saved, save } = saver();
  expect(
    await tool("google_save_attachment").execute(
      { messageId: "message-1", partId: "1" },
      "token",
      undefined,
      undefined,
      undefined,
      save
    )
  ).toEqual({ file: "file-1", name: "offer.pdf" });
  expect(await Bun.file(saved[0]!.path).text()).toBe("%PDF");
  await expect(
    tool("google_save_attachment").execute(
      { messageId: "message-1", partId: "7" },
      "token",
      undefined,
      undefined,
      undefined,
      save
    )
  ).rejects.toThrow("The message has no part 7.");
  await expect(
    send.approval!(
      { draftId: "missing" },
      "token",
      undefined
    ) as Promise<string>
  ).rejects.toThrow("Google refused the call (404): Not found");
});

test("Drive's REST tools export a Google file, upload a new version, and share after the person allows it", async () => {
  const { calls, tool } = restTools((method, url) => {
    if (url.pathname.endsWith("/export")) {
      return new Response("sheet bytes");
    }
    if (url.pathname.endsWith("/permissions")) {
      return Response.json({ id: "permission-1" });
    }
    if (method === "GET") {
      return Response.json({
        name: "Budget",
        mimeType: "application/vnd.google-apps.spreadsheet",
      });
    }
    return Response.json({ id: "sheet-1", name: "Budget 2027" });
  });
  const { saved, save } = saver();
  expect(
    await tool("google_drive_download").execute(
      { fileId: "sheet-1" },
      "token",
      undefined,
      undefined,
      undefined,
      save
    )
  ).toEqual({ file: "file-1", name: "Budget.xlsx" });
  expect(await Bun.file(saved[0]!.path).text()).toBe("sheet bytes");
  expect(calls.at(-1)!.path).toContain(
    "mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  const upload = `${mkdtempSync(join(tmpdir(), "google-"))}/budget.xlsx`;
  await Bun.write(upload, "new version");
  calls.length = 0;
  expect(
    await tool("google_drive_update_file").execute(
      {
        fileId: "sheet-1",
        content: "company-file",
        title: "Budget 2027",
        addParentId: "folder-2",
        removeParentId: "folder-1",
      },
      "token",
      undefined,
      async () => ({ path: upload, name: "budget.xlsx" })
    )
  ).toEqual({ id: "sheet-1", name: "Budget 2027" });
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "PATCH /upload/drive/v3/files/sheet-1?uploadType=media&supportsAllDrives=true",
    "PATCH /drive/v3/files/sheet-1?supportsAllDrives=true&fields=id%2Cname%2CmimeType%2Cparents%2Cstarred%2Ctrashed%2CwebViewLink&addParents=folder-2&removeParents=folder-1",
  ]);
  expect(calls[1]!.body).toEqual({ name: "Budget 2027" });

  const share = tool("google_drive_share");
  const args = {
    fileId: "sheet-1",
    role: "writer",
    type: "user",
    emailAddress: "ada@example.com",
    notify: false,
  };
  expect(await share.approval!(args, "token", undefined)).toBe(
    "Share “Budget” with ada@example.com as writer"
  );
  expect(await share.execute(args, "token", undefined)).toEqual({
    id: "permission-1",
  });
  expect(calls.at(-1)).toMatchObject({
    method: "POST",
    path: "/drive/v3/files/sheet-1/permissions?supportsAllDrives=true&sendNotificationEmail=false",
    body: { role: "writer", type: "user", emailAddress: "ada@example.com" },
  });
  expect(
    await share.approval!(
      { fileId: "sheet-1", role: "reader", type: "anyone" },
      "token",
      undefined
    )
  ).toBe("Share “Budget” with anyone with the link as reader");
});
