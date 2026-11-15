import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Route, RouteInput } from "../app/http.ts";
import { emailAllowed } from "../platform/auth.ts";

/**
 * better-auth itself, and the metadata of its OAuth server at the root, where MCP clients look for it: with the
 * issuer's path `/api/auth` after it (RFC 8414), and without it for clients that leave the path out.
 */
export const accountApiRoutes: readonly Route[] = [
  ["GET", "/.well-known/oauth-authorization-server", authServerMetadata],
  [
    "GET",
    "/.well-known/oauth-authorization-server/api/auth",
    authServerMetadata,
  ],
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
        !emailAllowed(app.config.allowedEmails, session.user.email) &&
        new URL(request.url).pathname !== "/api/auth/sign-out"
      ) {
        return Response.json({ error: "Not signed in" }, { status: 401 });
      }
      return app.auth.handler(request);
    },
  ],
];

function authServerMetadata({ app, request }: RouteInput): Promise<Response> {
  return oauthProviderAuthServerMetadata(app.auth)(request);
}
