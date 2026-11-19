import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { localDay } from "../platform/time.ts";
import type {
  Connector,
  ConnectorTool,
  FileOf,
  SaveFile,
  WatchedItem,
  WatchSource,
} from "./integrations.ts";

const AUTH = "https://accounts.google.com";
const SCOPE = "https://www.googleapis.com/auth/";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_TYPE = "application/vnd.google-apps.";

/**
 * Google's six official Workspace MCP servers. Each server has its own sign-in and account. Gmail and Drive also have
 * tools of Shadow on Google's REST API, for what their servers cannot do: send mail, save files, and change and share Drive files.
 */
export function googleConnectors(
  redirectUrl: string,
  fetch: typeof globalThis.fetch = globalThis.fetch
): readonly Connector[] {
  const services = [
    {
      id: "google",
      name: "Gmail",
      server: "gmailmcp",
      // `gmail.modify` lets the label, trash, and spam tools work.
      scopes: ["gmail.readonly", "gmail.compose", "gmail.modify"],
      tools: gmailTools(fetch),
    },
    {
      id: "google_drive",
      name: "Google Drive",
      server: "drivemcp",
      // `drive` lets Shadow's tools change files that the person did not make with Shadow.
      scopes: ["drive.readonly", "drive.file", "drive"],
      tools: driveTools(fetch),
    },
    {
      id: "google_docs",
      name: "Google Docs",
      server: "docsmcp",
      scopes: [
        "drive.readonly",
        "drive.file",
        "documents.readonly",
        "documents",
      ],
    },
    {
      id: "google_sheets",
      name: "Google Sheets",
      server: "sheetsmcp",
      scopes: [
        "drive.readonly",
        "drive.file",
        "spreadsheets.readonly",
        "spreadsheets",
      ],
    },
    {
      id: "google_slides",
      name: "Google Slides",
      server: "slidesmcp",
      scopes: [
        "drive.readonly",
        "drive.file",
        "presentations.readonly",
        "presentations",
      ],
    },
    {
      id: "google_calendar",
      name: "Google Calendar",
      server: "calendarmcp",
      scopes: [
        "calendar.calendarlist.readonly",
        "calendar.events.freebusy",
        "calendar.events",
      ],
    },
  ] as const;
  return services.map(
    (service): Connector => ({
      id: service.id,
      name: service.name,
      description: `The person's ${service.name}, through Google's own MCP server.`,
      secretLabel: null,
      tools: "tools" in service ? service.tools : [],
      mcp: [`https://${service.server}.googleapis.com/mcp/v1`],
      oauth: AUTH,
      registered: true,
      clientKey: "google",
      scope: [
        "openid",
        "email",
        ...service.scopes.map((scope) => SCOPE + scope),
      ].join(" "),
      authorizationParameters: {
        access_type: "offline",
        prompt: "consent select_account",
      },
      guide: [
        "Enable this service's Google API and MCP API in your Google Cloud project.",
        "Enroll the Google Cloud project in the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview). Until then, Google refuses every tool call, for Drive with “The caller does not have permission”.",
        `The Google OAuth client must have **Use this client for an AI-powered agent** selected and list \`${redirectUrl}\` as a redirect URI. Shadow uses the client in its server configuration.`,
        "Click **Connect** and select an account. Connect each Google service that you want Shadow to use.",
      ],
      ...(service.id === "google" ? { watch: watchGmail } : {}),
      ...(service.id === "google_calendar"
        ? {
            // They can email the guests.
            approvedTools: [
              "create_event",
              "update_event",
              "delete_event",
              "respond_to_event",
            ],
          }
        : {}),
    })
  );
}

