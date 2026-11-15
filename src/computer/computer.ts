import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Sources } from "../sources/sources.ts";
import { computerTools, type FileOf, type SaveFile } from "./tools.ts";

/** agent-desktop's native binary, which `bun install` links beside its macOS helper. */
const CLI = Bun.resolveSync("agent-desktop/bin/agent-desktop", import.meta.dir);
/** The set-up macOS VM that every work computer is cloned from; it stays stopped. */
export const BASE = "shadow-base";
/** macOS runs two macOS VMs at once. */
const MAX_RUNNING = 2;
/** The states of a VM that runs. */
const RUNNING = new Set(["running", "needs_setup"]);
/** A work computer stops after this long without a call, so another person can start theirs. */
const IDLE = 15 * 60_000;
/** How long a call waits for a free VM, for a VM to start, and for its address. */
const START_TIMEOUT = 10 * 60_000;
/** How long one file takes to copy, at most. */
const COPY_TIMEOUT = 5 * 60_000;
/** The folder in the guest's home where commands run and files arrive. */
const WORK = "work";
/** The most output one command gives the agent: its start and its end. */
const MAX_OUTPUT = 20_000;
/** The guest app of `guest.sh` that copies `<user>@<address>` of the guest to its clipboard. */
const ADDRESS_APP = "Shadow Address";
const ADDRESS = /^[a-z_][\w.-]*@\d{1,3}(\.\d{1,3}){3}$/i;
/** Where agent-desktop keeps its VMs; each has a folder that its guest mounts read-only at "/Volumes/My Shared Files". */
const AGENT_DESKTOP_HOME =
  process.env.AGENT_DESKTOP_HOME ?? join(homedir(), ".agent-desktop");

/** The company's sources, whose copies a work computer gets in its shared folder. */
export type ComputerSources = Pick<Sources, "directory" | "names" | "version">;

/** Runs a program with these arguments and gives its exit status and its output; tests replace it. */
export type ComputerRunner = (
  command: readonly string[],
  timeout: number
) => Promise<{ readonly status: number; readonly output: string }>;

/** What one command on the desktop of a work computer gives: its text, or a PNG for a screenshot. */
export interface DesktopResult {
  readonly text: string;
  readonly screenshot: Uint8Array | null;
}

interface Machine {
  busy: number;
  lastUsed: number;
  /** `<user>@<address>` of the guest, while it runs. */
  address: Promise<string> | undefined;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** The stop that a new call waits for before it starts the machine again. */
  stopping: Promise<void> | undefined;
}

/**
 * A macOS work computer for each person, a VM on this server cloned from `shadow-base` with agent-desktop, where
 * agents run shell commands, convert files, and use apps. A computer starts on its first call, keeps its disk, and
 * stops after 15 idle minutes. Only two run at once, so a call waits for one to stop. `docs/computer.md` has the
 * setup.
 */
export class Computer {
  private readonly machines = new Map<string, Machine>();
  /** One start at a time, so two starts never both count a free VM. */
  private starting: Promise<unknown> = Promise.resolve();
  /** The version of the sources that each machine's shared folder has. */
  private readonly shared = new Map<string, number>();

  constructor(
    private readonly directory: string,
    private readonly run: ComputerRunner = runProcess,
    private readonly sources: ComputerSources | null = null,
    private readonly home = AGENT_DESKTOP_HOME
  ) {}

  /** The agent tools of a company; `requesterOf` gives the person of a turn, whose computer it uses. */
  tools(
    companyId: string,
    requesterOf: (conversationId: ConversationId) => Promise<string | null>,
    fileOf: FileOf,
    save: SaveFile
  ) {
    return computerTools(this, companyId, requesterOf, fileOf, save);
  }

