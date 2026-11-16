import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The goals of ambient listening in the Slack channels and its decisions, for admins, and its turns, for members. */
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
    "PUT",
    "/api/v1/companies/:company/slack/goals/:channel/off",
    api(async ({ app, user, params }) => {
      app.slack.setOff(params.company!, user, params.channel!, true);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/slack/goals/:channel/off",
    api(async ({ app, user, params }) => {
      app.slack.setOff(params.company!, user, params.channel!, false);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack/default-goal",
    api(async ({ app, user, params }) =>
      json(app.slack.defaultGoal(params.company!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/slack/default-goal",
    api(async ({ app, user, params, body }) =>
      json(
        app.slack.setDefaultGoal(params.company!, user, {
          wakeWhen: body.wakeWhen,
          engagement: body.engagement,
        })
      )
    ),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/slack/default-goal",
    api(async ({ app, user, params }) => {
      app.slack.removeDefaultGoal(params.company!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "POST",
    "/api/v1/companies/:company/slack/default-goal/suggest",
    api(async ({ app, user, params }) =>
      json(await app.slack.suggestDefaultGoal(params.company!, user))
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack/replies",
    api(async ({ app, user, params }) =>
      json(app.slack.replies(params.company!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/companies/:company/slack/replies",
    api(async ({ app, user, params, body }) =>
      json(app.slack.setReplies(params.company!, user, body.paused))
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack/decisions",
    api(async ({ app, user, params }) =>
      json(app.slack.decisions(params.company!, user))
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/slack/ambient",
    api(async ({ app, user, params }) =>
      json(app.slack.ambientTurns(params.company!, user))
    ),
  ],
];