function gmailTools(fetch: typeof globalThis.fetch): ConnectorTool[] {
  return [
    googleTool({
      name: "google_send_draft",
      description:
        "Sends a Gmail draft, by its id from google_create_draft or google_list_drafts. The person allows each send, and sees who gets the mail.",
      parameters: Type.Object({ draftId: Type.String() }),
      approval: async ({ draftId }, token, signal) => {
        const draft = await googleJson<{
          message: {
            payload?: { headers?: { name: string; value: string }[] };
          };
        }>(
          fetch,
          token,
          `${GMAIL}/drafts/${encodeURIComponent(draftId)}?format=metadata`,
          { signal }
        );
        const header = (name: string) =>
          draft.message.payload?.headers?.find(
            (each) => each.name.toLowerCase() === name
          )?.value;
        const copies = ["cc", "bcc"]
          .flatMap((name) => {
            const value = header(name);
            return value ? [`${name} ${value}`] : [];
          })
          .join(", ");
        return `Send the mail “${header("subject") ?? ""}” to ${header("to") ?? "nobody"}${copies ? ` (${copies})` : ""}`;
      },
      execute: ({ draftId }, token, signal) =>
        googleJson(fetch, token, `${GMAIL}/drafts/send`, {
          method: "POST",
          body: { id: draftId },
          signal,
        }),
    }),
    googleTool({
      name: "google_save_attachment",
      description:
        "Saves an attachment of a mail as a file of this channel, by the message id and the attachment's partId from google_get_message. Returns the file id.",
      parameters: Type.Object({
        messageId: Type.String(),
        partId: Type.String(),
        name: Type.Optional(
          Type.String({
            description: "The file name; the attachment's own when not given",
          })
        ),
      }),
      execute: async (
        { messageId, partId, name },
        token,
        signal,
        _file,
        _allowed,
        save
      ) => {
        const message = await googleJson<{ payload: GmailPart }>(
          fetch,
          token,
          `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`,
          { signal }
        );
        const part = partOf(message.payload, partId);
        if (!part) {
          throw new Error(`The message has no part ${partId}.`);
        }
        const data =
          part.body?.data ??
          (
            await googleJson<{ data: string }>(
              fetch,
              token,
              `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body?.attachmentId ?? "")}`,
              { signal }
            )
          ).data;
        return saveTo(save, name || part.filename || "attachment", (path) =>
          Bun.write(path, Buffer.from(data, "base64url"))
        );
      },
    }),
  ];
}

function driveTools(fetch: typeof globalThis.fetch): ConnectorTool[] {
  const FILE_ID = Type.String({ description: "The Drive file id" });
  return [
    googleTool({
      name: "google_drive_download",
      description:
        "Saves a Drive file as a file of this channel, such as to read or attach it. A Google Doc, Sheet, or Slides file is exported: as PDF, or a Sheet as XLSX, when exportMimeType is not given. Returns the file id.",
      parameters: Type.Object({
        fileId: FILE_ID,
        exportMimeType: Type.Optional(
          Type.String({
            description:
              "For a Google Doc, Sheet, or Slides file, such as `application/pdf`, `text/markdown`, `text/csv`, or the Office types",
          })
        ),
        name: Type.Optional(Type.String({ description: "The file name" })),
      }),
      execute: async (
        { fileId, exportMimeType, name },
        token,
        signal,
        _file,
        _allowed,
        save
      ) => {
        const file = await driveFile(fetch, token, fileId, signal);
        const google = file.mimeType.startsWith(GOOGLE_TYPE);
        const type = google
          ? (exportMimeType ??
            (file.mimeType === `${GOOGLE_TYPE}spreadsheet`
              ? XLSX
              : "application/pdf"))
          : file.mimeType;
        const response = await googleResponse(
          fetch,
          token,
          google
            ? `${DRIVE}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(type)}`
            : `${DRIVE}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
          { signal }
        );
        return saveTo(
          save,
          name ||
            (google ? `${file.name}${EXTENSIONS[type] ?? ""}` : file.name),
          (path) => Bun.write(path, response)
        );
      },
    }),
    googleTool({
      name: "google_drive_update_file",
      description:
        "Changes a Drive file: its content from a file of this company (a new version), its title or description, its folder, its star, or moves it to the trash or back.",
      parameters: Type.Object({
        fileId: FILE_ID,
        content: Type.Optional(
          Type.String({
            description:
              "The id of a company file whose bytes become the new version",
          })
        ),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        addParentId: Type.Optional(
          Type.String({
            description:
              "A folder id to add the file to; with removeParentId, a move",
          })
        ),
        removeParentId: Type.Optional(Type.String()),
        starred: Type.Optional(Type.Boolean()),
        trashed: Type.Optional(Type.Boolean()),
      }),
      execute: async (args, token, signal, file) => {
        const query = new URLSearchParams({
          supportsAllDrives: "true",
          fields: "id,name,mimeType,parents,starred,trashed,webViewLink",
          ...(args.addParentId ? { addParents: args.addParentId } : {}),
          ...(args.removeParentId
            ? { removeParents: args.removeParentId }
            : {}),
        });
        const id = encodeURIComponent(args.fileId);
        if (args.content) {
          const { path } = await companyFile(file, args.content);
          await googleJson(
            fetch,
            token,
            `${DRIVE_UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`,
            { method: "PATCH", raw: Bun.file(path), signal }
          );
        }
        // Then the rest, also with no change, as it gives the file as it is now.
        return googleJson(fetch, token, `${DRIVE}/${id}?${query}`, {
          method: "PATCH",
          body: {
            ...(args.title === undefined ? {} : { name: args.title }),
            ...(args.description === undefined
              ? {}
              : { description: args.description }),
            ...(args.starred === undefined ? {} : { starred: args.starred }),
            ...(args.trashed === undefined ? {} : { trashed: args.trashed }),
          },
          signal,
        });
      },
    }),
    googleTool({
      name: "google_drive_share",
      description:
        "Shares a Drive file with a person, a group, a domain, or anyone with the link. The person allows each share. Google emails a person or a group unless notify is false.",
      parameters: Type.Object({
        fileId: FILE_ID,
        role: Type.Union([
          Type.Literal("reader"),
          Type.Literal("commenter"),
          Type.Literal("writer"),
        ]),
        type: Type.Union([
          Type.Literal("user"),
          Type.Literal("group"),
          Type.Literal("domain"),
          Type.Literal("anyone"),
        ]),
        emailAddress: Type.Optional(
          Type.String({ description: "For a user or a group" })
        ),
        domain: Type.Optional(
          Type.String({ description: "For a domain, such as example.com" })
        ),
        notify: Type.Optional(
          Type.Boolean({ description: "True when not given" })
        ),
        message: Type.Optional(
          Type.String({ description: "The text of Google's email" })
        ),
      }),
      approval: async (args, token, signal) => {
        const file = await driveFile(fetch, token, args.fileId, signal);
        const who = {
          anyone: "anyone with the link",
          domain: `everyone at ${args.domain}`,
          user: args.emailAddress,
          group: args.emailAddress,
        }[args.type];
        return `Share “${file.name}” with ${who} as ${args.role}`;
      },
      execute: (args, token, signal) => {
        const email = args.type === "user" || args.type === "group";
        const query = new URLSearchParams({
          supportsAllDrives: "true",
          ...(email
            ? { sendNotificationEmail: String(args.notify ?? true) }
            : {}),
          ...(email && args.message ? { emailMessage: args.message } : {}),
        });
        return googleJson(
          fetch,
          token,
          `${DRIVE}/${encodeURIComponent(args.fileId)}/permissions?${query}`,
          {
            method: "POST",
            body: {
              role: args.role,
              type: args.type,
              ...(args.emailAddress ? { emailAddress: args.emailAddress } : {}),
              ...(args.domain ? { domain: args.domain } : {}),
            },
            signal,
          }
        );
      },
    }),
    googleTool({
      name: "google_drive_unshare",
      description:
        "Takes away a permission of a Drive file, by its id from google_drive_get_file_permissions. The person allows each change.",
      parameters: Type.Object({ fileId: FILE_ID, permissionId: Type.String() }),
      approval: async ({ fileId, permissionId }, token, signal) => {
        const file = await driveFile(fetch, token, fileId, signal);
        const permission = await googleJson<{
          type: string;
          emailAddress?: string;
          domain?: string;
        }>(
          fetch,
          token,
          `${DRIVE}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true&fields=type,emailAddress,domain`,
          { signal }
        );
        const who =
          permission.emailAddress ??
          permission.domain ??
          (permission.type === "anyone"
            ? "anyone with the link"
            : permission.type);
        return `Remove the access of ${who} to “${file.name}”`;
      },
      execute: async ({ fileId, permissionId }, token, signal) => {
        await googleResponse(
          fetch,
          token,
          `${DRIVE}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
          { method: "DELETE", signal }
        );
        return { removed: permissionId };
      },
    }),
  ];
}

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/zip": ".zip",
  "application/rtf": ".rtf",
  "application/epub+zip": ".epub",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  [XLSX]: ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
};

