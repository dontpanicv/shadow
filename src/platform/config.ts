import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Shadow keeps everything in two folders:
 * - `config/`: what Shadow needs to start: `shadow.toml` and `secret.key`. Keep a copy somewhere safe, apart from
 *   the data backup, because `secret.key` decrypts the credentials stored in `data/`.
 * - `data/`: everything Shadow stores: databases, markdown, files, indexes, models, and logs. Back this up offsite.
 */
export interface Config {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  /** The network address Shadow listens on; `127.0.0.1` lets only a proxy on the same machine reach it. */
  readonly host: string;
  readonly port: number;
  /** The address people open; better-auth uses it for links and origin checks. */
  readonly baseUrl: string;
  /** The public address of public artifacts, such as https://a.example.com, when the rest of Shadow is private. */
  readonly shareUrl: string | null;
  /** The only people who may sign in: emails, and `@domain` for every email of a domain. The first is an email. */
  readonly allowedEmails: readonly string[];
  /** The Google OAuth client for sign-in; see google-sign-in.md. */
  readonly google: OAuthClient;
  /** The git repositories that agents read, such as the company's code and product docs. */
  readonly sources: readonly SourceConfig[];
  /** Reads private sources over https, such as a GitHub token; `null` for public ones. */
  readonly gitToken: string | null;
}

/** A git repository that agents read, from `[[sources]]`. */
export interface SourceConfig {
  /** Its folder in `data/sources/`, and how agents name it. */
  readonly name: string;
  readonly url: string;
  /** `null` for the repository's default branch. */
  readonly branch: string | null;
  /** Folders of the repository whose `SKILL.md` files agents get as skills. */
  readonly skills: readonly string[];
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

const TEMPLATE = `# Shadow configuration. Shadow created this file on first start; edit it and restart Shadow.

# The address people open, for example https://shadow.example.com. Google sign-in needs https, or localhost.
base_url = "http://localhost:3000"
port = 3000

# The network address Shadow listens on. 127.0.0.1 lets only this machine reach it, for example through a proxy;
# 0.0.0.0 opens it to every network the machine is on.
host = "127.0.0.1"

# The public address of public artifact links, for example https://a.example.com, when the rest of Shadow is private.
# That address answers only artifact links; docs/artifacts-sharing.md shows how to set it up.
# share_url = "https://a.example.com"

# The Google accounts that may sign in, for example ["anna@example.com", "@example.com"]; "@example.com" lets in every
# email of that domain. Nobody else can. The first is an email: the server's owner, who alone connects the LLM
# provider and chooses its model.
allowed_emails = []

# The Google OAuth client for sign-in. google-sign-in.md shows how to create it.
[google]
client_id = ""
client_secret = ""

# Git repositories that agents search and read, such as the company's code and product docs. Shadow keeps a copy of
# each in data/sources/ and pulls it every 10 minutes; the work computers have them in "/Volumes/My Shared Files/sources".
# skills lists folders whose SKILL.md files agents get as skills. Repeat the block for each repository.
# [[sources]]
# name = "docs"
# url = "https://github.com/example/docs.git"
# branch = "main"
# skills = ["skill"]

# A token that reads private sources over https, such as a GitHub fine-grained token with read access to the contents
# of the repositories. Git gets it only for each pull of a source's own address.
# [git]
# token = ""
`;

/** Reads `config/shadow.toml`, creating `config/` and `data/` with defaults on first start. */
export async function readConfig(
  env: Record<string, string | undefined> = process.env
): Promise<Config> {
  const configDirectory = resolve(env.SHADOW_CONFIG ?? "config");
  const dataDirectory = resolve(env.SHADOW_DATA ?? "data");
  for (const directory of [configDirectory, dataDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Only Shadow's user reads the secrets and the company's data, also on an install that an older version made.
    chmodSync(directory, 0o700);
  }
  const file = Bun.file(join(configDirectory, "shadow.toml"));
  if (!(await file.exists())) {
    await Bun.write(file, TEMPLATE);
  }
  const values = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  const google = (values.google ?? {}) as Record<string, unknown>;
  const git = (values.git ?? {}) as Record<string, unknown>;
  return {
    configDirectory,
    dataDirectory,
    host: text(values.host ?? "127.0.0.1", "host"),
    port: integer(values.port ?? 3000, "port"),
    baseUrl: text(values.base_url ?? "http://localhost:3000", "base_url"),
    shareUrl:
      values.share_url === undefined
        ? null
        : new URL(text(values.share_url, "share_url")).origin,
    allowedEmails: allowedEmails(values.allowed_emails ?? []),
    google: {
      clientId: text(google.client_id, "google.client_id"),
      clientSecret: text(google.client_secret, "google.client_secret"),
    },
    sources: sources(values.sources ?? []),
    gitToken: git.token ? text(git.token, "git.token") : null,
  };
}

function sources(value: unknown): SourceConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("config/shadow.toml: sources must be [[sources]] blocks");
  }
  const names = new Set<string>();
  return value.map((entry: Record<string, unknown>) => {
    const name = text(entry.name, "sources.name");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || names.has(name)) {
      throw new Error(
        `config/shadow.toml: the source name ${name} must be unique, with lowercase letters, digits, dots, dashes, and underscores`
      );
    }
    names.add(name);
    const skills = list(entry.skills ?? [], "sources.skills");
    if (
      skills.some(
        (folder) => folder.startsWith("/") || folder.split("/").includes("..")
      )
    ) {
      throw new Error(
        `config/shadow.toml: the skills of ${name} must be folders in the source`
      );
    }
    return {
      name,
      url: text(entry.url, "sources.url"),
      branch:
        entry.branch === undefined
          ? null
          : text(entry.branch, "sources.branch"),
      skills,
    };
  });
}

function allowedEmails(value: unknown): string[] {
  const entries = list(value, "allowed_emails").map((email) =>
    email.trim().toLowerCase()
  );
  if (entries[0]?.startsWith("@")) {
    throw new Error(
      "config/shadow.toml: the first of allowed_emails is the first admin, so it must be an email, not a domain"
    );
  }
  return entries;
}

function integer(value: unknown, key: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`config/shadow.toml: ${key} must be a whole number`);
  }
  return value as number;
}

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`config/shadow.toml: ${key} must be a text value`);
  }
  return value;
}

function list(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`config/shadow.toml: ${key} must be a list of text values`);
  }
  return value;
}
