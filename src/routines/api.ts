import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The routines of a channel. Agents create and change them; people pause, run, and delete them. */
export const routineApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/channels/:channel/routines",
    api(async ({ app, user, params }) =>
      json(app.routines.inChannel(params.company!, params.channel!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/routines/:routine",
    api(async ({ app, user, params, body }) => {
      if (typeof body.instructions === "string") {
        return json(
          app.routines.setInstructions(params.routine!, user, body.instructions)
        );
      }
      return json(
        app.routines.setEnabled(params.routine!, user, body.enabled === true)
      );
    }),
  ],
  [
    "POST",
    "/api/v1/routines/:routine/runs",
    api(async ({ app, user, params }) => {
      app.routines.runNow(params.routine!, user);
      return new Response(null, { status: 202 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/routines/:routine",
    api(async ({ app, user, params }) => {
      app.routines.delete(params.routine!, user);
      return new Response(null, { status: 204 });
    }),
  ],
];
