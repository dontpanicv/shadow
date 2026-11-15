import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sources } from "./sources.ts";

const root = await mkdtemp(join(tmpdir(), "shadow-sources-"));
const origin = join(root, "origin");

afterAll(() => rm(root, { recursive: true, force: true }));

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: origin,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Anna",
      GIT_AUTHOR_EMAIL: "anna@example.com",
      GIT_COMMITTER_NAME: "Anna",
      GIT_COMMITTER_EMAIL: "anna@example.com",
    },
  });
  if ((await child.exited) !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
  return new Response(child.stdout).text();
}

test("a source is cloned, follows its branch, and agents search, read, and see its history and skills", async () => {
  await mkdir(join(origin, "skill", "guide"), { recursive: true });
  await git("init", "--quiet", "--initial-branch=main");
  await Bun.write(
    join(origin, "skill", "SKILL.md"),
    "---\nname: acme-product\ndescription: >\n  Use when working with Acme.\n---\n\n# Acme\n"
  );
  await Bun.write(
    join(origin, "skill", "guide", "SKILL.md"),
    "---\nname: acme-guide\ndescription: The product guide.\n---\n"
  );
  await Bun.write(
    join(origin, "src.ts"),
    "export const refund = 30;\nexport const Refund_days = 14;\n"
  );
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Add refunds");

  const sources = new Sources(
    join(root, "data", "sources"),
    [{ name: "acme", url: origin, branch: null, skills: ["skill"] }],
    "secret-token"
  );
  await sources.pull();
  expect(sources.version()).toBe(1);
  expect(sources.skills()).toEqual([
    {
      source: "acme",
      name: "acme-product",
      description: "Use when working with Acme.",
      path: "skill/SKILL.md",
    },
    {
      source: "acme",
      name: "acme-guide",
      description: "The product guide.",
      path: "skill/guide/SKILL.md",
    },
  ]);
  expect(await sources.search("refund", {})).toBe(
    "acme/src.ts:1:export const refund = 30;\nacme/src.ts:2:export const Refund_days = 14;"
  );
  expect(
    await sources.search("refund", { caseSensitive: true, path: "*.ts" })
  ).toBe("acme/src.ts:1:export const refund = 30;");
  expect(await sources.search("nothing here", {})).toBe("No line matches.");
  expect(await sources.read("acme", "src.ts", 2)).toBe(
    "acme/src.ts, lines 2–3 of 3\n2\texport const Refund_days = 14;\n3\t\n"
  );
  expect(await sources.read("acme", ".")).toBe("skill/\nsrc.ts");

  // A file outside the copy, or git's own, never reads.
  await symlink("/etc/hosts", join(root, "data", "sources", "acme", "hosts"));
  await expect(sources.read("acme", "hosts")).rejects.toThrow("acme has no");
  await expect(sources.read("acme", "../../origin/src.ts")).rejects.toThrow(
    "acme has no"
  );
  await expect(sources.read("acme", ".git/config")).rejects.toThrow(
    "acme has no"
  );
  await expect(sources.read("other", "src.ts")).rejects.toThrow(
    "There is no source other"
  );
  // The token is not written to the copy.
  expect(
    await Bun.file(
      join(root, "data", "sources", "acme", ".git", "config")
    ).text()
  ).not.toContain("secret-token");

  // A new commit on the branch reaches the copy at the next pull; a pull without one changes nothing.
  await Bun.write(join(origin, "src.ts"), "export const refund = 60;\n");
  await git("commit", "--quiet", "-am", "Longer refunds");
  await sources.pull();
  expect(sources.version()).toBe(2);
  expect(await sources.search("refund = 60", {})).toBe(
    "acme/src.ts:1:export const refund = 60;"
  );
  await sources.pull();
  expect(sources.version()).toBe(2);
  const log = await sources.history("acme", { path: "src.ts" });
  expect(log).toMatch(/^[0-9a-f]+ \d{4}-\d\d-\d\d Anna: Longer refunds\n/);
  expect(log).toContain("Anna: Add refunds");
  const hash = log.split(" ")[0]!;
  expect(await sources.history("acme", { commit: hash })).toContain(
    "+export const refund = 60;"
  );
  await expect(
    sources.history("acme", { commit: "--output=/tmp/x" })
  ).rejects.toThrow("A commit is its hash");
  expect(sources.tools().map((tool) => tool.name)).toEqual([
    "sources_search",
    "sources_read",
    "sources_history",
  ]);
});
