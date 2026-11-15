import { accountApiRoutes } from "../accounts/api.ts";
import { agendaApiRoutes } from "../agenda/api.ts";
import { artifactApiRoutes } from "../artifacts/api.ts";
import { artifactWebRoutes } from "../artifacts/web.ts";
import { feedbackApiRoutes } from "../feedback/api.ts";
import { intakeApiRoutes } from "../intake/api.ts";
import { integrationApiRoutes } from "../integrations/api.ts";
import { llmApiRoutes } from "../llm/api.ts";
import { notificationApiRoutes } from "../notifications/api.ts";
import { placeApiRoutes } from "../places/api.ts";
import { HttpError } from "../platform/errors.ts";
import { routineApiRoutes } from "../routines/api.ts";
import { searchApiRoutes } from "../search/api.ts";
import { threadApiRoutes } from "../threads/api.ts";
import { workspaceApiRoutes } from "../workspaces/api.ts";
import { api } from "./api.ts";
import type { Route } from "./http.ts";
import { appFile, appPage, asset } from "./web.ts";

/** The paths the web app routes in the browser; each one loads the app's page. */
const APP_PATHS = [
  "/",
  "/login",
  "/settings",
  "/workspaces/new",
  "/w/*",
] as const;

/**
 * Every route of the server: the JSON routes of each module (see docs/api.md), which the web app uses, the web app
 * itself, and the artifact links.
 */
export const allRoutes: readonly Route[] = [
  ["GET", "/assets/*", async ({ request }) => asset(request)],
  ["GET", "/app/*", async ({ request }) => appFile(request)],
  ...APP_PATHS.map((path): Route => ["GET", path, appPage]),
  ...accountApiRoutes,
  ...workspaceApiRoutes,
  ...llmApiRoutes,
  ...integrationApiRoutes,
  ...intakeApiRoutes,
  ...placeApiRoutes,
  ...artifactApiRoutes,
  ...artifactWebRoutes,
  ...notificationApiRoutes,
  ...threadApiRoutes,
  ...searchApiRoutes,
  ...routineApiRoutes,
  ...agendaApiRoutes,
  ...feedbackApiRoutes,
  [
    "POST",
    "/api/v1/server/restart",
    api(async ({ app, user }) => {
      if (
        user.email.toLowerCase() !== app.config.allowedEmails[0]?.toLowerCase()
      ) {
        throw new HttpError(403, "Only the server's owner restarts Shadow");
      }
      restart();
      return new Response(null, { status: 202 });
    }),
  ],
];

/**
 * Stops Shadow cleanly after the response goes out; its service starts it again, so it reads `config/shadow.toml`
 * again. Turns continue after the restart, because they are durable.
 */
function restart(): void {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
}
