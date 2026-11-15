import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Agenda } from "../agenda/agenda.ts";
import type { Companies, Member } from "../companies/companies.ts";
import type { Notifications } from "../notifications/notifications.ts";
import type { SlackSurface } from "./slack.ts";

type NoticeCompanies = Pick<Companies, "agentMember" | "members" | "threadOf">;

/**
 * The tools of notices: tell one member something privately, and offer one member a routine or a reminder. An
 * unasked turn, such as one of Slack's ambient listening, uses them in place of acting: what it offers becomes the
 * person's own only when they accept, so it runs with their realm and their credentials.
 */
export function noticeTools(
  companies: NoticeCompanies,
  notifications: Pick<Notifications, "notify">,
  agenda: Pick<Agenda, "offer">,
  slack: Pick<SlackSurface, "offerInSlack">,
  companyId: string
) {
  const memberNamed = (person: string): Member => {
    const wanted = person.trim().toLowerCase();
    const member = companies
      .members(companyId, companies.agentMember(companyId))
      .find(
        (candidate) =>
          candidate.email.toLowerCase() === wanted ||
          candidate.name.toLowerCase() === wanted
      );
    if (!member) {
      throw new Error(
        `No member is ${person}; name a member exactly, or use their email.`
      );
    }
    return member;
  };
  const threadOf = (conversationId: number) => {
    const thread = companies.threadOf(companyId, conversationId);
    if (!thread) {
      throw new Error("This thread is gone.");
    }
    return thread;
  };
  return [
    defineTool({
      name: "notices_tell",
      description:
        "Tell one member of the company something privately, in their inbox and as a Slack DM, with a link to this thread. Use it when one person needs to know, and the channel does not.",
      parameters: Type.Object({
        person: Type.String({
          description: "The member's name or email, as members list it",
        }),
        text: Type.String({ maxLength: 2000 }),
      }),
      replay: "safe",
      execute: (args, api) => {
        const thread = threadOf(api.conversationId);
        const member = memberNamed(args.person);
        notifications.notify({
          id: `notice:${api.taskId}:${member.userId}`,
          companyId,
          userId: member.userId,
          channelId: thread.channelId,
          threadId: thread.id,
          title: "From Shadow",
          text: args.text,
        });
        return Promise.resolve({
          output: [{ type: "text", text: `Told ${member.name}.` }],
        });
      },
    }),
    defineTool({
      name: "notices_suggest",
      description:
        "Offer one member a routine of this thread's channel, or a reminder, when they asked for recurring work, a schedule, or a reminder in a conversation that did not ask you directly. In Slack, the person accepts it with a button; it is made as theirs, with their accounts, only when they accept. In a thread where the person asked you, use routines_create or reminders_create instead.",
      parameters: Type.Object({
        person: Type.String({
          description:
            "The member who asked for it, by name or email; they alone accept it",
        }),
        kind: Type.Union([Type.Literal("routine"), Type.Literal("reminder")]),
        name: Type.String({
          description:
            "A short name of the routine, or the text of the reminder",
        }),
        instructions: Type.Optional(
          Type.String({
            description:
              "For a routine: what its agent does with each run, and when it stays quiet",
          })
        ),
        schedule: Type.Optional(
          Type.String({
            description:
              'For a routine: a cron expression in the server\'s time zone, such as "0 9 * * 1" for Mondays at 9:00',
          })
        ),
        at: Type.Optional(
          Type.String({
            description:
              "For a reminder: when, as a local date and time with its offset, such as 2026-11-20T09:00+01:00",
          })
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const thread = threadOf(api.conversationId);
        const member = memberNamed(args.person);
        const routine = args.kind === "routine";
        if (routine && !(args.schedule && args.instructions)) {
          throw new Error("A routine needs a schedule and instructions.");
        }
        if (!(routine || args.at)) {
          throw new Error("A reminder needs a time.");
        }
        const id = agenda.offer(
          companyId,
          thread.id,
          thread.channelId,
          routine
            ? {
                kind: "routine",
                personId: member.userId,
                name: args.name,
                schedule: args.schedule!,
                instructions: args.instructions!,
                channel: null,
              }
            : {
                kind: "reminder",
                personId: member.userId,
                text: args.name,
                at: args.at!,
              }
        );
        if (!id) {
          throw new Error(
            `Not offered: ${member.name} has it, declined it, or has too many offers waiting, or the schedule or time does not work.`
          );
        }
        await slack.offerInSlack(
          companyId,
          thread.id,
          {
            id,
            kind: args.kind,
            name: args.name,
            schedule: args.schedule ?? null,
          },
          member.userId
        );
        return {
          output: [
            {
              type: "text",
              text: `Offered to ${member.name}; it starts only when they accept.`,
            },
          ],
        };
      },
    }),
  ];
}
