import { expect, test } from "bun:test";
import { integrationCatalog } from "./catalog.ts";
import { agentToolName } from "./integrations.ts";

test("the catalog has the work integrations, and Google and Slack only with their programs", () => {
  const without = integrationCatalog(null, null);
  expect(without.map((connector) => connector.id)).toEqual([
    "notion",
    "linear",
    "jira",
    "hubspot",
    "pipes",
    "plaud",
    "t3",
  ]);
  expect(
    integrationCatalog("/bin/gog", "/bin/slackcli").map(
      (connector) => connector.id
    )
  ).toEqual(expect.arrayContaining(["google", "slack"]));
  const byId = Object.fromEntries(
    without.map((connector) => [connector.id, connector])
  );
  // Each Pipes instance has its own MCP server; HubSpot's needs a client that an admin sets.
  expect(byId.pipes).toMatchObject({ address: true, mcp: ["/mcp"] });
  expect(byId.hubspot).toMatchObject({ registered: true });
  // A tool that only posts a comment for other people cannot wait for an approval, so agents never get it.
  expect(byId.linear!.hiddenTools).toContain("create_comment");
  expect(byId.notion!.hiddenTools).toContain("notion-create-comment");
});

test("an MCP tool's name is one that codemode can write, with the connector's prefix once", () => {
  expect(agentToolName("notion_", "notion-search")).toBe("notion_search");
  expect(agentToolName("slack_", "slack_read")).toBe("slack_read");
  expect(agentToolName("jira_", "getJiraIssue")).toBe("jira_getJiraIssue");
  expect(agentToolName("pipes_", "profiles.search")).toBe(
    "pipes_profiles_search"
  );
});
