import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** Private evidence and corrections use the same service as the agent tools. */
export const intakeApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/following/overview",
    api(async ({ app, params, user, request }) =>
      json(
        app.intake.following.overview(
          params.company!,
          user,
          new URL(request.url).searchParams.get("q") ?? ""
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/following/feedback",
    api(async ({ app, params, user, body }) => {
      if (
        !(typeof body.target === "string" && typeof body.quote === "string")
      ) {
        throw new HttpError(400, "Send target and quote");
      }
      return json(
        app.intake.following.feedback(
          params.company!,
          user,
          body.target,
          body.quote
        )
      );
    }),
  ],
  [
    "POST",
    "/api/v1/companies/:company/following/updates/:update",
    api(async ({ app, params, user, body }) => {
      if (!(body.action === "now" || body.action === "cancel")) {
        throw new HttpError(400, "Send action now or cancel");
      }
      return json(
        app.intake.following.changeUpdate(
          params.company!,
          user,
          params.update!,
          body.action
        )
      );
    }),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/following/updates/:update",
    api(async ({ app, params, user }) => {
      await app.intake.deleteUpdate(params.company!, user, params.update!);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/companies/:company/following/blocks/:block",
    api(async ({ app, params, user }) => {
      app.intake.following.unblock(params.company!, user, params.block!);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/following",
    api(async ({ app, params, user }) =>
      json({ checks: app.intake.following.list(params.company!, user) })
    ),
  ],
  [
    "GET",
    "/api/v1/companies/:company/following/:check",
    api(async ({ app, params, user }) =>
      json(app.intake.following.detail(params.company!, user, params.check!))
    ),
  ],
  [
    "POST",
    "/api/v1/companies/:company/following/:check",
    api(async ({ app, params, user, body }) => {
      if (
        !(
          typeof body.action === "string" &&
          ["handled", "stop", "reopen", "correct", "undo"].includes(
            body.action
          ) &&
          Number.isSafeInteger(body.revision) &&
          typeof body.quote === "string"
        )
      ) {
        throw new HttpError(400, "Send action, revision, and quote");
      }
      return json(
        await app.intake.following.change(
          params.company!,
          user,
          params.check!,
          {
            action: body.action as
              | "handled"
              | "stop"
              | "reopen"
              | "correct"
              | "undo",
            revision: body.revision as number,
            quote: body.quote,
          }
        )
      );
    }),
  ],

  [
    "GET",
    "/api/v1/companies/:company/intake",
    api(async ({ app, params, user, request }) =>
      json(
        app.intake.status(
          params.company!,
          user,
          new URL(request.url).searchParams.get("q") ?? ""
        )
      )
    ),
  ],
];
