import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/**
 * The integrations, with only a person's own credentials. Shadow's own OAuth client of an integration is the server's. The Slack bot and the
 * observability addresses are the company's, for its admins.
 */
export const integrationApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/integrations/callback",
    api(async ({ app, user, request }) => {
      const settings = new URL("/settings", app.config.baseUrl);
      try {
        const name = await app.integrations.finishCallback(user, request.url);
        settings.searchParams.set("connected", name);
      } catch (error) {
        settings.searchParams.set("connection_error", (error as Error).message);
      }
      return Response.redirect(settings.href);
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack-bot",
    api(async ({ app, user, params }) =>
      json(app.slackBot.status(params.company!, user))
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack-bot/involved",
    api(async ({ app, user, params }) =>
      json({ channelIds: await app.slackBot.involved(params.company!, user) })
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/slack-bot",
    api(async ({ app, user, params, body }) =>
      json(
        await app.slackBot.connect(
          params.company!,
          user,
          body.token,
          body.appToken
        )
      )
    ),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/slack-bot",
    api(async ({ app, user, params }) => {
      app.slackBot.disconnect(params.company!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/observability",
    api(async ({ app, user, params }) =>
      json(app.observability.settings(params.company!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/observability",
    api(async ({ app, user, params, body }) =>
      json(app.observability.setSettings(params.company!, user, body))
    ),
  ],
  [
    "PUT",
    "/api/v1/integrations/:integration/client",
    api(async ({ app, user, params, body }) => {
      await app.integrations.setClient(user, params.integration!, {
        clientId: body.clientId as string,
        clientSecret: body.clientSecret as string,
      });
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/integrations",
    api(async ({ app, user, params }) =>
      json(app.integrations.list(params.company!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/integrations/:integration/credentials",
    api(async ({ app, user, params, body }) =>
      json(
        await app.integrations.addCredential(
          params.company!,
          user,
          params.integration!,
          {
            label: body.label as string | undefined,
            secret: body.secret as string,
            address: body.address as string | undefined,
            username: body.username as string | undefined,
          }
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/integrations/:integration/connect",
    api(async ({ app, user, params, body }) =>
      json(
        await app.integrations.connect(
          params.company!,
          user,
          params.integration!,
          { address: body.address as string | undefined }
        )
      )
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/credentials/:credential",
    api(async ({ app, user, params, body }) => {
      app.companies.requireMember(params.company!, user);
      if (typeof body.watched !== "boolean" || "shared" in body) {
        throw new HttpError(400, "Send watched as true or false");
      }
      return json(
        app.integrations.setWatched(
          params.company!,
          user,
          params.credential!,
          body.watched
        )
      );
    }),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/credentials/:credential",
    api(async ({ app, user, params }) => {
      app.integrations.deleteCredential(
        params.company!,
        user,
        params.credential!
      );
      return new Response(null, { status: 204 });
    }),
  ],
];
