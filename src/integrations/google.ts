import { localDay } from "../platform/time.ts";
import type { Connector, WatchedItem, WatchSource } from "./integrations.ts";

const AUTH = "https://accounts.google.com";
const SCOPE = "https://www.googleapis.com/auth/";

/** Google's six official Workspace MCP servers. Each server has its own sign-in and account. */
export function googleConnectors(redirectUrl: string): readonly Connector[] {
  const services = [
    {
      id: "google",
      name: "Gmail",
      server: "gmailmcp",
      scopes: ["gmail.readonly", "gmail.compose"],
    },
    {
      id: "google_drive",
      name: "Google Drive",
      server: "drivemcp",
      scopes: ["drive.readonly", "drive.file"],
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
        "calendar.events.readonly",
      ],
    },
  ] as const;
  return services.map(
    (service): Connector => ({
      id: service.id,
      name: service.name,
      description: `The person's ${service.name}, through Google's own MCP server.`,
      secretLabel: null,
      tools: [],
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
        `The Google OAuth client must have **Use this client for an AI-powered agent** selected and list \`${redirectUrl}\` as a redirect URI. Shadow uses the client in its server configuration.`,
        "Click **Connect** and select an account. Connect each Google service that you want Shadow to use.",
      ],
      ...(service.id === "google" ? { watch: watchGmail } : {}),
      ...(service.id === "google_calendar"
        ? {
            hiddenTools: [
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
