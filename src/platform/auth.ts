import type { Database } from "bun:sqlite";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer, organization } from "better-auth/plugins";

export interface AuthOptions {
  readonly database: Database;
  readonly secret: string;
  readonly baseUrl: string;
  readonly allowedEmails: readonly string[];
  readonly google: { readonly clientId: string; readonly clientSecret: string };
}

/** The address of Shadow's MCP server, which people's own agents use with an OAuth sign-in. */
export const mcpUrl = (baseUrl: string) => `${baseUrl}/mcp`;

/** The scopes that an MCP client asks for: who the person is, and a refresh token so it stays signed in. */
export const MCP_SCOPES = ["openid", "profile", "email", "offline_access"];

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Accounts and the company. The company is a better-auth organization; Shadow has one.
 * People sign in only with Google, and only with an allowed email; there is no other way to create an account.
 */
export function createAuth(options: AuthOptions) {
  const requireAllowed = (email: string | undefined) => {
    if (!(email && emailAllowed(options.allowedEmails, email))) {
      throw new APIError("FORBIDDEN", {
        code: "EMAIL_NOT_ALLOWED",
        message: "This Google account cannot sign in to Shadow.",
      });
    }
  };
  return betterAuth({
    database: options.database,
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: [options.baseUrl],
    socialProviders: {
      google: {
        clientId: options.google.clientId,
        clientSecret: options.google.clientSecret,
      },
    },
    // Accounts made with a password before Google sign-in have unverified emails; Google verifies the email.
    account: { accountLinking: { requireLocalEmailVerified: false } },
    onAPIError: { errorURL: `${options.baseUrl}/login` },
    plugins: [
      organization({
        // Shadow has one company, which only the server makes; deletes are soft, and better-auth's would remove rows.
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        // A company has admins and members; the person who starts it is its first admin.
        creatorRole: "admin",
        schema: {
          organization: {
            additionalFields: {
              deletedAt: { type: "number", required: false, input: false },
            },
          },
        },
      }),
      bearer(),
      // People's own agents, such as Claude Code or Codex, register themselves and sign in as the person.
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        scopes: MCP_SCOPES,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Native clients wait on a loopback address and do not always say that they are native.
        clientRegistrationDefaultApplicationType: "infer",
        resources: [mcpUrl(options.baseUrl)],
        clientRegistrationDefaultResources: [mcpUrl(options.baseUrl)],
        // Access tokens are opaque and checked on each call, so a token stops when its grant goes.
        disableJwtPlugin: true,
      }),
    ],
    databaseHooks: {
      user: { create: { before: async (user) => requireAllowed(user.email) } },
      // Also on every sign-in; `currentUser` checks the list on every request too.
      session: {
        create: {
          before: async (session) => {
            const user = options.database
              .query("SELECT email FROM user WHERE id = ?")
              .get(session.userId) as { email: string } | null;
            requireAllowed(user?.email);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Whether `allowed_emails` lets an email in: by the email itself, or by an entry `@domain` for every email there. */
export function emailAllowed(
  allowedEmails: readonly string[],
  email: string
): boolean {
  const address = email.toLowerCase();
  return allowedEmails.some((entry) =>
    entry.startsWith("@") ? address.endsWith(entry) : entry === address
  );
}

export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * The signed-in user of a request, from its session cookie or bearer token. A session whose email left
 * `allowedEmails` signs in nobody.
 */
export async function currentUser(
  auth: Auth,
  request: Request,
  allowedEmails: readonly string[]
): Promise<User | undefined> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!(session && emailAllowed(allowedEmails, session.user.email))) {
    return undefined;
  }
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}

/**
 * The person of an MCP request, from the OAuth access token that their own agent got when they signed in. A token of
 * an email that left `allowedEmails` signs in nobody. Session tokens do not count here.
 */
export async function oauthUser(
  auth: Auth,
  request: Request,
  allowedEmails: readonly string[]
): Promise<User | undefined> {
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
    return undefined;
  }
  const info = await auth.api
    .oauth2UserInfo({ headers: request.headers })
    .catch(() => null);
  const user =
    typeof info?.sub === "string"
      ? await (await auth.$context).internalAdapter.findUserById(info.sub)
      : null;
  if (!(user && emailAllowed(allowedEmails, user.email))) {
    return undefined;
  }
  return { id: user.id, name: user.name, email: user.email };
}
