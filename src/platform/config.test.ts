import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emailAllowed } from "./auth.ts";
import { readConfig } from "./config.ts";

test("config/ and data/ are for Shadow's user only, also when an older version made them", async () => {
  const root = await mkdtemp(join(tmpdir(), "shadow-config-"));
  const env = {
    SHADOW_CONFIG: join(root, "config"),
    SHADOW_DATA: join(root, "data"),
  };
  try {
    await mkdir(env.SHADOW_DATA, { mode: 0o755 });
    await chmod(env.SHADOW_DATA, 0o755);
    await readConfig(env).catch(() => undefined);
    expect((await stat(env.SHADOW_CONFIG)).mode % 0o1000).toBe(0o700);
    expect((await stat(env.SHADOW_DATA)).mode % 0o1000).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first start creates config/shadow.toml and data/; later starts read it", async () => {
  const root = await mkdtemp(join(tmpdir(), "shadow-config-"));
  const env = {
    SHADOW_CONFIG: join(root, "config"),
    SHADOW_DATA: join(root, "data"),
  };
  try {
    // Nobody can sign in until the Google client is set.
    await expect(readConfig(env)).rejects.toThrow(
      "google.client_id must be a text value"
    );
    expect(existsSync(join(root, "data"))).toBe(true);
    const template = await Bun.file(join(root, "config", "shadow.toml")).text();
    await Bun.write(
      join(root, "config", "shadow.toml"),
      template
        .replace('client_id = ""', 'client_id = "id"')
        .replace('client_secret = ""', 'client_secret = "secret"')
    );
    expect(await readConfig(env)).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      baseUrl: "http://localhost:3000",
      shareUrl: null,
      allowedEmails: [],
      google: { clientId: "id", clientSecret: "secret" },
    });
    const google = '[google]\nclient_id = "id"\nclient_secret = "secret"\n';
    await Bun.write(
      join(root, "config", "shadow.toml"),
      `base_url = "http://shadow.home"\nport = 8080\nhost = "0.0.0.0"\nshare_url = "https://a.shadow.home/"\nallowed_emails = ["Anna@Example.com"]\n${google}`
    );
    expect(await readConfig(env)).toMatchObject({
      host: "0.0.0.0",
      shareUrl: "https://a.shadow.home",
      port: 8080,
      baseUrl: "http://shadow.home",
      allowedEmails: ["anna@example.com"],
    });
    await Bun.write(join(root, "config", "shadow.toml"), 'port = "eighty"\n');
    await expect(readConfig(env)).rejects.toThrow(
      "port must be a whole number"
    );
    await Bun.write(
      join(root, "config", "shadow.toml"),
      `allowed_emails = "anna@example.com"\n${google}`
    );
    await expect(readConfig(env)).rejects.toThrow(
      "allowed_emails must be a list of text values"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allowed_emails lets in an email or every email of an @domain, and its first entry is an email", async () => {
  const root = await mkdtemp(join(tmpdir(), "shadow-config-"));
  const env = {
    SHADOW_CONFIG: join(root, "config"),
    SHADOW_DATA: join(root, "data"),
  };
  const google = '[google]\nclient_id = "id"\nclient_secret = "secret"\n';
  try {
    await mkdir(env.SHADOW_CONFIG, { recursive: true });
    await Bun.write(
      join(env.SHADOW_CONFIG, "shadow.toml"),
      `allowed_emails = ["@example.com"]\n${google}`
    );
    await expect(readConfig(env)).rejects.toThrow("must be an email");
    await Bun.write(
      join(env.SHADOW_CONFIG, "shadow.toml"),
      `allowed_emails = ["anna@other.org", " @Example.com "]\n${google}`
    );
    const { allowedEmails } = await readConfig(env);
    expect(emailAllowed(allowedEmails, "Anna@other.org")).toBe(true);
    expect(emailAllowed(allowedEmails, "bob@EXAMPLE.com")).toBe(true);
    expect(emailAllowed(allowedEmails, "bob@notexample.com")).toBe(false);
    expect(emailAllowed(allowedEmails, "bob@example.com.evil.org")).toBe(false);
    expect(emailAllowed(allowedEmails, "carl@other.org")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[[sources]] lists the git repositories that agents read, and [git] has the token for private ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "shadow-config-"));
  const env = {
    SHADOW_CONFIG: join(root, "config"),
    SHADOW_DATA: join(root, "data"),
  };
  const google = '[google]\nclient_id = "id"\nclient_secret = "secret"\n';
  const write = (text: string) =>
    Bun.write(join(env.SHADOW_CONFIG, "shadow.toml"), `${text}\n${google}`);
  try {
    await mkdir(env.SHADOW_CONFIG, { recursive: true });
    await write("");
    expect(await readConfig(env)).toMatchObject({
      repositories: [],
      sources: [],
      gitToken: null,
    });
    await write(
      '[[sources]]\nname = "pipes"\nurl = "https://github.com/acme/pipes.git"\nskills = ["skill"]\n\n[[sources]]\nname = "v1"\nurl = "https://github.com/acme/v1.git"\nbranch = "release"\n\n[git]\ntoken = "ghp_x"'
    );
    expect(await readConfig(env)).toMatchObject({
      sources: [
        {
          name: "pipes",
          url: "https://github.com/acme/pipes.git",
          branch: null,
          skills: ["skill"],
        },
        { name: "v1", branch: "release", skills: [] },
      ],
      gitToken: "ghp_x",
    });
    await write('[[sources]]\nname = "Pipes"\nurl = "x"');
    await expect(readConfig(env)).rejects.toThrow("the source name Pipes");
    await write('[[sources]]\nname = "pipes"\nurl = "x"\nskills = ["../etc"]');
    await expect(readConfig(env)).rejects.toThrow("must be folders");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
