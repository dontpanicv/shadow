import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Glob } from "bun";
import type { SourceConfig } from "../platform/config.ts";
import { sourceTools } from "./tools.ts";

/** A skill of a source: what its `SKILL.md` says it is for. */
export interface Skill {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  /** The path of its `SKILL.md` in the source. */
  readonly path: string;
}

/** Runs git with these arguments in a folder and gives its exit status and output; tests can replace it. */
export type GitRunner = (
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string
) => Promise<{ readonly status: number; readonly output: string }>;

/** A release can come several times a day, so the copies follow within minutes. */
const PULL_EVERY = 10 * 60_000;
const MAX_MATCHES = 200;
const MAX_LINE = 300;
const MAX_CHARACTERS = 100_000;
const MAX_COMMITS = 100;

/**
 * The company's sources: git repositories, such as its code and product docs, that Shadow keeps a copy of in
 * `data/sources/<name>` and pulls every 10 minutes. Agents search and read them with the `sources_` tools, and the work
 * computers get them in their shared folder. A token in `[git]` reads private repositories; it is given to git only for
 * each call and never written to the copies.
 *
 * @example
 * const sources = new Sources("data/sources", [{ name: "docs", url: "https://github.com/acme/docs.git", branch: null, skills: [] }], null);
 * sources.start();
 * await sources.search("refund", {});
 */
