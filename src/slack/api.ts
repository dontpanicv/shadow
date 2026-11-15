import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The goals of ambient listening in the Slack channels, and its decisions, for admins. */
export const slackApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/slack/goals",
    api(async ({ app, user, params }) =>
      json(app.slack.goals(params.company!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/slack/goals/:channel",
    api(async ({ app, user, params, body }) =>
      json(
        app.slack.setGoal(params.company!, user, params.channel!, {
          wakeWhen: body.wakeWhen,
          engagement: body.engagement,
        })
      )
    ),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/slack/goals/:channel",
    api(async ({ app, user, params }) => {
      app.slack.removeGoal(params.company!, user, params.channel!);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "POST",
    "/api/v1/companies/:company/slack/goals/:channel/suggest",
    api(async ({ app, user, params }) =>
      json(await app.slack.suggestGoal(params.company!, user, params.channel!))
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack/decisions",
    api(async ({ app, user, params }) =>
      json(app.slack.decisions(params.company!, user))
    ),
  ],
];
