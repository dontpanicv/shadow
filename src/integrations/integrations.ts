import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Companies } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import type { OAuthClient } from "../platform/config.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import { integrationCatalog } from "./catalog.ts";
import { SIGN_IN_ADDRESS } from "./sign-in.ts";

export interface CredentialSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly label: string;
  /** The person who connected it, whose account it is; only they share, make private, or delete it. */
  readonly ownerId: string;
  readonly ownerName: string;
  /** Whether the turns of every member use it; else only the turns of its owner. */
  readonly shared: boolean;
  /** Whether its owner lets Shadow read it for them; see `Connector.watch`. */
  readonly watched: boolean;
}
export interface Integration {
  readonly credentials: readonly CredentialSummary[];
  readonly id: string;
  readonly name: string;
  /** How people connect it: with a secret, by signing in on its page, or by linking their phone number. */
  readonly connect: "secret" | "sign-in";
  /** The name of the secret, for `connect: "secret"`. */
  readonly secretLabel: string | null;
  /** Whether the person names a credential; else Shadow names it from the secret, such as by its Slack workspace. */
  readonly labeled: boolean;
  /** Whether a secret also needs the address of the person's own server, such as their T3 Code's. */
  readonly address: boolean;
  /** The name of the account that a secret also needs, such as `Email`, which names the credential; else `null`. */
  readonly username: string | null;
  /** The steps that set it up, in Markdown; empty when Connect is all. */
  readonly guide: readonly string[];
  /** Whether Shadow can find its owner's tasks in a credential of it, once they turn that on. */
  readonly watchable: boolean;
  /**
   * Shadow's own OAuth client, for an integration whose sign-in server does not register clients: its ID once an
   * admin set it, and whether this person may set it. `null` for the other integrations.
   */
  readonly client: {
    readonly clientId: string | null;
    readonly changeable: boolean;
  } | null;
}

/**
 * A tool of a connector, which agents call in threads and routine scripts call as `tools.<name>(args)`. It gets the
 * secret of the company's credential for its integration; the secret never reaches the agent or the script.
 */
export interface ConnectorTool<Parameters extends TSchema = TSchema> {
  /** Starts with the integration, such as `school_messages`. */
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters;
  /** Returns JSON: agents read it as text, and scripts get the value. */
  // biome-ignore lint/style/useConsistentMethodSignatures: a method keeps a tool with typed arguments a ConnectorTool.
  execute(
    args: Static<Parameters>,
    secret: string,
    signal: AbortSignal | undefined,
    file?: FileOf,
    allowed?: string,
    save?: SaveFile
  ): Promise<unknown>;
  /**
   * What a person allows before each call, such as `Send on Slack to #sales: The offer is ready`; `execute` then gets it as
   * `allowed`. A tool with it acts as the person, such as one that sends; it asks every time. `null` when this call
   * does not act as the person, such as an event that emails nobody.
   */
  // biome-ignore lint/style/useConsistentMethodSignatures: a method keeps a tool with typed arguments a ConnectorTool.
  approval?(
    args: Static<Parameters>,
    secret: string,
    signal: AbortSignal | undefined,
    file?: FileOf
  ): string | null | Promise<string | null>;
}

/** Finds a file of the company by its id, such as one to attach; it throws when there is none. */
export type FileOf = (
  fileId: string
) => Promise<{ readonly path: string; readonly name: string }>;

/**
 * Saves a file to the channel of the turn's thread: `write` writes it to the path it gets and returns its name. Gives
 * the file's id and name.
 */
export type SaveFile = (
  write: (path: string) => Promise<string>
) => Promise<{ readonly id: string; readonly name: string }>;

/**
 * An outside system that agents use: through the tools of its connector, with a secret from Settings, with a device
 * linked to a person's number, or with the access token of a sign-in, or through the tools of its MCP servers, after
 * someone signs in to them.
 */
export interface Connector {
  readonly id: string;
  readonly name: string;
  /** What agents do with it; the description of its codemode namespace. */
  readonly description: string;
  /** `null` for a sign-in. */
  readonly secretLabel: string | null;
  /**
   * Its secret also needs the address of the person's own server. The tools then get the secret as JSON
   * `{ address, secret }`. With `mcp`, the person signs in to the MCP servers at their paths on that address.
   */
  readonly address?: boolean;
  /**
   * Its secret also needs the person's account, such as the name of their account, under this name; the account
   * names the credential, and `secretFrom`, else the tools, get the secret as JSON `{ username, secret }`.
   */
  readonly username?: string;
  /** The steps that set it up, in Markdown, which Settings shows. */
  readonly guide?: readonly string[];
  readonly tools: readonly ConnectorTool[];
  /** The addresses of its MCP servers, which give the tools; one sign-in serves them all. */
  readonly mcp?: readonly string[];
  /**
   * The OAuth server that people sign in to, for a connector whose own tools call its API, such as Google's; the tools
   * then get a fresh access token instead of a secret.
   */
  readonly oauth?: string;
  /**
   * It signs in with Shadow's own OAuth client, which an admin sets in Settings, because its sign-in server
   * does not register clients. Only an admin sees it until then.
   */
  readonly registered?: boolean;
  /** The OAuth scopes that its sign-in asks for; else the ones that its server gives. */
  readonly scope?: string;
  /** More parameters of its sign-in page, such as Google's `access_type=offline` for a refresh token. */
  readonly authorizationParameters?: Readonly<Record<string, string>>;
  /** The tools of its MCP servers that agents never get, such as ones that end its sign-in. */
  readonly hiddenTools?: readonly string[];
  /** The only tools of its MCP servers that agents get, when the others serve only the server's own agents. */
  readonly shownTools?: readonly string[];
  /**
   * Makes the secret that Shadow keeps, and its label, from what the person pastes, such as a cURL command of Slack's
   * web app; it throws when that does not work. Without it, Shadow keeps the pasted secret, and the person names it.
   */
  readonly secretFrom?: (
    input: string
  ) => Promise<{ readonly secret: string; readonly label: string }>;
  /**
   * Reads what an account got and sent since a time, for its owner, once they turn that on for the credential
   * (`watched`). Only the `intake` module calls it, never an agent.
   */
  readonly watch?: (source: WatchSource) => Promise<WatchedItem[]>;
  /** Extracts source evidence from successful read tools; never drafts or other writes. */
  readonly observations?: (
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
    source: Pick<WatchSource, "account" | "secret">
  ) => Promise<WatchedItem[]>;
  /** The bytes of an attachment of a watched item, by the ids that `watch` gave. */
  readonly attachment?: (
    source: WatchSource,
    itemId: string,
    attachmentId: string
  ) => Promise<Uint8Array>;
}

