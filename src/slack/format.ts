/** The longest text of one Slack `markdown` block; a longer answer goes in several messages. */
const PART_CHARACTERS = 11_000;

/** A Slack message: blocks, and the plain text that notifications and old clients show. */
export interface SlackMessage {
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

/**
 * Shadow's Markdown for Slack: links to Shadow's own threads, files, and artifacts become addresses that open in
 * Shadow, as Slack cannot open `thread:` or `file:` links.
 *
 * @example
 * slackMarkdown("See [the plan](thread:t1)", { baseUrl: "https://shadow.example.com", companyId: "c1" })
 * // "See [the plan](https://shadow.example.com/c/c1/thread/t1)"
 */
export function slackMarkdown(
  markdown: string,
  place: { readonly baseUrl: string; readonly companyId: string }
): string {
  const { baseUrl, companyId } = place;
  return markdown.replace(
    /\]\((thread|file|artifact):([^)\s]+)\)/g,
    (_, kind: string, id: string) => {
      if (kind === "thread") {
        return `](${baseUrl}/c/${companyId}/thread/${id})`;
      }
      if (kind === "artifact") {
        return `](${baseUrl}/a/${id})`;
      }
      return `](${baseUrl}/api/v1/companies/${companyId}/files/${id})`;
    }
  );
}

/** An answer in parts that each fit one Slack message, cut between paragraphs where it can. */
export function answerParts(markdown: string): string[] {
  const parts: string[] = [];
  let rest = markdown.trim() || "_I finished, but I have nothing to say._";
  while (rest.length > PART_CHARACTERS) {
    const cut = rest.lastIndexOf("\n\n", PART_CHARACTERS);
    const at = cut > PART_CHARACTERS / 2 ? cut : PART_CHARACTERS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  parts.push(rest);
  return parts;
}

/** One part of an answer as a Slack message, with `extra` blocks such as buttons after it. */
export function markdownMessage(
  markdown: string,
  extra: readonly Record<string, unknown>[] = []
): SlackMessage {
  return {
    text: plainText(markdown).slice(0, 3000),
    blocks: [{ type: "markdown", text: markdown }, ...extra],
  };
}

/** A line of small grey text under a message, such as a link to Shadow. */
export function contextBlock(markdown: string): Record<string, unknown> {
  return { type: "context", elements: [{ type: "mrkdwn", text: markdown }] };
}

/** Buttons with the values that a click sends back; `style` makes one green or red. */
export function buttons(
  items: readonly {
    readonly id: string;
    readonly text: string;
    readonly value: string;
    readonly style?: "primary" | "danger";
  }[]
): Record<string, unknown> {
  return {
    type: "actions",
    elements: items.map((item) => ({
      type: "button",
      action_id: item.id,
      text: { type: "plain_text", text: item.text },
      value: item.value,
      ...(item.style ? { style: item.style } : {}),
    })),
  };
}

/** What a tool step shows while the agent works, as in the web app: `google_mail_search` is "Google mail search". */
export function stepWords(tool: string): string {
  const words = tool.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Markdown without its marks, for the plain text of a message. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
