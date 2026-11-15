import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";
import type { CredentialSummary } from "./integrations.ts";

/**
 * The integrations, with the credentials that a person sees in the company: the shared ones and their own, which they
 * share or delete. Shadow's own OAuth client of an integration is the server's. The Slack bot is the company's, for
 * its admins.
 */
export const integrationApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/slack-bot",
    api(async ({ app, user, params }) =>
      json(app.slackBot.status(params.company!, user))
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
    "POST",
    "/api/v1/companies/:company/integrations/:integration/sign-in",
    api(async ({ app, user, params, body }) =>
      json(
        await app.integrations.finishConnect(
          params.company!,
          user,
          params.integration!,
          body.address as string | undefined
        )
      )
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/credentials/:credential",
    api(async ({ app, user, params, body }) => {
      if (
        typeof body.shared !== "boolean" &&
        typeof body.watched !== "boolean"
      ) {
        throw new HttpError(400, "Send shared or watched as true or false");
      }
      let credential: CredentialSummary | undefined;
      if (typeof body.shared === "boolean") {
        credential = app.integrations.setShared(
          params.company!,
          user,
          params.credential!,
          body.shared
        );
      }
      if (typeof body.watched === "boolean") {
        credential = app.integrations.setWatched(
          params.company!,
          user,
          params.credential!,
          body.watched
        );
      }
      return json(credential);
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
