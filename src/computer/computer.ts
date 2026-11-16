import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Realm } from "../companies/companies.ts";
import type { Sources } from "../sources/sources.ts";
import {
  computerTools,
  type FileOf,
  type RealmOf,
  type SaveFile,
} from "./tools.ts";

/** agent-desktop's native binary, which `bun install` links beside its macOS helper. */
const CLI = Bun.resolveSync("agent-desktop/bin/agent-desktop", import.meta.dir);
/** The set-up macOS VM that the work computer is cloned from; it stays stopped. */
export const BASE = "shadow-base";
/** The one work computer that all agents share. */
export const MACHINE = "shadow-computer";
/** The states of a VM that runs. */
const RUNNING = new Set(["running", "needs_setup"]);
/** The work computer stops after this long without a call. */
const IDLE = 15 * 60_000;
/** How long a call waits for the VM to start and for its address. */
const START_TIMEOUT = 10 * 60_000;
/** How long one file takes to copy, at most. */
const COPY_TIMEOUT = 5 * 60_000;
/** The folder in each person's home in the guest that holds a work folder for each thread. */
const WORK = "work";
/** The program of `guest.sh` that makes a person's own user in the guest; the base user runs it with sudo. */
const PERSON = "/Library/Shadow/person";
/** The most output one command gives the agent: its start and its end. */
const MAX_OUTPUT = 20_000;
/** The guest app of `guest.sh` that copies `<user>@<address>` of the guest to its clipboard. */
const ADDRESS_APP = "Shadow Address";
const ADDRESS = /^[a-z_][\w.-]*@\d{1,3}(\.\d{1,3}){3}$/i;
/** Where agent-desktop keeps its VMs; each has a folder that its guest mounts read-only at "/Volumes/My Shared Files". */
const AGENT_DESKTOP_HOME =
  process.env.AGENT_DESKTOP_HOME ?? join(homedir(), ".agent-desktop");

/** The company's sources, whose copies the work computer gets in its shared folder. */
export type ComputerSources = Pick<Sources, "directory" | "names" | "version">;

/** Runs a program with these arguments and gives its exit status and its output; tests replace it. */
export type ComputerRunner = (
  command: readonly string[],
  timeout: number
) => Promise<{ readonly status: number; readonly output: string }>;

/** What one command on the desktop of the work computer gives: its text, or a PNG for a screenshot. */
export interface DesktopResult {
  readonly text: string;
  readonly screenshot: Uint8Array | null;
}

/**
 * The work computer of this server: one macOS VM that all agents share, cloned from `shadow-base` with agent-desktop,
 * where they run shell commands and untrusted code, convert files, and use apps. The commands of each person run as
 * their own user of the guest, without sudo, whose home no other person reads; each thread works in a folder of its
 * own there. The desktop is the base user's, which all agents share. The computer starts on its first call, keeps its
 * disk, and stops after 15 idle minutes. `docs/computer.md` has the setup.
 */
export class Computer {
  private busy = 0;
  /** `<user>@<address>` of the guest's base user, while it runs. */
  private address: Promise<string> | undefined;
  /** The users of people that the running guest has. */
  private readonly people = new Set<string>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** The stop that a new call waits for before it starts the machine again. */
  private stopping: Promise<void> | undefined;
  /** The version of the sources that the shared folder has. */
  private shared: number | undefined;

  constructor(
    private readonly directory: string,
    private readonly run: ComputerRunner = runProcess,
    private readonly sources: ComputerSources | null = null,
    private readonly home = AGENT_DESKTOP_HOME
  ) {}

  /**
   * The own user of a realm in the guest, which `person.sh` makes: `shadow-` and 12 hex digits. A turn for no person
   * has the company's.
   */
  userOf(companyId: string, realm: Realm): string {
    return `shadow-${createHash("sha256")
      .update(`${companyId}-${realm ?? ""}`)
      .digest("hex")
      .slice(0, 12)}`;
  }

  /** The agent tools of a company. */
  tools(companyId: string, realmOf: RealmOf, fileOf: FileOf, save: SaveFile) {
    return computerTools(this, companyId, realmOf, fileOf, save);
  }

  /**
   * Copies the files into a thread's work folder of `person`'s own user, runs a shell command there as that user, and
   * gives its output and exit status.
   */
  shell(
    person: string,
    folder: string,
    command: string,
    files: readonly { readonly path: string; readonly name: string }[],
    timeout: number
  ): Promise<string> {
    const work = `${WORK}/${folder}`;
    return this.use(async (address) => {
      // Newer sources reach a running machine between commands, never under one.
      if (this.busy === 1) {
        await this.shareSources();
      }
      const own = await this.person(address, person);
      await this.ssh(own, `mkdir -p ${work}`, 30_000);
      for (const file of files) {
        await this.copy(
          file.path,
          `${own}:${work}/${file.name}`,
          `Copying ${file.name} to the work computer failed`
        );
      }
      const result = await this.ssh(own, `cd ${work} && ${command}`, timeout);
      return `${clip(result.output) || "(no output)"}\n[exit status ${result.status}]`;
    });
  }

