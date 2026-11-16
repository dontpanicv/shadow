// Puts Shadow's SSH key and the guest scripts into the shared folder of the shadow-base VM, which the guest mounts at
// "/Volumes/My Shared Files". Run it after `sandbox create shadow-base` finishes; docs/computer.md has the setup.
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE, Computer } from "../src/computer/computer.ts";
import { readConfig } from "../src/platform/config.ts";

const config = await readConfig();
const key = await new Computer(join(config.dataDirectory, "computer")).key();
const share = join(
  process.env.AGENT_DESKTOP_HOME ?? join(homedir(), ".agent-desktop"),
  "sandboxes",
  BASE,
  "vm",
  "share"
);
await copyFile(`${key}.pub`, join(share, "shadow.pub"));
for (const [script, name] of [
  ["guest.sh", "shadow-guest.sh"],
  ["person.sh", "shadow-person.sh"],
]) {
  await copyFile(
    join(import.meta.dir, "../src/computer", script!),
    join(share, name!)
  );
}
console.log(
  `In the guest's Terminal, run: sh "/Volumes/My Shared Files/shadow-guest.sh"`
);