/** What a watch reads with: the time to read from, and the credential's secret or its MCP server. */
export interface WatchSource {
  /** Read what came or went at this time or later, in milliseconds. */
  readonly since: number;
  readonly record?: (stage: string, data: unknown) => void;
  readonly checkpoint?: { value: unknown; save: (value: unknown) => void };
  /** The credential's label, such as the address of a Google account. */
  readonly account: string;
  /** Whether Shadow already has an item, so a watch does not fetch it again. */
  readonly seen: (id: string) => boolean;
  /** What the connector's own tools get as the secret: a device's store, a fresh access token, or the secret. */
  readonly secret: () => Promise<string>;
  /** Calls a tool of the connector's MCP server by its own name, and gives its structured content, else its text. */
  readonly call: (
    tool: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

/** A message or a document that a watched account got or sent, which Shadow reads for its owner. */
export interface WatchedItem {
  /** Unique within the credential and stable, such as the id of a Gmail message. */
  readonly id: string;
  /** One message of a chat or a mail thread, or a whole text, such as the summary of a recorded meeting. */
  readonly kind: "message" | "document";
  /** The conversation it belongs to, such as a mail thread or a chat; the earlier messages of a chat are context. */
  readonly chat: string;
  readonly chatName: string;
  /** Whether more than two people write in the chat. */
  readonly group: boolean;
  readonly sender: string;
  /** Whether the owner of the account wrote it. */
  readonly fromOwner: boolean;
  /** When it was written or recorded, in milliseconds. */
  readonly at: number;
  /** The read time when the source gives no original time. It cannot start a response period. */
  readonly observedAt?: number;
  /** Its text, with "@me" where the source mentions the owner by an id or a number. */
  readonly text: string;
  /** Where its person opens it, such as the mail in Gmail; null when it has no address. */
  readonly url: string | null;
  /**
   * Whether it came to many people or from an automatic sender. This is source metadata, not a reason to skip
   * reading: a ticket or an automatic notice can be useful.
   */
  readonly bulk?: boolean;
  readonly attachments?: readonly WatchedAttachment[];
}

/** A file attached to a watched item, which `Connector.attachment` gives by its id. */
export interface WatchedAttachment {
  readonly id: string;
  readonly name: string;
  /** Its media type, such as `application/pdf`. */
  readonly type: string;
  readonly size: number;
}

/** A credential whose owner lets Shadow read it for them. */
export interface WatchedCredential {
  readonly id: string;
  readonly companyId: string;
  readonly integration: string;
  readonly integrationName: string;
  readonly ownerId: string;
  readonly label: string;
}

/** The turn a tool call is part of: the person it is for, whose own credentials come first, also private ones. */
export interface Turn {
  readonly userId: string | null;
  /** Receives evidence extracted by the connector from its actual read result. */
  readonly observe?: (read: SourceRead) => void | Promise<void>;
  readonly signal?: AbortSignal;
  /** The files that its tools can take, such as attachments; a routine has none. */
  readonly file?: FileOf;
  /** Saves a file that a tool brings, such as a picture of a message; a routine has none. */
  readonly save?: SaveFile;
  /**
   * Resolves when the person allows the action of `text`, and throws when they do not; `approverId` null lets any
   * member answer. Only an agent in a thread can ask, so a routine's script cannot act as a person.
   */
  readonly approve?: (text: string, approverId: string | null) => Promise<void>;
}

export interface SourceRead {
  readonly credential: WatchedCredential;
  readonly tool: string;
  readonly result: unknown;
  readonly items: readonly WatchedItem[];
}

/** A connector tool of one company; each call uses the credential of the turn it is part of. */
export interface CompanyTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  /** The value that `execute` returns, when the tool declares it. */
  readonly outputSchema?: TSchema;
  readonly execute: (args: unknown, turn: Turn) => Promise<unknown>;
}

/** A codemode namespace of a connector's tools, which all start with `<id>_`. */
export interface ConnectorNamespace {
  readonly name: string;
  readonly prefix: string;
  readonly description: string;
}

export interface IntegrationsOptions {
  /** Called when the connector tools of a company may change: a credential there changed. */
  readonly changed?: (companyId: string) => void;
  readonly catalog?: readonly Connector[];
  /** Connects to an MCP server; tests pass an in-memory one. */
  readonly transport?: (url: URL, provider: OAuthClientProvider) => Transport;
}

/**
 * What a credential of a sign-in keeps, encrypted: the address of the person's own server for a connector with
 * `address`, its OAuth client, and its tokens once someone signed in.
 */
interface McpGrant {
  address?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/** A sign-in that someone started on a sign-in page. */
interface PendingSignIn {
  readonly provider: GrantProvider;
  readonly companyId: string;
  readonly user: User;
  readonly connector: Connector;
  readonly expiresAt: number;
}

/** The live credential `?1` of the person `?3` in the company `?2`. */
const OWN_CREDENTIAL =
  "id = ?1 AND company_id = ?2 AND owner_id = ?3 AND deleted_at IS NULL";
const SIGN_IN_MS = 10 * 60 * 1000;

/**
 * The outside systems that agents use. A person connects an integration in their Settings, in the company, and each
 * credential is private, for their own turns, until they share it with the turns of every member. Each credential is
 * an account, such as a Google address: a turn uses the account that a tool call names, else the newest of the person
 * it is for, else the newest shared one. Only its owner shares or deletes a credential. Secrets never leave the server.
 */
export class Integrations {
  private readonly catalog: readonly Connector[];
  /** The sign-ins in progress, by their OAuth `state`. */
  private readonly signIns = new Map<string, PendingSignIn>();
  /** One MCP client for each credential and server, by `<credential id> <server>`, connected at first use. */
  private readonly clients = new Map<string, Promise<Client>>();
  /** The access token of each credential of an `oauth` connector, until shortly before it expires. */
  private readonly accessTokens = new Map<
    string,
    Promise<{ token: string; expiresAt: number }>
  >();

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly companies: Companies,
    private readonly options: IntegrationsOptions
  ) {
    this.catalog = options.catalog ?? integrationCatalog();
  }

