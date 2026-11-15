import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { randomUUIDv5 } from "bun";
import type { Companies } from "../companies/companies.ts";
import { localTime } from "../platform/time.ts";
import type { Threads } from "../threads/threads.ts";
import type { Reminder, Reminders } from "./reminders.ts";

/** Agent tools for the one-time reminders of a company. */
export function reminderTools(
  reminders: Reminders,
  companies: Pick<Companies, "agentMember" | "members" | "threadOf">,
  threads: Pick<Threads, "realm" | "requester">,
  companyId: string
) {
  const at = Type.String({
    description:
      "The local date and time with its UTC offset, such as 2026-11-01T09:00+01:00",
  });
  const timeZone = Type.String({
    description: "IANA time zone of the recipient, such as Europe/Prague",
  });
  const text = Type.String({ description: "What to remind the person about" });
  const reminder = Type.String({ description: "The reminder id" });
  const recipient = Type.Optional(
    Type.String({ description: "Name of a member of this company" })
  );
  const actorFor = async (
    conversationId: Parameters<Threads["requester"]>[1]
  ) => {
    const asker = await threads.requester(companyId, conversationId);
    return {
      asker,
      actor: asker ?? companies.agentMember(companyId),
      realm: await threads.realm(companyId, conversationId),
    };
  };
  /** The member named `recipient`, else the person who asks. */
  const recipientOf = (
    actor: Awaited<ReturnType<typeof actorFor>>["actor"],
    askerId: string | null,
    name: string | undefined
  ): string => {
    const members = companies.members(companyId, actor);
    const matches = name
      ? members.filter(
          (member) => member.name.toLowerCase() === name.toLowerCase()
        )
      : members.filter((member) => member.userId === askerId);
    if (matches.length !== 1) {
      throw new Error(
        "Name exactly one member of this company as the recipient."
      );
    }
    return matches[0]!.userId;
  };
  return [
    defineTool({
      name: "reminders_create",
      description:
        "Schedule one reminder for one exact future date and time. Make one reminder for one request, with no helper reminders or threads. Use a routine for repeated work. Give the recipient's name when it is not the person who asked. Confirm the saved time in your answer.",
      parameters: Type.Object({ text, at, timeZone, recipient }),
      replay: "safe",
      execute: async (args, api) => {
        const { actor, asker } = await actorFor(api.conversationId);
        if (!asker) {
          throw new Error("Only a person's own request makes a reminder.");
        }
        const source = companies.threadOf(companyId, api.conversationId);
        if (!source) {
          throw new Error("This tool works only in a thread.");
        }
        const recipientId = recipientOf(actor, asker.id, args.recipient);
        const created = reminders.create(
          companyId,
          actor,
          source.id,
          recipientId,
          {
            text: args.text,
            timeZone: args.timeZone,
            at: args.at,
            createdBy: asker.id,
            id: randomUUIDv5(`shadow:${companyId}:${api.taskId}`, "url"),
          }
        );
        return { output: [{ type: "text", text: describe(created) }] };
      },
    }),
    defineTool({
      name: "reminders_list",
      description:
        "List the one-time reminders of this company, including delivered and cancelled ones.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const { actor, realm } = await actorFor(api.conversationId);
        const result = reminders.list(companyId, actor, realm);
        return {
          output: [
            {
              type: "text",
              text: result.map(describe).join("\n\n") || "No reminders.",
            },
          ],
        };
      },
    }),
    defineTool({
      name: "reminders_update",
      description: "Change a pending one-time reminder: its text and its time.",
      parameters: Type.Object({ reminder, text, at, timeZone }),
      replay: "safe",
      execute: async ({ reminder: id, ...input }, api) => {
        const { actor, asker, realm } = await actorFor(api.conversationId);
        return {
          output: [
            {
              type: "text",
              text: describe(
                reminders.update(companyId, actor, realm, id, {
                  text: input.text,
                  timeZone: input.timeZone,
                  at: input.at,
                  createdBy: asker?.id ?? null,
                })
              ),
            },
          ],
        };
      },
    }),
    defineTool({
      name: "reminders_cancel",
      description: "Cancel a one-time reminder before it is delivered.",
      parameters: Type.Object({ reminder }),
      replay: "safe",
      execute: async ({ reminder: id }, api) => {
        const { actor, realm } = await actorFor(api.conversationId);
        return {
          output: [
            {
              type: "text",
              text: describe(reminders.cancel(companyId, actor, realm, id)),
            },
          ],
        };
      },
    }),
  ];
}

function describe(reminder: Reminder): string {
  let status = "scheduled";
  if (reminder.cancelledAt) {
    status = "cancelled";
  } else if (reminder.deliveredAt) {
    status = "delivered";
  } else if (reminder.lastError) {
    status = `retrying: ${reminder.lastError}`;
  }
  return [
    `${reminder.text} (reminder ${reminder.id})`,
    `Due: ${localTime(reminder.dueAt, reminder.timeZone)} (${reminder.timeZone})`,
    `Recipient: ${reminder.recipientId}`,
    `Thread: ${reminder.threadId}`,
    `Status: ${status}`,
  ].join("\n");
}