  /**
   * Copies a file that `person`'s own user reads, by its path in a thread's work folder or an absolute one, to
   * `destination` here.
   */
  download(
    person: string,
    folder: string,
    path: string,
    destination: string
  ): Promise<void> {
    return this.use(async (address) =>
      this.copy(
        `${await this.person(address, person)}:${path.startsWith("/") ? path : `${WORK}/${folder}/${path}`}`,
        destination,
        `Copying ${path} from the work computer failed`
      )
    );
  }

  /** Runs one agent-desktop command on the guest's desktop; a screenshot without a path gives its PNG. */
  desktop(command: readonly string[]): Promise<DesktopResult> {
    return this.use(async () => {
      const { output } = await this.guest(command);
      if (command[0] === "screenshot") {
        const data = parse(output)?.data as { data?: string } | undefined;
        if (data?.data) {
          return { text: "", screenshot: Uint8Array.fromBase64(data.data) };
        }
      }
      return { text: clip(output) || "(no output)", screenshot: null };
    });
  }

  /** The path of Shadow's SSH key, which `guest.sh` lets into the base; made on first use. */
  async key(): Promise<string> {
    const key = join(this.directory, "id_ed25519");
    if (!(await Bun.file(key).exists())) {
      await mkdir(this.directory, { recursive: true });
      checked(
        await this.run(
          [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "shadow",
            "-f",
            key,
          ],
          30_000
        ),
        "Making Shadow's SSH key failed"
      );
    }
    return key;
  }

  /** Runs `work` on the started machine, and stops the machine when it stays idle. */
  private async use<T>(work: (address: string) => Promise<T>): Promise<T> {
    this.busy += 1;
    clearTimeout(this.idle);
    try {
      this.address ??= (this.stopping ?? Promise.resolve()).then(() =>
        this.start()
      );
      return await work(await this.address);
    } catch (error) {
      if (
        error instanceof Unreachable ||
        !(await this.address?.catch(() => null))
      ) {
        // The next call starts the machine again and asks for its address.
        this.address = undefined;
        this.people.clear();
      }
      throw error;
    } finally {
      this.busy -= 1;
      if (this.busy === 0) {
        this.idle = setTimeout(() => {
          this.stop().catch((error: unknown) =>
            console.error("stopping the work computer failed", error)
          );
        }, IDLE);
        this.idle.unref();
      }
    }
  }

  /** `<user>@<address>` of `person`'s own user, which the base user makes once. */
  private async person(address: string, person: string): Promise<string> {
    if (!this.people.has(person)) {
      const made = await this.ssh(
        address,
        `sudo -n ${PERSON} ${person}`,
        60_000
      );
      if (made.status !== 0) {
        throw new Error(
          `The work computer has no users of people: an admin sets up its base again with docs/computer.md. ${clip(made.output)}`
        );
      }
      this.people.add(person);
    }
    return `${person}@${address.split("@")[1]}`;
  }

  /** Clones the machine from the base when it is new, starts it, and gives its `<user>@<address>`. */
  private async start(): Promise<string> {
    let state = await this.state(MACHINE);
    if (state === null) {
      const created = parse(
        (
          await this.run(
            [
              CLI,
              "sandbox",
              "create",
              MACHINE,
              "--provider",
              "macos",
              "--set",
              `from=${BASE}`,
            ],
            5 * 60_000
          )
        ).output
      );
      if (!created?.ok) {
        throw new Error(
          (await this.state(BASE)) === null
            ? "This server has no work computer: an admin sets it up with docs/computer.md."
            : `The work computer could not be made: ${errorOf(created)}`
        );
      }
      state = "stopped";
    }
    const deadline = Date.now() + START_TIMEOUT;
    if (state !== "running") {
      if (!RUNNING.has(state)) {
        await this.shareSources();
        const started = parse(
          (await this.run([CLI, "sandbox", "start", MACHINE], 5 * 60_000))
            .output
        );
        if (!started?.ok) {
          throw new Error(
            `The work computer did not start: ${errorOf(started)}`
          );
        }
      }
      while ((await this.state(MACHINE)) !== "running") {
        if (Date.now() > deadline) {
          throw new Error("The work computer started but does not answer.");
        }
        await Bun.sleep(3000);
      }
    }
    return this.guestAddress(deadline);
  }

  private async stop(): Promise<void> {
    if (this.busy) {
      return;
    }
    clearTimeout(this.idle);
    this.address = undefined;
    this.people.clear();
    const stopping = this.run(
      [CLI, "sandbox", "stop", MACHINE],
      2 * 60_000
    ).then(() => undefined);
    // A failed stop leaves the machine running; the next call uses it.
    this.stopping = stopping
      .catch(() => undefined)
      .finally(() => {
        this.stopping = undefined;
      });
    await stopping;
  }