  /** Copies the files into the work folder, runs a shell command there, and gives its output and exit status. */
  shell(
    name: string,
    command: string,
    files: readonly { readonly path: string; readonly name: string }[],
    timeout: number
  ): Promise<string> {
    return this.use(name, async (address) => {
      // Newer sources reach a running machine between commands, never under one.
      if (this.machines.get(name)?.busy === 1) {
        await this.shareSources(name);
      }
      await this.ssh(name, address, `mkdir -p ${WORK}`, 30_000);
      for (const file of files) {
        await this.copy(
          name,
          file.path,
          `${address}:${WORK}/${file.name}`,
          `Copying ${file.name} to the work computer failed`
        );
      }
      const result = await this.ssh(
        name,
        address,
        `cd ${WORK} && ${command}`,
        timeout
      );
      return `${clip(result.output) || "(no output)"}\n[exit status ${result.status}]`;
    });
  }

  /** Copies a file of the guest, by its path in the work folder or an absolute one, to `destination` here. */
  download(name: string, path: string, destination: string): Promise<void> {
    return this.use(name, (address) =>
      this.copy(
        name,
        `${address}:${path.startsWith("/") ? path : `${WORK}/${path}`}`,
        destination,
        `Copying ${path} from the work computer failed`
      )
    );
  }

  /** Runs one agent-desktop command on the guest's desktop; a screenshot without a path gives its PNG. */
  desktop(name: string, command: readonly string[]): Promise<DesktopResult> {
    return this.use(name, async () => {
      const { output } = await this.guest(name, command);
      if (command[0] === "screenshot") {
        const data = parse(output)?.data as { data?: string } | undefined;
        if (data?.data) {
          return { text: "", screenshot: Uint8Array.fromBase64(data.data) };
        }
      }
      return { text: clip(output) || "(no output)", screenshot: null };
    });
  }

