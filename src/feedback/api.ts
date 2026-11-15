import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The reports that agents write about Shadow, for an admin. */
export const feedbackApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/feedback",
    api(async ({ app, user, params }) =>
      json({ feedback: app.feedback.list(params.company!, user) })
    ),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/feedback/:feedback",
    api(async ({ app, user, params }) => {
      app.feedback.dismiss(params.company!, user, params.feedback!);
      return new Response(null, { status: 204 });
    }),
  ],
];