  /**
   * The guest's `<user>@<address>`. agent-desktop runs only itself in the guest, so the `Shadow Address` app of the
   * base puts them on the guest's clipboard, after Shadow empties it.
   */
  private async guestAddress(deadline: number): Promise<string> {
    await this.guest(["clipboard-set", "-"]);
    await this.guest(["launch", ADDRESS_APP, "--no-attach"]);
    for (;;) {
      const clipboard = parse((await this.guest(["clipboard-get"])).output)
        ?.data as { text?: string } | undefined;
      const text = clipboard?.text?.trim();
      if (text && ADDRESS.test(text)) {
        return text;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The work computer gave no address; its base needs the "${ADDRESS_APP}" app of docs/computer.md.`
        );
      }
      await Bun.sleep(1000);
    }
  }

  /**
   * Puts a copy of the newest sources in the machine's shared folder, as `sources/<name>`, when it has an older one.
   * The copy is an APFS clone, so it takes no disk until a pull changes a file. A copy that fails leaves the old one.
   */
  private async shareSources(): Promise<void> {
    if (!this.sources?.names().length) {
      return;
    }
    const version = this.sources.version();
    if (this.shared === version) {
      return;
    }
    const share = join(this.home, "sandboxes", MACHINE, "vm", "share");
    const next = join(share, ".sources-next");
    try {
      await mkdir(share, { recursive: true });
      await rm(next, { recursive: true, force: true });
      checked(
        await this.run(
          ["cp", "-cR", this.sources.directory, next],
          COPY_TIMEOUT
        ),
        "Copying the sources failed"
      );
      await rm(join(share, "sources"), { recursive: true, force: true });
      await rename(next, join(share, "sources"));
      this.shared = version;
    } catch (error) {
      console.error("sharing the sources with the work computer failed", error);
    }
  }

  /** The state of a sandbox, or null when there is none of this name. */
  private async state(name: string): Promise<string | null> {
    const status = parse(
      (await this.run([CLI, "sandbox", "status", name], 60_000)).output
    );
    if (!status?.ok) {
      if (
        (status?.error as { code?: string } | undefined)?.code ===
        "SANDBOX_NOT_FOUND"
      ) {
        return null;
      }
      throw new Error(`The work computer does not answer: ${errorOf(status)}`);
    }
    return (status.data as { state: string }).state;
  }

  /** Runs agent-desktop in the guest, which waits at most 300 seconds for one command. */
  private guest(command: readonly string[]) {
    return this.run(
      [CLI, "sandbox", "exec", MACHINE, "--", ...command],
      310_000
    );
  }

  /** Runs a command in the guest's shell; SSH's own failure, status 255 without a guest status, is `Unreachable`. */
  private async ssh(address: string, command: string, timeout: number) {
    const result = await this.run(
      ["ssh", ...this.sshOptions(), address, command],
      timeout
    );
    if (result.status === 255) {
      throw new Unreachable(
        `The work computer cannot be reached: ${clip(result.output)}`
      );
    }
    return result;
  }

  private async copy(from: string, to: string, what: string): Promise<void> {
    checked(
      await this.run(
        ["scp", "-q", ...this.sshOptions(), from, to],
        COPY_TIMEOUT
      ),
      what
    );
  }

  /** Shadow's key, and the machine's host key, which Shadow learns on the first connection. */
  private sshOptions(): string[] {
    return [
      "-F",
      "/dev/null",
      "-i",
      join(this.directory, "id_ed25519"),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${join(this.directory, `${MACHINE}.known_hosts`)}`,
      "-o",
      "ConnectTimeout=10",
    ];
  }
}

/** SSH could not reach the guest, so its address is old. */
class Unreachable extends Error {}

function checked(
  result: { readonly status: number; readonly output: string },
  what: string
): void {
  if (result.status !== 0) {
    throw new Error(`${what}: ${clip(result.output)}`);
  }
}

/** The JSON envelope of agent-desktop, or null when the output is not one. */
function parse(output: string): {
  ok?: boolean;
  data?: unknown;
  error?: unknown;
} | null {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function errorOf(envelope: ReturnType<typeof parse>): string {
  const error = envelope?.error as { message?: string } | undefined;
  return error?.message ?? "agent-desktop gave no answer";
}

/** Output up to `MAX_OUTPUT` characters: its start and its end, where errors and results usually are. */
function clip(output: string): string {
  const text = output.trim();
  if (text.length <= MAX_OUTPUT) {
    return text;
  }
  const half = MAX_OUTPUT / 2;
  return `${text.slice(0, half)}\n[… ${text.length - MAX_OUTPUT} characters left out …]\n${text.slice(-half)}`;
}

/** Runs a program with its errors in the same stream, so each one stays next to the line it belongs to. */
async function runProcess(command: readonly string[], timeout: number) {
  const child = Bun.spawn(
    ["/bin/sh", "-c", 'exec "$0" "$@" 2>&1', ...command],
    { stdin: "ignore", stdout: "pipe", timeout }
  );
  const [output, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { status, output };
}
