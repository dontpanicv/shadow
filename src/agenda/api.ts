import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/**
 * Each person's agenda: what Shadow runs for them, what waits for them, and the automations Shadow suggests; and the
 * places that their iPhone watches for it, with its reports that they arrived or left.
 */
export const agendaApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/upcoming",
    api(async ({ app, user, params }) =>
      json(app.agenda.upcoming(params.company!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/suggestions/:suggestion",
    api(async ({ app, user, params, body }) => {
      if (typeof body.accept !== "boolean") {
        throw new HttpError(400, "Send accept as true or false");
      }
      await app.agenda.answer(
        params.company!,
        user,
        params.suggestion!,
        body.accept
      );
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/watched-places",
    api(async ({ app, user, params }) =>
      json({ places: app.agenda.watchPlaces(params.company!, user) })
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/watched-places/:place/reports",
    api(async ({ app, user, params, body }) => {
      app.agenda.reportPlace(params.company!, user, params.place!, body);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/reminders/:reminder",
    api(async ({ app, user, params }) => {
      app.agenda.cancelReminder(params.company!, user, params.reminder!);
      return new Response(null, { status: 204 });
    }),
  ],
];