  /** The integrations, with the credentials that the person sees in the company: the shared ones and their own. */
  list(companyId: string, user: User): Integration[] {
    this.companies.requireMember(companyId, user);
    const credentials = this.summaries(
      "c.company_id = ?1 AND (c.shared = 1 OR c.owner_id = ?2)",
      companyId,
      user.id
    );
    const admin = this.companies.isAdmin(user);
    return this.catalog.flatMap((connector) => {
      const clientId = connector.registered
        ? (this.oauthClient(connector.id)?.clientId ?? null)
        : null;
      if (connector.registered && !(clientId || admin)) {
        return [];
      }
      return {
        id: connector.id,
        name: connector.name,
        connect: connectionOf(connector),
        secretLabel: connector.secretLabel,
        labeled: !(connector.secretFrom || connector.username),
        address: connector.address ?? false,
        username: connector.username ?? null,
        guide: connector.guide ?? [],
        watchable: connector.watch !== undefined,
        client: connector.registered ? { clientId, changeable: admin } : null,
        credentials: credentials
          .filter((credential) => credential.integration === connector.id)
          .map(({ integration: _, ...credential }) => credential),
      };
    });
  }

  private summaries(
    where: string,
    ...params: string[]
  ): (CredentialSummary & { integration: string })[] {
    const rows = this.database
      .query(
        `SELECT c.id, c.integration, c.label, c.owner_id AS ownerId, u.name AS ownerName, c.shared, c.watched, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE ${where} AND c.deleted_at IS NULL ORDER BY c.created_at`
      )
      .all(...params) as (Omit<CredentialSummary, "shared" | "watched"> & {
      integration: string;
      shared: number;
      watched: number;
    })[];
    return rows.map((row) => ({
      ...row,
      shared: row.shared === 1,
      watched: row.watched === 1,
    }));
  }

  /**
   * Sets Shadow's own OAuth client of an integration whose sign-in server does not register clients; only an admin
   * does. The next sign-in uses it; the sign-ins before keep the client they signed in with.
   */
  async setClient(
    user: User,
    integrationId: string,
    client: OAuthClient
  ): Promise<void> {
    if (!this.companies.isAdmin(user)) {
      throw new HttpError(403, "Only an admin sets the client");
    }
    const connector = this.connector(integrationId);
    if (!connector.registered) {
      throw notFound();
    }
    this.database
      .query(
        "INSERT INTO oauth_client (integration, client_id, secret, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (integration) DO UPDATE SET client_id = ?2, secret = ?3, changed_by = ?4, changed_at = ?5"
      )
      .run(
        integrationId,
        required(client.clientId, "Client ID").trim(),
        this.secrets.encrypt(
          required(client.clientSecret, "Client secret").trim()
        ),
        user.id,
        Date.now()
      );
  }

  async addCredential(
    companyId: string,
    user: User,
    integrationId: string,
    input: {
      label?: string;
      secret: string;
      address?: string;
      username?: string;
    }
  ): Promise<CredentialSummary> {
    this.companies.requireMember(companyId, user);
    const connector = this.connector(integrationId);
    if (connectionOf(connector) !== "secret") {
      throw new HttpError(400, "Connect it by signing in");
    }
    const pasted = required(input.secret, "Secret");
    const username = connector.username
      ? required(input.username?.trim(), connector.username)
      : undefined;
    const secret = username
      ? JSON.stringify({ username, secret: pasted })
      : pasted;
    if (connector.secretFrom) {
      const made = await connector.secretFrom(secret).catch((error: Error) => {
        throw new HttpError(400, error.message, { cause: error });
      });
      return this.insertCredential(
        companyId,
        user,
        integrationId,
        made.label,
        made.secret
      );
    }
    return this.insertCredential(
      companyId,
      user,
      integrationId,
      username ?? required(input.label, "Label"),
      connector.address
        ? JSON.stringify({ address: serverAddress(input.address), secret })
        : secret
    );
  }