  /** The work computer of a person, or of the company for work without a person; a sandbox name is 32 at most. */
  machineOf(companyId: string, personId: string | null): string {
    const key = `${companyId}-${personId ?? "shadow"}`;
    return `shadow-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
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

  /** Runs `work` on a started machine, and stops the machine when it stays idle. */
  private async use<T>(
    name: string,
    work: (address: string) => Promise<T>
  ): Promise<T> {
    let machine = this.machines.get(name);
    if (!machine) {
      machine = {
        busy: 0,
        lastUsed: 0,
        address: undefined,
        idle: undefined,
        stopping: undefined,
      };
      this.machines.set(name, machine);
    }
    machine.busy += 1;
    clearTimeout(machine.idle);
    try {
      machine.address ??= (machine.stopping ?? Promise.resolve()).then(() =>
        this.start(name)
      );
      return await work(await machine.address);
    } catch (error) {
      if (
        error instanceof Unreachable ||
        !(await machine.address?.catch(() => null))
      ) {
        // The next call starts the machine again and asks for its address.
        machine.address = undefined;
      }
      throw error;
    } finally {
      machine.busy -= 1;
      machine.lastUsed = Date.now();
      if (machine.busy === 0) {
        machine.idle = setTimeout(() => {
          this.stop(name).catch((error: unknown) =>
            console.error(`stopping work computer ${name} failed`, error)
          );
        }, IDLE);
        machine.idle.unref();
      }
    }
  }

  /** Clones the machine from the base when it is new, starts it, and gives its `<user>@<address>`. */
  private async start(name: string): Promise<string> {
    let state = await this.state(name);
    if (state === null) {
      const created = parse(
        (
          await this.run(
            [
              CLI,
              "sandbox",
              "create",
              name,
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
        await this.shareSources(name);
        const start = this.starting.then(async () => {
          await this.makeRoom(name, deadline);
          return parse(
            (await this.run([CLI, "sandbox", "start", name], 5 * 60_000)).output
          );
        });
        this.starting = start.catch(() => undefined);
        const started = await start;
        if (!started?.ok) {
          throw new Error(
            `The work computer did not start: ${errorOf(started)}`
          );
        }
      }
      while ((await this.state(name)) !== "running") {
        if (Date.now() > deadline) {
          throw new Error("The work computer started but does not answer.");
        }
        await Bun.sleep(3000);
      }
    }
    return this.address(name, deadline);
  }

  /** Waits until fewer than two VMs run, and stops the idle work computer that was used longest ago. */
  private async makeRoom(name: string, deadline: number): Promise<void> {
    for (;;) {
      const running = (await this.list()).filter(
        (sandbox) => sandbox.name !== name && RUNNING.has(sandbox.state)
      );
      if (running.length < MAX_RUNNING) {
        return;
      }
      const idle = running
        .filter((sandbox) => sandbox.name !== BASE)
        .filter((sandbox) => !this.machines.get(sandbox.name)?.busy)
        .sort(
          (a, b) =>
            (this.machines.get(a.name)?.lastUsed ?? 0) -
            (this.machines.get(b.name)?.lastUsed ?? 0)
        );
      if (idle[0]) {
        await this.stop(idle[0].name);
      } else if (Date.now() > deadline) {
        throw new Error(
          "Both work computers of this server are busy; try again in a few minutes."
        );
      } else {
        await Bun.sleep(5000);
      }
    }
  }

  private async stop(name: string): Promise<void> {
    const machine = this.machines.get(name);
    if (machine?.busy) {
      return;
    }
    const stopping = this.run([CLI, "sandbox", "stop", name], 2 * 60_000).then(
      () => undefined
    );
    if (machine) {
      clearTimeout(machine.idle);
      machine.address = undefined;
      // A failed stop leaves the machine running; the next call uses it.
      machine.stopping = stopping
        .catch(() => undefined)
        .finally(() => {
          machine.stopping = undefined;
        });
    }
    await stopping;
  }

  /**
   * The guest's `<user>@<address>`. agent-desktop runs only itself in the guest, so the `Shadow Address` app of the
   * base puts them on the guest's clipboard, after Shadow empties it.
   */
  private async address(name: string, deadline: number): Promise<string> {
    await this.guest(name, ["clipboard-set", "-"]);
    await this.guest(name, ["launch", ADDRESS_APP, "--no-attach"]);
    for (;;) {
      const clipboard = parse(
        (await this.guest(name, ["clipboard-get"])).output
      )?.data as { text?: string } | undefined;
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
  private async shareSources(name: string): Promise<void> {
    if (!this.sources?.names().length) {
      return;
    }
    const version = this.sources.version();
    if (this.shared.get(name) === version) {
      return;
    }
    const share = join(this.home, "sandboxes", name, "vm", "share");
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
      this.shared.set(name, version);
    } catch (error) {
      console.error(`sharing the sources with ${name} failed`, error);
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

  private async list(): Promise<{ name: string; state: string }[]> {
    const list = parse(
      (await this.run([CLI, "sandbox", "list"], 60_000)).output
    );
    return (
      (list?.data as { sandboxes?: { name: string; state: string }[] })
        ?.sandboxes ?? []
    );
  }

  /** Runs agent-desktop in the guest, which waits at most 300 seconds for one command. */
  private guest(name: string, command: readonly string[]) {
    return this.run([CLI, "sandbox", "exec", name, "--", ...command], 310_000);
  }

  /** Runs a command in the guest's shell; SSH's own failure, status 255 without a guest status, is `Unreachable`. */
  private async ssh(
    name: string,
    address: string,
    command: string,
    timeout: number
  ) {
    const result = await this.run(
      ["ssh", ...this.sshOptions(name), address, command],
      timeout
    );
    if (result.status === 255) {
      throw new Unreachable(
        `The work computer cannot be reached: ${clip(result.output)}`
      );
    }
    return result;
  }

  private async copy(
    name: string,
    from: string,
    to: string,
    what: string
  ): Promise<void> {
    checked(
      await this.run(
        ["scp", "-q", ...this.sshOptions(name), from, to],
        COPY_TIMEOUT
      ),
      what
    );
  }

  /** Shadow's key; each machine keeps its own host key, which Shadow learns on the first connection. */
  private sshOptions(name: string): string[] {
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
      `UserKnownHostsFile=${join(this.directory, `${name}.known_hosts`)}`,
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