/** A tool of Shadow on Google's REST API; the secret it gets is the sign-in's access token. */
function googleTool<Parameters extends TSchema>(tool: {
  name: string;
  description: string;
  parameters: Parameters;
  approval?: (
    args: Static<Parameters>,
    token: string,
    signal: AbortSignal | undefined
  ) => Promise<string>;
  execute: (
    args: Static<Parameters>,
    token: string,
    signal: AbortSignal | undefined,
    file?: FileOf,
    allowed?: string,
    save?: SaveFile
  ) => Promise<unknown>;
}): ConnectorTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute as ConnectorTool["execute"],
    ...(tool.approval
      ? { approval: tool.approval as NonNullable<ConnectorTool["approval"]> }
      : {}),
  };
}

/** Calls Google's REST API, and gives its answer; a refusal throws with Google's own message. */
async function googleResponse(
  fetch: typeof globalThis.fetch,
  token: string,
  url: string,
  init: { method?: string; body?: unknown; raw?: Blob; signal?: AbortSignal }
): Promise<Response> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(init.raw
        ? { "content-type": init.raw.type || "application/octet-stream" }
        : {}),
    },
    body:
      init.raw ??
      (init.body === undefined ? undefined : JSON.stringify(init.body)),
    signal: init.signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message =
        (JSON.parse(text) as { error?: { message?: string } }).error?.message ??
        text;
    } catch {
      // Not JSON: Google's text is the message.
    }
    throw new Error(`Google refused the call (${response.status}): ${message}`);
  }
  return response;
}