  /**
   * Starts a sign-in: registers Shadow with the sign-in server, at `address` for a connector with `address`, unless
   * Shadow has its own client, and returns the page where the person signs in, which ends at an address that the person
   * gives to `finishConnect`.
   */
  async connect(
    companyId: string,
    user: User,
    integrationId: string,
    input: { address?: string } = {}
  ): Promise<{ url: string }> {
    this.companies.requireMember(companyId, user);
    const connector = this.connector(integrationId);
    const now = Date.now();
    for (const [state, pending] of this.signIns) {
      if (pending.expiresAt < now) {
        this.signIns.delete(state);
      }
    }
    if (connectionOf(connector) !== "sign-in") {
      throw notFound();
    }
    const state = randomUUID();
    const client = connector.registered
      ? this.oauthClient(connector.id)
      : undefined;
    if (connector.registered && !client) {
      throw new HttpError(
        400,
        `An admin has not set the client of ${connector.name}`
      );
    }
    const provider = new GrantProvider(
      {
        ...(connector.address ? { address: serverAddress(input.address) } : {}),
        ...(client
          ? {
              client: {
                client_id: client.clientId,
                client_secret: client.clientSecret,
              },
            }
          : {}),
      },
      connector,
      state
    );
    await signIn(connector, provider);
    if (!provider.authorizationUrl) {
      throw new HttpError(502, `${connector.name} gave no sign-in page`);
    }
    this.signIns.set(state, {
      provider,
      companyId,
      user,
      connector,
      expiresAt: now + SIGN_IN_MS,
    });
    return { url: provider.authorizationUrl.href };
  }

  /**
   * Ends the person's own sign-in in the company where it started, and keeps it as a private credential. A sign-in ends with the
   * address where its page ended, and works once.
   */
  async finishConnect(
    companyId: string,
    user: User,
    integrationId: string,
    address?: string
  ): Promise<CredentialSummary> {
    this.companies.requireMember(companyId, user);
    const query = URL.parse(required(address, "Address"))?.searchParams;
    const state = query?.get("state") ?? "";
    const pending = this.signIns.get(state);
    if (!(pending && this.isOwn(pending, companyId, user, integrationId))) {
      throw new HttpError(400, "This is not the address of your sign-in");
    }
    this.signIns.delete(state);
    const code = query?.get("code");
    if (!code) {
      throw new HttpError(400, "The sign-in did not finish");
    }
    const { provider, connector } = pending;
    await signIn(connector, provider, code);
    return this.insertCredential(
      companyId,
      user,
      connector.id,
      emailOf(provider.grant.tokens?.id_token) ??
        (provider.grant.address
          ? new URL(provider.grant.address).host
          : connector.name),
      JSON.stringify(provider.grant)
    );
  }

  private isOwn(
    pending: PendingSignIn,
    companyId: string,
    user: User,
    integrationId: string
  ): boolean {
    return (
      pending.companyId === companyId &&
      pending.user.id === user.id &&
      pending.connector.id === integrationId &&
      pending.expiresAt >= Date.now()
    );
  }

  private insertCredential(
    companyId: string,
    user: User,
    integrationId: string,
    label: string,
    secret: string,
    id: string = randomUUID()
  ): CredentialSummary {
    const credential = {
      id,
      label,
      ownerId: user.id,
      ownerName: user.name,
      shared: false,
      watched: false,
      createdAt: Date.now(),
    };
    this.database
      .query(
        "INSERT INTO credential (id, company_id, integration, owner_id, label, shared, secret, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
      )
      .run(
        credential.id,
        companyId,
        integrationId,
        user.id,
        label,
        this.secrets.encrypt(secret),
        credential.createdAt
      );
    this.options.changed?.(companyId);
    return credential;
  }

  /** Shares the person's credential with the turns of every member, or makes it private to their own turns again. */
  setShared(
    companyId: string,
    user: User,
    credentialId: string,
    shared: boolean
  ): CredentialSummary {
    this.companies.requireMember(companyId, user);
    const { changes } = this.database
      .query(`UPDATE credential SET shared = ?4 WHERE ${OWN_CREDENTIAL}`)
      .run(credentialId, companyId, user.id, shared ? 1 : 0);
    if (changes === 0) {
      throw notFound();
    }
    this.options.changed?.(companyId);
    const { integration: _, ...credential } = this.summaries(
      "c.id = ?",
      credentialId
    )[0]!;
    return credential;
  }

