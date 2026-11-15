import { expect, test } from "bun:test";
import { integrationCatalog } from "./catalog.ts";
import { agentToolName } from "./integrations.ts";

test("the catalog has the work integrations and all six Google MCP servers", () => {
  const without = integrationCatalog(null);
  expect(without.map((connector) => connector.id)).toEqual([
    "notion",
    "linear",
    "jira",
    "hubspot",
    "pipes",
    "plaud",
    "t3",
    "google",
    "google_drive",
    "google_docs",
    "google_sheets",
    "google_slides",
    "google_calendar",
  ]);
  expect(
    integrationCatalog("/bin/slackcli").map((connector) => connector.id)
  ).toEqual(expect.arrayContaining(["google", "slack"]));
  const byId = Object.fromEntries(
    without.map((connector) => [connector.id, connector])
  );
  // Each Pipes instance has its own MCP server; HubSpot's needs a client that an admin sets.
  expect(byId.pipes).toMatchObject({ address: true, mcp: ["/mcp"] });
  expect(byId.hubspot).toMatchObject({ registered: true });
  // A tool that posts a comment for other people waits for the person's approval of each call.
  expect(byId.linear!.approvedTools).toContain("create_comment");
  expect(byId.notion!.approvedTools).toContain("notion-create-comment");
  expect(byId.jira!.approvedTools).toContain("addCommentToJiraIssue");
  expect(byId.hubspot!.approvedTools).toContain("manage_social_posts");
  for (const id of [
    "google",
    "google_drive",
    "google_docs",
    "google_sheets",
    "google_slides",
    "google_calendar",
  ]) {
    expect(byId[id]!.mcp).toHaveLength(1);
    expect(byId[id]!.clientKey).toBe("google");
  }
  expect(byId.google_calendar!.approvedTools).toContain("respond_to_event");
  expect(byId.google_calendar!.scope).toMatch(/auth\/calendar\.events$/);
  expect(byId.google!.watch).toBeDefined();
});

test("an MCP tool's name is one that codemode can write, with the connector's prefix once", () => {
  expect(agentToolName("notion_", "notion-search")).toBe("notion_search");
  expect(agentToolName("slack_", "slack_read")).toBe("slack_read");
  expect(agentToolName("jira_", "getJiraIssue")).toBe("jira_getJiraIssue");
  expect(agentToolName("pipes_", "profiles.search")).toBe(
    "pipes_profiles_search"
  );
});