async function googleJson<Value = unknown>(
  fetch: typeof globalThis.fetch,
  token: string,
  url: string,
  init: { method?: string; body?: unknown; raw?: Blob; signal?: AbortSignal }
): Promise<Value> {
  const text = await (await googleResponse(fetch, token, url, init)).text();
  return (text ? JSON.parse(text) : {}) as Value;
}

function driveFile(
  fetch: typeof globalThis.fetch,
  token: string,
  fileId: string,
  signal: AbortSignal | undefined
): Promise<{ name: string; mimeType: string }> {
  return googleJson(
    fetch,
    token,
    `${DRIVE}/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=name,mimeType`,
    { signal }
  );
}

function companyFile(file: FileOf | undefined, fileId: string) {
  if (!file) {
    throw new Error("Only an agent in a thread can give a tool a file.");
  }
  return file(fileId);
}

/** Saves a file to the channel of the turn's thread, and gives its id and name. */
async function saveTo(
  save: SaveFile | undefined,
  name: string,
  write: (path: string) => Promise<unknown>
) {
  if (!save) {
    throw new Error("Only an agent in a thread can save a file.");
  }
  const file = await save(async (path) => {
    await write(path);
    return name;
  });
  return { file: file.id, name: file.name };
}

interface GmailPart {
  partId?: string;
  filename?: string;
  body?: { attachmentId?: string; data?: string };
  parts?: GmailPart[];
}

function partOf(part: GmailPart, partId: string): GmailPart | undefined {
  if (part.partId === partId) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = partOf(child, partId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

interface GmailMessage {
  id: string;
  subject?: string;
  sender?: string;
  date?: string;
  plaintextBody?: string;
  snippet?: string;
  labelIds?: string[];
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

/** Reads new mail through Google's Gmail MCP server for the account's owner. */
export async function watchGmail(source: WatchSource): Promise<WatchedItem[]> {
  const saved = (source.checkpoint?.value ?? {}) as {
    pageToken?: string;
    through?: number;
  };
  const through = saved.through ?? Date.now();
  const earliest = localDay(source.since - 24 * 60 * 60_000);
  const day = earliest.replaceAll("-", "/");
  const items: WatchedItem[] = [];
  let { pageToken } = saved;
  for (let page = 0; page < 5; page += 1) {
    const answer = await source.call("search_threads", {
      query: `after:${day} -in:draft`,
      pageSize: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    source.record?.("raw", { tool: "search_threads", response: answer });
    const result = gmailData<{
      threads?: GmailThread[];
      nextPageToken?: string;
    }>(answer);
    for (const summary of result.threads ?? []) {
      items.push(
        ...(await readGmailThread(source, summary, Date.parse(earliest)))
      );
    }
    pageToken = result.nextPageToken;
    if (!pageToken) {
      source.record?.("coverage", { complete: true, through });
      break;
    }
  }
  if (pageToken) {
    source.record?.("coverage", {
      complete: false,
      reason: "Gmail page budget",
    });
  }
  source.checkpoint?.save({
    pageToken,
    through: pageToken ? through : undefined,
  });
  return items;
}

async function readGmailThread(
  source: WatchSource,
  summary: GmailThread,
  earliest: number
): Promise<WatchedItem[]> {
  if (
    !summary.id ||
    (summary.messages?.length &&
      summary.messages.every((message) => source.seen(message.id)))
  ) {
    return [];
  }
  const full = gmailData<GmailThread>(
    await source.call("get_thread", {
      threadId: summary.id,
      messageFormat: "FULL_CONTENT",
    })
  );
  source.record?.("raw", { tool: "get_thread", response: full });
  return (full.messages ?? []).flatMap((message) => {
    const at = Date.parse(message.date ?? "");
    if (
      !message.id ||
      source.seen(message.id) ||
      message.labelIds?.includes("DRAFT") ||
      !Number.isFinite(at) ||
      at < earliest
    ) {
      return [];
    }
    return [
      {
        id: message.id,
        kind: "message" as const,
        chat: summary.id,
        chatName: message.subject ?? "Mail",
        group: false,
        sender: message.sender ?? "",
        fromOwner:
          message.labelIds?.includes("SENT") === true ||
          message.sender?.toLowerCase() === source.account.toLowerCase(),
        at,
        text: message.plaintextBody || message.snippet || "",
        url: `https://mail.google.com/mail/u/0/#all/${summary.id}`,
      },
    ];
  });
}

function gmailData<Value>(answer: unknown): Value {
  if (typeof answer !== "string") {
    return answer as Value;
  }
  return JSON.parse(answer) as Value;
}
