import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, Computer, type ComputerRunner, MACHINE } from "./computer.ts";
import { workFolder } from "./tools.ts";

/** A fake agent-desktop, ssh, and scp: sandboxes with states, and a guest clipboard. */
function fakeHost(sandboxes: Record<string, string>) {
  const calls: string[][] = [];
  let clipboard = "";
  const envelope = (data: unknown) =>
    JSON.stringify({ version: "2.6", ok: true, command: "sandbox", data });
  const run: ComputerRunner = async (command) => {
    calls.push([...command]);
    const [program, ...args] = command;
    if (program === "ssh") {
      return { status: 0, output: `ran: ${args.at(-1)}` };
    }
    if (program === "scp") {
      return { status: 0, output: "" };
    }
    const [, verb, name = ""] = args;
    if (verb === "status") {
      return sandboxes[name]
        ? { status: 0, output: envelope({ name, state: sandboxes[name] }) }
        : {
            status: 1,
            output: JSON.stringify({
              ok: false,
              error: { code: "SANDBOX_NOT_FOUND", message: "none" },
            }),
          };
    }
    if (verb === "list") {
      return {
        status: 0,
        output: envelope({
          sandboxes: Object.entries(sandboxes).map(([n, state]) => ({
            name: n,
            state,
          })),
        }),
      };
    }
    if (verb === "create") {
      if (!sandboxes[BASE]) {
        return {
          status: 1,
          output: JSON.stringify({
            ok: false,
            error: { code: "SANDBOX_NOT_FOUND", message: "no base" },
          }),
        };
      }
      sandboxes[name] = "stopped";
      return { status: 0, output: envelope({ name, state: "stopped" }) };
    }
    if (verb === "start") {
      sandboxes[name] = "running";
      return { status: 0, output: envelope({ name, state: "running" }) };
    }
    if (verb === "stop") {
      sandboxes[name] = "stopped";
      return { status: 0, output: envelope({ name, state: "stopped" }) };
    }
    // sandbox exec NAME -- COMMAND...
    const guest = args.slice(args.indexOf("--") + 1);
    if (guest[0] === "clipboard-set") {
      clipboard = guest[1] ?? "";
    } else if (guest[0] === "launch") {
      clipboard = "worker@192.168.64.7";
    } else if (guest[0] === "clipboard-get") {
      return { status: 0, output: envelope({ text: clipboard, type: "text" }) };
    } else if (guest[0] === "screenshot") {
      return { status: 0, output: envelope({ data: "iVBORw==" }) };
    }
    return { status: 0, output: envelope({ done: guest[0] }) };
  };
  return { run, calls, sandboxes };
}

describe("Computer", () => {
  test("clones the one work computer from the base, copies the files, and runs the command in the thread's folder", async () => {
    const host = fakeHost({ [BASE]: "stopped" });
    const computer = new Computer("/tmp/shadow-computer", host.run);
    const folder = workFolder("c1", 7);

    const text = await computer.shell(
      folder,
      "soffice --headless --convert-to pdf report.docx",
      [{ path: "/data/files/0192-report.docx", name: "report.docx" }],
      60_000
    );

    expect(text).toBe(
      `ran: cd work/${folder} && soffice --headless --convert-to pdf report.docx\n[exit status 0]`
    );
    expect(host.sandboxes[MACHINE]).toBe("running");
    const create = host.calls.find((call) => call.includes("create"));
    expect(create).toContain(`from=${BASE}`);
    const copy = host.calls.find((call) => call[0] === "scp");
    expect(copy?.slice(-2)).toEqual([
      "/data/files/0192-report.docx",
      `worker@192.168.64.7:work/${folder}/report.docx`,
    ]);
  });

  test("gives each thread its own work folder on the one computer", async () => {
    const host = fakeHost({ [BASE]: "stopped" });
    const computer = new Computer("/tmp/shadow-computer", host.run);
    expect(workFolder("c1", 7)).toMatch(/^[0-9a-f]{16}$/);
    expect(workFolder("c1", 8)).not.toBe(workFolder("c1", 7));

    await computer.shell(workFolder("c1", 7), "ls", [], 60_000);
    await computer.shell(workFolder("c1", 8), "ls", [], 60_000);

    expect(host.calls.filter((call) => call.includes("create")).length).toBe(1);
    expect(host.calls.filter((call) => call.includes("start")).length).toBe(1);
  });

  test("says when the server has no base computer", async () => {
    const host = fakeHost({});
    const computer = new Computer("/tmp/shadow-computer", host.run);
    await expect(
      computer.shell(workFolder("c1", 7), "ls", [], 60_000)
    ).rejects.toThrow("docs/computer.md");
  });

  test("gives a screenshot of the desktop as a picture", async () => {
    const host = fakeHost({ [BASE]: "stopped" });
    const computer = new Computer("/tmp/shadow-computer", host.run);
    const result = await computer.desktop(["screenshot", "--screen", "0"]);
    expect(result.screenshot).toEqual(Uint8Array.fromBase64("iVBORw=="));
  });

  test("gives the computer the newest sources in its shared folder, before it starts and between commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "shadow-share-"));
    try {
      const copies = join(root, "sources");
      await mkdir(join(copies, "pipes"), { recursive: true });
      await Bun.write(join(copies, "pipes", "README.md"), "v1");
      let version = 1;
      const sources = {
        directory: copies,
        names: () => ["pipes"],
        version: () => version,
      };
      const host = fakeHost({ [BASE]: "stopped" });
      // The real copy is an APFS clone; the test copies.
      const run: ComputerRunner = async (command, timeout) => {
        if (command[0] === "cp") {
          await cp(command[2]!, command[3]!, { recursive: true });
          return { status: 0, output: "" };
        }
        return host.run(command, timeout);
      };
      const computer = new Computer(join(root, "computer"), run, sources, root);
      const folder = workFolder("c1", 7);
      const shared = join(root, "sandboxes", MACHINE, "vm", "share", "sources");
      await computer.shell(folder, "ls", [], 60_000);
      expect(await Bun.file(join(shared, "pipes", "README.md")).text()).toBe(
        "v1"
      );
      await computer.shell(folder, "ls", [], 60_000);
      // The same version makes no new copy.
      expect(await readdir(join(shared, ".."))).toEqual(["sources"]);
      await Bun.write(join(copies, "pipes", "README.md"), "v2");
      version = 2;
      await computer.shell(folder, "ls", [], 60_000);
      expect(await Bun.file(join(shared, "pipes", "README.md")).text()).toBe(
        "v2"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
