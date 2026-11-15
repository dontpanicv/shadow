import { googleConnector } from "./google.ts";
import type { Connector } from "./integrations.ts";
import { recordingObservations, watchRecordings } from "./plaud.ts";
import { PASTE_ADDRESS } from "./sign-in.ts";
import { slackConnector } from "./slack.ts";

/**
 * The connectors that Shadow has: Plaud and T3 Code, MCP servers that people sign in to, Google when this machine has
 * gog, and Slack when it has slackcli.
 */
export function integrationCatalog(
  gog = Bun.which("gog"),
  slackcli = Bun.which("slackcli")
): readonly Connector[] {
  return [
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