export class Sources {
  private changes = 0;
  private skillList: Skill[] = [];
  private pulling: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly directory: string,
    private readonly sources: readonly SourceConfig[],
    private readonly token: string | null,
    private readonly git: GitRunner = runGit
  ) {}

  /** The agent tools, which read every source. */
  tools() {
    return this.sources.length ? sourceTools(this) : [];
  }

  names(): string[] {
    return this.sources.map((source) => source.name);
  }

  /** Grows each time a pull changes a copy, so a copy of the copies, such as a work computer's, knows it is old. */
  version(): number {
    return this.changes;
  }

  /** The skills of the sources, as the newest pull found them, by source and path. */
  skills(): readonly Skill[] {
    return this.skillList;
  }

  /** Pulls every source now, then every 10 minutes. */
  start(): void {
    if (!this.sources.length || this.timer) {
      return;
    }
    const pull = () =>
      this.pull().catch((error: unknown) =>
        console.error("pulling the sources failed", error)
      );
    pull();
    this.timer = setInterval(pull, PULL_EVERY);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Clones a new source, or brings its copy to the newest commit of its branch; one pull at a time. */
  pull(): Promise<void> {
    this.pulling ??= this.pullAll().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  private async pullAll(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let changed = false;
    // Together, so a large repository never holds back the small ones.
    await Promise.all(
      this.sources.map(async (source) => {
        try {
          changed = (await this.pullOne(source)) || changed;
        } catch (error) {
          console.error(`pulling the source ${source.name} failed`, error);
        }
      })
    );
    if (changed) {
      this.changes += 1;
    }
    this.skillList = (
      await Promise.all(this.sources.map((source) => this.skillsOf(source)))
    ).flat();
  }

  private async pullOne(source: SourceConfig): Promise<boolean> {
    const copy = join(this.directory, source.name);
    const env = this.envFor(source);
    if (!(await exists(join(copy, ".git")))) {
      // A clone that stops halfway never looks like a copy.
      const partial = join(`${this.directory}.partial`, source.name);
      await rm(partial, { recursive: true, force: true });
      await mkdir(dirname(partial), { recursive: true });
      await this.checked(
        [
          "clone",
          "--quiet",
          "--single-branch",
          // Only the newest files come now; older versions come when sources_history shows them.
          "--filter=blob:none",
          ...(source.branch ? ["--branch", source.branch] : []),
          source.url,
          partial,
        ],
        env
      );
      await rm(copy, { recursive: true, force: true });
      await rename(partial, copy);
      return true;
    }
    const before = await this.checked(["rev-parse", "HEAD"], env, copy);
    const branch =
      source.branch ??
      (await this.checked(["symbolic-ref", "--short", "HEAD"], env, copy));
    await this.checked(["remote", "set-url", "origin", source.url], env, copy);
    await this.checked(["fetch", "--quiet", "origin", branch], env, copy);
    await this.checked(
      ["checkout", "--quiet", "--force", "-B", branch, "FETCH_HEAD"],
      env,
      copy
    );
    await this.checked(["clean", "--quiet", "-ffdx"], env, copy);
    return (await this.checked(["rev-parse", "HEAD"], env, copy)) !== before;
  }

  /** The token as an HTTP header for the source's own address only, so git never sends it elsewhere. */
  private envFor(source: SourceConfig): Record<string, string> {
    return this.token && source.url.startsWith("https://")
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${source.url}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${this.token}`)}`,
        }
      : {};
  }

  private async skillsOf(source: SourceConfig): Promise<Skill[]> {
    const copy = join(this.directory, source.name);
    const skills: Skill[] = [];
    for (const folder of source.skills) {
      const glob = new Glob("**/SKILL.md");
      const root = join(copy, folder);
      if (!(await exists(root))) {
        continue;
      }
      for await (const file of glob.scan(root)) {
        const path = join(folder, file);
        const about = frontmatter(await Bun.file(join(copy, path)).text());
        if (about.name && about.description) {
          skills.push({
            source: source.name,
            name: about.name,
            description: about.description,
            path,
          });
        }
      }
    }
    return skills.toSorted((left, right) => (left.path < right.path ? -1 : 1));
  }

  /** The lines of the sources that hold the text, as `<source>/<path>:<line>: <text>`. */
  async search(
    text: string,
    options: {
      readonly source?: string;
      readonly path?: string;
      readonly regex?: boolean;
      readonly caseSensitive?: boolean;
    }
  ): Promise<string> {
    const lines: string[] = [];
    for (const source of this.pick(options.source)) {
      const copy = join(this.directory, source.name);
      if (!(await exists(copy))) {
        continue;
      }
      const result = await this.git(
        [
          "grep",
          "-n",
          "-I",
          "--no-color",
          options.regex ? "-E" : "-F",
          ...(options.caseSensitive ? [] : ["-i"]),
          "-e",
          text,
          ...(options.path ? ["--", `:(glob)${options.path}`] : []),
        ],
        {},
        copy
      );
      // git grep ends with 1 when nothing matches.
      if (result.status > 1) {
        throw new Error(result.output.trim() || "The search failed");
      }
      for (const line of result.output.split("\n")) {
        if (line) {
          lines.push(`${source.name}/${line.slice(0, MAX_LINE)}`);
        }
      }
    }
    if (lines.length === 0) {
      return "No line matches.";
    }
    const more = lines.length - MAX_MATCHES;
    return [
      ...lines.slice(0, MAX_MATCHES),
      ...(more > 0
        ? [`… ${more} more matching lines; narrow the search with path.`]
        : []),
    ].join("\n");
  }

  /** A file of a source with its line numbers, or the entries of a folder. */
  async read(
    sourceName: string,
    path: string,
    from = 1,
    to = Number.POSITIVE_INFINITY
  ): Promise<string> {
    const [source] = this.pick(sourceName);
    const copy = await realpath(join(this.directory, source!.name));
    const target = await realpath(resolve(copy, path)).catch(() => null);
    if (
      !target ||
      (target !== copy && !target.startsWith(copy + sep)) ||
      relative(copy, target).split(sep)[0] === ".git"
    ) {
      throw new Error(`${sourceName} has no ${path}`);
    }
    if ((await stat(target)).isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .filter((entry) => entry.name !== ".git")
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .toSorted()
        .join("\n");
    }
    const all = (await Bun.file(target).text()).split("\n");
    const first = Math.max(1, Math.floor(from));
    const last = Math.min(all.length, Math.floor(to));
    let text = "";
    let line = first;
    for (; line <= last; line += 1) {
      const next = `${line}\t${all[line - 1]}\n`;
      if (text.length + next.length > MAX_CHARACTERS) {
        break;
      }
      text += next;
    }
    const shown = line - 1;
    return `${source!.name}/${relative(copy, target)}, lines ${first}–${shown} of ${all.length}${shown < all.length ? `; read on with from ${shown + 1}` : ""}\n${text}`;
  }

  /** The commits of a source, newest first, or one commit with its changes. */
  async history(
    sourceName: string,
    options: {
      readonly path?: string;
      readonly grep?: string;
      readonly since?: string;
      readonly commit?: string;
      readonly limit?: number;
    }
  ): Promise<string> {
    const [source] = this.pick(sourceName);
    const copy = join(this.directory, source!.name);
    const paths = options.path ? ["--", options.path] : [];
    if (options.commit) {
      if (!/^[0-9a-f]{4,40}$/i.test(options.commit)) {
        throw new Error("A commit is its hash");
      }
      const shown = await this.checked(
        [
          "show",
          "--no-color",
          "--stat",
          "--patch",
          "--format=%H %ad %an <%ae>%n%n%B",
          "--date=iso",
          options.commit,
          ...paths,
        ],
        this.envFor(source!),
        copy
      );
      return shown.length > MAX_CHARACTERS
        ? `${shown.slice(0, MAX_CHARACTERS)}\n… cut; give path for one file's changes.`
        : shown;
    }
    const limit = Math.min(Math.max(1, options.limit ?? 30), MAX_COMMITS);
    const log = await this.checked(
      [
        "log",
        "--no-color",
        "--date=short",
        "--format=%h %ad %an: %s",
        `-n${limit}`,
        ...(options.since ? [`--since=${options.since}`] : []),
        ...(options.grep ? ["-i", `--grep=${options.grep}`] : []),
        ...paths,
      ],
      {},
      copy
    );
    return log || "No commit matches.";
  }

  /** The configured sources that a name means: one of them, or all of them without a name. */
  private pick(name: string | undefined): SourceConfig[] {
    if (!name) {
      return [...this.sources];
    }
    const source = this.sources.find((candidate) => candidate.name === name);
    if (!source) {
      throw new Error(
        `There is no source ${name}; the sources are ${this.names().join(", ")}.`
      );
    }
    return [source];
  }

  private async checked(
    args: readonly string[],
    env: Record<string, string>,
    cwd?: string
  ): Promise<string> {
    const result = await this.git(args, env, cwd);
    if (result.status !== 0) {
      throw new Error(
        `git ${args[0]} failed: ${result.output.trim().slice(0, 1000)}`
      );
    }
    return result.output.trim();
  }
}

/** The `name` and `description` of a SKILL.md's frontmatter. */
function frontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  try {
    const data = match
      ? (Bun.YAML.parse(match[1]!) as Record<string, unknown>)
      : {};
    return {
      ...(typeof data.name === "string" ? { name: data.name.trim() } : {}),
      ...(typeof data.description === "string"
        ? { description: data.description.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

async function runGit(
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string
): Promise<{ status: number; output: string }> {
  const child = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, output: status === 0 ? stdout : stdout + stderr };
}