  /**
   * Lets Shadow read the person's own credential for them, or stops it. Only the owner does, also for a shared
   * credential: what Shadow finds is always theirs, and goes only where they can see it.
   */
  setWatched(
    companyId: string,
    user: User,
    credentialId: string,
    watched: boolean
  ): CredentialSummary {
    this.companies.requireMember(companyId, user);
    const row = this.database
      .query(`SELECT integration FROM credential WHERE ${OWN_CREDENTIAL}`)
      .get(credentialId, companyId, user.id) as {
      integration: string;
    } | null;
    if (!row) {
      throw notFound();
    }
    if (watched && !this.connector(row.integration).watch) {
      throw new HttpError(400, "Shadow cannot read this integration for you");
    }
    this.database
      .query("UPDATE credential SET watched = ? WHERE id = ?")
      .run(watched ? 1 : 0, credentialId);
    const { integration: _, ...credential } = this.summaries(
      "c.id = ?",
      credentialId
    )[0]!;
    return credential;
  }

  /** The credentials whose owners let Shadow find their tasks in them, of every company. */
  watched(): WatchedCredential[] {
    const rows = this.database
      .query(
        "SELECT id, company_id AS companyId, integration, owner_id AS ownerId, label FROM credential WHERE watched = 1 AND deleted_at IS NULL ORDER BY created_at"
      )
      .all() as Omit<WatchedCredential, "integrationName">[];
    return rows.flatMap((row) => {
      const connector = this.catalog.find(({ id }) => id === row.integration);
      return connector?.watch
        ? [{ ...row, integrationName: connector.name }]
        : [];
    });
  }

  /** Reads what a watched credential got and sent since `since`; it throws when the credential is not watched. */
  async watch(
    credentialId: string,
    since: number,
    seen: (id: string) => boolean,
    signal?: AbortSignal,
    record?: (stage: string, data: unknown) => void,
    checkpoint?: WatchSource["checkpoint"]
  ): Promise<WatchedItem[]> {
    const { connector, source } = this.watchSource(
      credentialId,
      since,
      seen,
      signal
    );
    return await connector.watch!({ ...source, record, checkpoint });
  }

  /** The bytes of an attachment of an item that a watched credential got. */
  async attachment(
    credentialId: string,
    itemId: string,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const { connector, source } = this.watchSource(
      credentialId,
      0,
      () => false,
      signal
    );
    if (!connector.attachment) {
      throw new Error(`${connector.name} has no attachments`);
    }
    return await connector.attachment(source, itemId, attachmentId);
  }

  private watchSource(
    credentialId: string,
    since: number,
    seen: (id: string) => boolean,
    signal?: AbortSignal
  ): { connector: Connector; source: WatchSource } {
    const row = this.database
      .query(
        "SELECT integration, label FROM credential WHERE id = ? AND watched = 1 AND deleted_at IS NULL"
      )
      .get(credentialId) as { integration: string; label: string } | null;
    const connector = this.catalog.find(({ id }) => id === row?.integration);
    if (!connector?.watch) {
      throw new Error("Shadow does not watch this credential");
    }
    const credential = this.liveCredential(credentialId);
    return {
      connector,
      source: {
        since,
        account: row!.label,
        seen,
        secret: () => this.secretOf(connector, credential),
        call: (tool, args) =>
          // A connector that watches through MCP has one server.
          this.callMcp(
            credential,
            connector,
            connector.mcp![0]!,
            tool,
            args,
            signal
          ),
        ...(signal ? { signal } : {}),
      },
    };
  }

