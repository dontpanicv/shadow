import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** The inbox of a company. Opening a thread marks its notifications read. */
export const notificationApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/notifications",
    api(async ({ app, user, params }) =>
      json(app.notifications.inbox(params.company!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/notifications/read",
    api(async ({ app, user, params, body }) => {
      if (body.id !== undefined && typeof body.id !== "string") {
        throw new HttpError(400, "Id must be text");
      }
      return json(
        app.notifications.read(params.company!, user, body.id ?? null)
      );
    }),
  ],
];
