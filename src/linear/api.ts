import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** What the feed of the company's Linear did, for its admins; the key is an integration's company key. */
export const linearApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/linear",
    api(async ({ app, user, params }) =>
      json(app.linear.status(params.company!, user))
    ),
  ],
];