  /** Deletes the person's credential. */
  deleteCredential(companyId: string, user: User, credentialId: string): void {
    this.companies.requireMember(companyId, user);
    const row = this.database
      .query(`SELECT integration FROM credential WHERE ${OWN_CREDENTIAL}`)
      .get(credentialId, companyId, user.id) as {
      integration: string;
    } | null;
    if (!row) {
      throw notFound();
    }
    // Nothing is removed: the credential stays encrypted, and no tool reads it again.
    this.database
      .query("UPDATE credential SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), credentialId);
    this.closeClient(credentialId);
    this.accessTokens.delete(credentialId);
    this.options.changed?.(companyId);
  }

  /**
   * The tools of every connector for the agents and routines of a company: of each connector that someone connected
   * there, with `<id>_accounts`, which lists the accounts that a turn can name.
   */
  async tools(companyId: string): Promise<CompanyTool[]> {
    const tools = await Promise.all(
      this.catalog.map(async (connector) => {
        const own: AccountTool[] = connector.mcp
          ? await this.mcpTools(companyId, connector)
          : connector.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              ...(tool.approval
                ? {
                    approval: async (args, credential, signal, file) =>
                      tool.approval!(
                        args as never,
                        await this.secretOf(connector, credential),
                        signal,
                        file
                      ),
                  }
                : {}),
              call: async (args, credential, signal, file, allowed, save) =>
                tool.execute(
                  args as never,
                  await this.secretOf(connector, credential),
                  signal,
                  file,
                  allowed,
                  save
                ),
            }));
        if (own.length === 0) {
          return [];
        }
        return [
          ...own.map((tool) => this.companyTool(companyId, connector, tool)),
          this.accountsTool(companyId, connector),
        ];
      })
    );
    return tools.flat();
  }

  /** What a connector's own tool gets of a credential: a fresh access token of a sign-in, else the secret. */
  private async secretOf(
    connector: Connector,
    credential: Credential
  ): Promise<string> {
    return connector.oauth
      ? (await this.accessToken(connector, credential)).token
      : credential.secret;
  }

  /** A credential that nobody deleted; a keeper that still runs for a deleted one gets an error. */
  private liveCredential(credentialId: string): Credential {
    const row = this.database
      .query(
        "SELECT id, owner_id, secret FROM credential WHERE id = ? AND deleted_at IS NULL"
      )
      .get(credentialId) as {
      id: string;
      owner_id: string;
      secret: Uint8Array;
    } | null;
    if (!row) {
      throw new Error("The credential was deleted");
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      secret: this.secrets.decrypt(row.secret),
    };
  }

  /**
   * The access token of a credential of an `oauth` connector, from the cache until a minute before it expires; else
   * the refresh token gets a new one, and the new grant replaces the stored one.
   */
  private accessToken(
    connector: Connector,
    credential: Credential
  ): Promise<{ token: string; expiresAt: number }> {
    const cached = this.accessTokens.get(credential.id);
    if (cached) {
      return cached.then((access) =>
        access.expiresAt > Date.now()
          ? access
          : this.refreshedToken(connector, credential)
      );
    }
    return this.refreshedToken(connector, credential);
  }

  private refreshedToken(
    connector: Connector,
    credential: Credential
  ): Promise<{ token: string; expiresAt: number }> {
    const provider = new GrantProvider(
      JSON.parse(credential.secret),
      connector,
      undefined,
      (grant) => this.saveGrant(credential.id, grant)
    );
    const refreshing = signIn(connector, provider).then(() => {
      const { tokens } = provider.grant;
      // A refresh that failed leaves the SDK wanting a new sign-in.
      if (provider.authorizationUrl || !tokens) {
        throw new Error(
          `${connector.name} ended the sign-in. Connect it again in Settings.`
        );
      }
      return {
        token: tokens.access_token,
        expiresAt: Date.now() + ((tokens.expires_in ?? 0) - 60) * 1000,
      };
    });
    refreshing.catch(() => this.accessTokens.delete(credential.id));
    this.accessTokens.set(credential.id, refreshing);
    return refreshing;
  }

  private saveGrant(credentialId: string, grant: McpGrant): void {
    this.database
      .query("UPDATE credential SET secret = ? WHERE id = ?")
      .run(this.secrets.encrypt(JSON.stringify(grant)), credentialId);
  }

  /** The codemode namespace of each connector. */
  namespaces(): ConnectorNamespace[] {
    return this.catalog.map((connector) => ({
      name: connector.id,
      prefix: `${connector.id}_`,
      description: connector.description,
    }));
  }

  /** Closes the connections to MCP servers. */
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      clients.map(async (client) => (await client).close())
    );
  }

  /** A connector's tool whose calls use the account they name, else the turn's newest; see `credentialFor`. */
  private companyTool(
    companyId: string,
    connector: Connector,
    tool: AccountTool
  ): CompanyTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        ...tool.parameters,
        properties: {
          ...(tool.parameters as { properties?: object }).properties,
          account: Type.String({
            description: `The ${connector.name} account, from ${connector.id}_accounts; the first one when not given.`,
          }),
        },
      },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      execute: async (args, turn) => {
        const { account, ...rest } = args as { account?: string };
        const credential = this.credentialFor(
          companyId,
          connector,
          turn.userId,
          account
        );
        const allowed = tool.approval
          ? await tool.approval(rest, credential, turn.signal, turn.file)
          : null;
        if (allowed !== null) {
          if (!turn.approve) {
            throw new Error(
              `Only an agent in a thread can use ${tool.name}, after a person allows it.`
            );
          }
          await turn.approve(
            allowed,
            this.approverOf(companyId, credential, turn.userId)
          );
        }
        const result = await tool.call(
          rest,
          credential,
          turn.signal,
          turn.file,
          allowed ?? undefined,
          turn.save
        );
        await this.observeRead(
          connector,
          credential,
          { tool: tool.name, args: rest, result },
          turn
        );
        return result;
      },
    };
  }

  private async observeRead(
    connector: Connector,
    credential: Credential,
    read: { tool: string; args: Record<string, unknown>; result: unknown },
    turn: Turn
  ): Promise<void> {
    if (
      !(turn.observe && connector.observations) ||
      credential.ownerId !== turn.userId
    ) {
      return;
    }
    const watched = this.watched().find((each) => each.id === credential.id);
    if (!watched) {
      return;
    }
    const items = await connector.observations(
      read.tool,
      read.args,
      read.result,
      {
        account: watched.label,
        secret: () => this.secretOf(connector, credential),
      }
    );
    if (items.length) {
      await turn.observe({
        credential: watched,
        tool: read.tool,
        result: read.result,
        items,
      });
    }
  }

  private accountsTool(companyId: string, connector: Connector): CompanyTool {
    return {
      name: `${connector.id}_accounts`,
      description: `The ${connector.name} accounts that the other ${connector.id}_ tools can use for this person, by \`account\`: their own first, newest first, then the ones that other members shared.`,
      parameters: Type.Object({}),
      execute: async (_args, turn) => {
        const person = this.turnPerson(companyId, turn.userId);
        return this.credentialRows(companyId, connector, person).map((row) => ({
          account: row.label,
          of: row.owner_id === person ? "own" : "shared",
        }));
      },
    };
  }

  /**
   * The tools of a connector's MCP servers, named `<id>_<tool>`, as the newest shared sign-in lists them, else the
   * newest private one; the list has only names and schemas, and no tool call uses that sign-in for another person.
   * None of a server without a sign-in, or when it fails, so one shop that is down does not stop the agents.
   */
  private async mcpTools(
    companyId: string,
    connector: Connector
  ): Promise<AccountTool[]> {
    const row = this.database
      .query(
        "SELECT id, label, owner_id, secret FROM credential WHERE integration = ? AND company_id = ? AND deleted_at IS NULL ORDER BY shared DESC, created_at DESC, rowid DESC LIMIT 1"
      )
      .get(connector.id, companyId) as CredentialRow | null;
    if (!row) {
      return [];
    }
    const lister = {
      id: row.id,
      ownerId: row.owner_id,
      secret: this.secrets.decrypt(row.secret),
    };
    const prefix = `${connector.id}_`;
    const servers = await Promise.all(
      connector.mcp!.map(async (server) => {
        try {
          const listed: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
          let cursor: string | undefined;
          do {
            const page = await this.withClient(
              lister,
              connector,
              server,
              (client) => client.listTools(cursor ? { cursor } : undefined)
            );
            listed.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
          return listed
            .filter((tool) =>
              connector.shownTools
                ? connector.shownTools.includes(tool.name)
                : !connector.hiddenTools?.includes(tool.name)
            )
            .map(
              (tool): AccountTool => ({
                name: agentToolName(prefix, tool.name),
                description: tool.description ?? "",
                parameters: tool.inputSchema as TSchema,
                ...(tool.outputSchema
                  ? { outputSchema: tool.outputSchema as TSchema }
                  : {}),
                call: (args, credential, signal) =>
                  this.callMcp(
                    credential,
                    connector,
                    server,
                    tool.name,
                    args as Record<string, unknown>,
                    signal
                  ),
              })
            );
        } catch (error) {
          console.error(`listing the tools of ${server} failed`, error);
          return [];
        }
      })
    );
    return servers.flat();
  }

  /** Calls a tool of an MCP server with a credential, and gives its structured content, else its text. */
  private async callMcp(
    credential: Credential,
    connector: Connector,
    server: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const result = await this.withClient(
      credential,
      connector,
      server,
      (client) =>
        client.callTool({ name, arguments: args }, undefined, { signal })
    );
    const text = (result.content as { type: string; text?: string }[])
      .flatMap((item) => (item.type === "text" ? [item.text ?? ""] : []))
      .join("\n");
    if (result.isError) {
      throw new Error(text || `${connector.name} failed`);
    }
    return result.structuredContent ?? text;
  }

  /**
   * Runs `use` with the credential's MCP client of a server. A server that forgot the client's session answers 404
   * before it runs anything, so the call runs once more on a new session.
   */
  private async withClient<Result>(
    credential: Credential,
    connector: Connector,
    server: string,
    use: (client: Client) => Promise<Result>
  ): Promise<Result> {
    try {
      return await use(await this.client(credential, connector, server));
    } catch (error) {
      if (!(error instanceof StreamableHTTPError && error.code === 404)) {
        throw error;
      }
      this.closeClient(credential.id, server);
      return use(await this.client(credential, connector, server));
    }
  }

  private client(
    credential: Credential,
    connector: Connector,
    server: string
  ): Promise<Client> {
    const key = `${credential.id} ${server}`;
    let client = this.clients.get(key);
    if (!client) {
      // The SDK refreshes the tokens; each new grant replaces the stored one.
      const grant = JSON.parse(credential.secret) as McpGrant;
      const provider = new GrantProvider(grant, connector, undefined, (saved) =>
        this.saveGrant(credential.id, saved)
      );
      // A connector with `address` has the server's path on the person's own server.
      const url = new URL(server, grant.address);
      const transport =
        this.options.transport?.(url, provider) ??
        new StreamableHTTPClientTransport(url, { authProvider: provider });
      const connecting = new Client({ name: "Shadow", version: "1" });
      client = connecting.connect(transport).then(() => connecting);
      client.catch(() => this.clients.delete(key));
      this.clients.set(key, client);
    }
    return client;
  }

  /** Closes the credential's MCP clients: of one server, or of all. */
  private closeClient(credentialId: string, server?: string): void {
    for (const [key, client] of this.clients) {
      if (
        server
          ? key === `${credentialId} ${server}`
          : key.startsWith(`${credentialId} `)
      ) {
        this.clients.delete(key);
        client.then((connected) => connected.close()).catch(() => undefined);
      }
    }
  }

  /**
   * The credential that a turn of `userId` in a company uses for a connector: the one named `account`, else the
   * person's newest, else the newest shared one.
   */
  private credentialFor(
    companyId: string,
    connector: Connector,
    userId: string | null,
    account: string | undefined
  ): Credential {
    const rows = this.credentialRows(
      companyId,
      connector,
      this.turnPerson(companyId, userId)
    );
    if (rows.length === 0) {
      throw new Error(
        `${connector.name} is not connected. Connect it in Settings, and share it for the turns of every member.`
      );
    }
    const row = account
      ? rows.find(
          (candidate) => candidate.label.toLowerCase() === account.toLowerCase()
        )
      : rows[0];
    if (!row) {
      throw new Error(
        `${connector.name} has no account ${account}; it has ${rows.map((candidate) => candidate.label).join(", ")}.`
      );
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      secret: this.secrets.decrypt(row.secret),
    };
  }

  /**
   * Who allows a call that acts with a credential: its owner, whom the call acts as, while a member; else the turn's
   * person. The owner of a shared credential allows it for another person's turn, as for a machine.
   */
  private approverOf(
    companyId: string,
    credential: Credential,
    userId: string | null
  ): string | null {
    return this.memberIds(companyId).includes(credential.ownerId)
      ? credential.ownerId
      : userId;
  }

  /** The credentials of a connector that a turn of `person` uses: their own, newest first, then the shared ones. */
  private credentialRows(
    companyId: string,
    connector: Connector,
    person: string | null
  ): CredentialRow[] {
    return this.database
      .query(
        "SELECT id, label, owner_id, secret FROM credential WHERE integration = ?1 AND company_id = ?2 AND deleted_at IS NULL AND (shared = 1 OR owner_id = ?3) ORDER BY owner_id IS NOT ?3, created_at DESC, rowid DESC"
      )
      .all(connector.id, companyId, person) as CredentialRow[];
  }

  /** The person of a turn, when they are a member of its company. */
  private turnPerson(companyId: string, userId: string | null): string | null {
    return userId && this.memberIds(companyId).includes(userId) ? userId : null;
  }

  private memberIds(companyId: string): string[] {
    return this.companies
      .members(companyId, this.companies.agentMember(companyId))
      .map((member) => member.userId);
  }

  private oauthClient(integrationId: string): OAuthClient | undefined {
    const row = this.database
      .query("SELECT client_id, secret FROM oauth_client WHERE integration = ?")
      .get(integrationId) as { client_id: string; secret: Uint8Array } | null;
    return row
      ? {
          clientId: row.client_id,
          clientSecret: this.secrets.decrypt(row.secret),
        }
      : undefined;
  }

  private connector(integrationId: string): Connector {
    const connector = this.catalog.find(
      (candidate) => candidate.id === integrationId
    );
    if (!connector) {
      throw notFound();
    }
    return connector;
  }
}

