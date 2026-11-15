/** Below this probability, a message is clearly not for Shadow, and no agent turn starts. */
export const SKIP_BELOW = 0.2;
/** How long the check may take; a slower one lets the message through. */
export const CHECK_TIMEOUT_MS = 5000;
/** The messages that the check reads, and how much of each. */
const TRANSCRIPT_MESSAGES = 10;
const MESSAGE_CHARACTERS = 500;

/** What wakes Shadow in a channel, and how it takes part there, as an admin wrote it. */
export interface ChannelGoal {
  readonly wakeWhen: string;
  readonly engagement: string;
}

/** A message of the conversation, oldest first; the last one is the new message. */
export interface CheckMessage {
  readonly author: string;
  readonly text: string;
}

/** Why the check let a message through or not, for the log; it never holds the message's text. */
export interface CheckResult {
  readonly skip: boolean;
  readonly probability: number | null;
  readonly reason: "decided" | "error" | "incomplete-context";
}

const SYSTEM = `You screen the messages of one Slack channel for Shadow, the company's assistant, which takes part in this channel. Shadow knows the company's facts, and with its tools it searches the company's channels, threads, files, and memory, and the web. Read the conversation, and say how likely it is that Shadow can be helpful with the newest message: a question or a request that Shadow can answer with what it knows or finds, or something that Shadow's goal for the channel names. A message between people that needs nothing from Shadow, or that Shadow cannot help with, is not for it.

Answer with JSON only: {"probability": <0 to 1>}`;

/**
 * Screens a message cheaply before an agent turn, as eve's ambient filter does: a small model says how likely the
 * message is for Shadow, and a message below `SKIP_BELOW` is skipped. A timeout, an error, or a conversation without
 * the new message lets the message through: the agent decides then.
 *
 * @example
 * const result = await checkMessage(ask, goal, brief, messages);
 * if (!result.skip) startTurn();
 */
export async function checkMessage(
  ask: (system: string, text: string, signal: AbortSignal) => Promise<string>,
  goal: ChannelGoal | null,
  brief: string | null,
  messages: readonly CheckMessage[]
): Promise<CheckResult> {
  if (messages.length === 0) {
    return { skip: false, probability: null, reason: "incomplete-context" };
  }
  const transcript = messages
    .slice(-TRANSCRIPT_MESSAGES)
    .map(
      (message) =>
        `${message.author}: ${message.text.replace(/\s+/g, " ").slice(0, MESSAGE_CHARACTERS)}`
    )
    .join("\n");
  const prompt = [
    goal
      ? `Shadow wakes when: ${goal.wakeWhen}\nShadow takes part by: ${goal.engagement}`
      : "Shadow follows this thread because it answered in it.",
    brief ? `What the channel is about:\n${brief.slice(0, 2000)}` : "",
    `<conversation>\n${transcript}\n</conversation>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const answer = await ask(
      SYSTEM,
      prompt,
      AbortSignal.timeout(CHECK_TIMEOUT_MS)
    );
    const probability = Number(
      (
        JSON.parse(/\{[\s\S]*\}/.exec(answer)?.[0] ?? "{}") as {
          probability?: unknown;
        }
      ).probability
    );
    if (!Number.isFinite(probability)) {
      return { skip: false, probability: null, reason: "error" };
    }
    return {
      skip: probability < SKIP_BELOW,
      probability,
      reason: "decided",
    };
  } catch {
    return { skip: false, probability: null, reason: "error" };
  }
}
