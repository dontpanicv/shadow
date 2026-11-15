import type { ChannelGoal, CheckMessage } from "../../src/slack/check.ts";

/**
 * Slack conversations for the cheap check of ambient listening (`src/slack/check.ts`): `pass` when the newest message
 * may be for Shadow, so an agent turn decides, and `skip` when it is clearly between people. A change to the check's
 * prompt, its model, or `SKIP_BELOW` runs against these; the agent turn's own choice to stay quiet is separate.
 */
export const ambientCases: {
  readonly name: string;
  readonly goal: ChannelGoal | null;
  readonly brief: string | null;
  readonly messages: readonly CheckMessage[];
  readonly expected: "pass" | "skip";
}[] = [
  {
    name: "a direct question that the goal names",
    goal: {
      wakeWhen: "questions about invoices and payments",
      engagement: "answer briefly, with the source",
    },
    brief: "Billing questions of the finance team.",
    messages: [{ author: "Anna", text: "Was invoice 4521 from Acme paid?" }],
    expected: "pass",
  },
  {
    name: "small talk in a channel with a goal",
    goal: {
      wakeWhen: "questions about invoices and payments",
      engagement: "answer briefly, with the source",
    },
    brief: "Billing questions of the finance team.",
    messages: [
      { author: "Anna", text: "Lunch at noon?" },
      { author: "Bob", text: "Sure, see you there" },
    ],
    expected: "skip",
  },
  {
    name: "a question to a named colleague, which needs nothing from Shadow",
    goal: {
      wakeWhen: "deploy problems and incidents",
      engagement: "point to the runbook and the owner",
    },
    brief: "Deploys and incidents of the platform team.",
    messages: [
      { author: "Anna", text: "@Bob can you approve my PR before 3?" },
    ],
    expected: "skip",
  },
  {
    name: "an open question that the brief can answer",
    goal: {
      wakeWhen: "deploy problems and incidents",
      engagement: "point to the runbook and the owner",
    },
    brief:
      "Deploys and incidents. The staging deploy fails when the migration lock is held; the runbook is RB-12.",
    messages: [
      {
        author: "Carl",
        text: "Staging deploy is stuck on the migration step again, anyone know why?",
      },
    ],
    expected: "pass",
  },
  {
    name: "a follow-up in a thread that Shadow answered",
    goal: null,
    brief: null,
    messages: [
      { author: "Anna", text: "Was invoice 4521 paid?" },
      { author: "Shadow", text: "Yes, on 12 November, by bank transfer." },
      { author: "Anna", text: "And the one from Globex?" },
    ],
    expected: "pass",
  },
  {
    name: "thanks in a thread that Shadow answered",
    goal: null,
    brief: null,
    messages: [
      { author: "Anna", text: "Was invoice 4521 paid?" },
      { author: "Shadow", text: "Yes, on 12 November, by bank transfer." },
      { author: "Anna", text: "Thanks!" },
    ],
    expected: "skip",
  },
];
