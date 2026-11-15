import type { Route } from "../app/http.ts";

/** better-auth itself. */
export const accountApiRoutes: readonly Route[] = [
  [
    "*",
    "/api/auth/*",
    async ({ app, request }) => {
      // A person whose email left the list keeps only sign-out, so no session of theirs reaches better-auth's routes.
      const session = await app.auth.api.getSession({
        headers: request.headers,
      });
      if (
        session &&
        !app.config.allowedEmails.includes(session.user.email.toLowerCase()) &&
        new URL(request.url).pathname !== "/api/auth/sign-out"
      ) {
        return Response.json({ error: "Not signed in" }, { status: 401 });
      }
      return app.auth.handler(request);
    },
  ],
];
