import { googleConnector } from "./google.ts";
import type { Connector } from "./integrations.ts";
import { recordingObservations, watchRecordings } from "./plaud.ts";
import { PASTE_ADDRESS, SIGN_IN_ADDRESS } from "./sign-in.ts";
import { slackConnector } from "./slack.ts";

/**
 * The connectors that Shadow has: the MCP servers that people sign in to (Notion, Linear, Jira, HubSpot, Pipes, Plaud,
 * and T3 Code), Google when this machine has gog, and Slack when it has slackcli. A tool that only posts a comment
 * that other people read is hidden: an MCP server's tool cannot wait for the person's approval.
 */
export function integrationCatalog(
  gog = Bun.which("gog"),
  slackcli = Bun.which("slackcli")
): readonly Connector[] {
  return [
    {
      id: "notion",
      name: "Notion",
      description:
        "The person's Notion: search and read pages and databases, and create or change pages and databases when the person asks.",
      secretLabel: null,
      guide: [
        "Click **Connect**, sign in to Notion, and select the workspace and the pages that Shadow may use.",
        PASTE_ADDRESS,
      ],
      tools: [],
      mcp: ["https://mcp.notion.com/mcp"],
      hiddenTools: ["notion-create-comment"],
    },
    {
      id: "linear",
      name: "Linear",
      description:
        "The person's Linear: find and read issues, projects, cycles, documents, and teams, and create or change issues when the person asks.",
      secretLabel: null,
      guide: ["Click **Connect**, and sign in to Linear.", PASTE_ADDRESS],
      tools: [],
      mcp: ["https://mcp.linear.app/mcp"],
      hiddenTools: ["create_comment"],
    },
    {
      id: "jira",
      name: "Jira",
      description:
        "The person's Atlassian Cloud, through Atlassian's own MCP server: search and read Jira issues and Confluence pages with JQL and CQL, and create or change issues and pages when the person asks.",
      secretLabel: null,
      guide: [
        "Click **Connect**, sign in to Atlassian, and select the site.",
        PASTE_ADDRESS,
        "When the sign-in refuses Shadow, an Atlassian admin allows the Rovo MCP server for the site in **Atlassian Administration › Apps › AI settings**.",
      ],
      tools: [],
      mcp: ["https://mcp.atlassian.com/v1/mcp"],
      hiddenTools: [
        "addCommentToJiraIssue",
        "createConfluenceFooterComment",
        "createConfluenceInlineComment",
      ],
    },
    {
      id: "hubspot",
      name: "HubSpot",
      description:
        "The person's HubSpot CRM: search and read contacts, companies, deals, tickets, and their activity, with what the person may see.",
      secretLabel: null,
      guide: [
        "In HubSpot, open **Development › MCP Auth Apps**, and create an app.",
        `Add the redirect URL \`${SIGN_IN_ADDRESS}\`, and copy the client ID and the client secret.`,
        "Click **Client** here, and paste them. An admin of Shadow does this once.",
        "Click **Connect**, and sign in to HubSpot.",
        PASTE_ADDRESS,
      ],
      tools: [],
      mcp: ["https://mcp.hubspot.com/"],
      // HubSpot's MCP server registers no clients; an admin sets the MCP auth app's client.
      registered: true,
    },
    {
      id: "pipes",
      name: "Pipes",
      description:
        "The person's Meiro Pipes and Engage instance: read its configuration, profiles, events, dashboard metrics, profile reports, journey and delivery performance, and the product guide. A change is only a proposal, which the person approves in Pipes.",
      secretLabel: null,
      address: true,
      guide: [
        "Enter the address of your Pipes instance, such as `https://acme.pipes.meiro.io`.",
        "Click **Continue**, sign in to Pipes, and select **Allow**.",
        PASTE_ADDRESS,
        "Settings › API tokens in Pipes lists Shadow under connected apps, where you disconnect it.",
      ],
      tools: [],
      mcp: ["/mcp"],
    },
    {
      id: "plaud",
      name: "Plaud",
      description:
        "The person's Plaud recordings: find them, and read their transcripts with speakers and times, summaries, and action items.",
      secretLabel: null,
      guide: ["Click **Connect**, and sign in to Plaud.", PASTE_ADDRESS],
      tools: [],
      mcp: ["https://mcp.plaud.ai/mcp"],
      // Shadow keeps the sign-in; an agent must not revoke it.
      hiddenTools: ["login", "logout"],
      watch: watchRecordings,
      observations: recordingObservations,
    },
    {
      id: "t3",
      name: "T3 Code",
      description:
        "The person's T3 Code, which runs coding agents on their own machine: find a project, start a thread there with a task, such as one from a message, and read, answer, or stop its threads. Threads run with at most the access that the person gave Shadow when they connected it.",
      secretLabel: null,
      address: true,
      guide: [
        "Enter the address of your T3 Code server, such as `http://my-mac:3774`. Shadow and your browser must both reach it.",
        "Click **Continue**, then **Sign in to T3 Code**. Choose the access of Shadow's threads, and approve with your T3 Code session or with a pairing code from `t3 pair`.",
        PASTE_ADDRESS,
        "The sign-in lasts 30 days; then connect T3 Code again.",
      ],
      tools: [],
      mcp: ["/mcp"],
      // The other tools serve only an agent inside a T3 Code thread, such as its previews and pull requests.
      shownTools: [
        "orchestrator_capabilities",
        "t3_project_list",
        "t3_project_read",
        "t3_worktree_list",
        "t3_thread_launch",
        "t3_thread_list",
        "t3_thread_search",
        "t3_thread_read",
        "t3_thread_wait",
        "t3_thread_send",
        "t3_thread_interrupt",
        "t3_thread_organize",
        "t3_pending_request",
        "list_thread_pull_requests",
      ],
    },
    ...(gog ? [googleConnector(gog)] : []),
    ...(slackcli ? [slackConnector(slackcli)] : []),
  ];
}