/** A credential as a tool call uses it: its id, its owner, and its decrypted secret. */
interface Credential {
  readonly id: string;
  readonly ownerId: string;
  readonly secret: string;
}

interface CredentialRow {
  readonly id: string;
  readonly label: string;
  readonly owner_id: string;
  readonly secret: Uint8Array;
}

/** A connector's tool before it gets its `account`: it runs with the credential that the call chose. */
interface AccountTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly outputSchema?: TSchema;
  readonly approval?: (
    args: unknown,
    credential: Credential,
    signal: AbortSignal | undefined,
    file?: FileOf
  ) => Promise<string | null>;
  readonly call: (
    args: unknown,
    credential: Credential,
    signal: AbortSignal | undefined,
    file?: FileOf,
    allowed?: string,
    save?: SaveFile
  ) => Promise<unknown>;
}

function connectionOf(connector: Connector): Integration["connect"] {
  return connector.mcp || connector.oauth ? "sign-in" : "secret";
}

/** The email address in an OpenID token, which names the account of a sign-in, such as a Google one. */
function emailOf(idToken: string | undefined): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString()
    ) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the MCP SDK's sign-in step, which refreshes the tokens when the grant has a refresh token; a refusal of the
 * sign-in server reaches the person with its reason.
 */
async function signIn(
  connector: Connector,
  provider: GrantProvider,
  authorizationCode?: string
): Promise<void> {
  try {
    await auth(provider, {
      // Without the metadata of a protected resource, the SDK takes this as the sign-in server.
      serverUrl:
        connector.oauth ?? new URL(connector.mcp![0]!, provider.grant.address),
      ...(connector.scope ? { scope: connector.scope } : {}),
      ...(authorizationCode ? { authorizationCode } : {}),
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: HttpError takes the cause as its third argument.
    throw new HttpError(
      502,
      `${connector.name} refused the sign-in: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/** The OAuth state of one grant, as the MCP SDK reads and writes it: the client, the tokens, and PKCE. */
class GrantProvider implements OAuthClientProvider {
  /** The sign-in page, once the SDK wants the person to sign in. */
  authorizationUrl: URL | undefined;
  private verifier = "";

  constructor(
    readonly grant: McpGrant,
    private readonly connector: Connector,
    private readonly signInState?: string,
    private readonly saved: (grant: McpGrant) => void = () => undefined
  ) {}

  get redirectUrl() {
    return SIGN_IN_ADDRESS;
  }

  get clientMetadata() {
    return {
      client_name: "Shadow",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.signInState ?? randomUUID();
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.grant.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.grant.client = client;
  }

  tokens(): OAuthTokens | undefined {
    return this.grant.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.grant.tokens = tokens;
    this.saved(this.grant);
  }

  redirectToAuthorization(url: URL): void {
    for (const [name, value] of Object.entries(
      this.connector.authorizationParameters ?? {}
    )) {
      url.searchParams.set(name, value);
    }
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

/** The address of a person's own server, such as `http://my-mac:3774`. */
function serverAddress(address: string | undefined): string {
  const url = URL.parse(required(address, "Address"));
  if (!(url && (url.protocol === "http:" || url.protocol === "https:"))) {
    throw new HttpError(400, "Address must start with http:// or https://");
  }
  return url.href;
}

/**
 * The name that agents call an MCP server's tool by: one that codemode can write as `tools.<name>`, with the connector's
 * prefix once. Notion's `notion-search` is `notion_search`, and Slack's `slack_read` stays as it is.
 */
export function agentToolName(prefix: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "_");
  return safe.startsWith(prefix) ? safe : `${prefix}${safe}`;
}

export type {
  SlackBot,
  SlackClient,
  SlackSurfacePort,
} from "./slack-bot.ts";
