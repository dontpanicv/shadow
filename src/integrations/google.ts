import type { Connector } from "./integrations.ts";

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
